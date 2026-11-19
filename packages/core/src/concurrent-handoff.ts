/**
 * ConcurrentHandoffLog — 并发交接记录（P2a）
 *
 * 老板「结束时应该知道其他 session 是否在处理相关的事、理解其他已完成 session 的过程」
 * 的核心落地物：一个轻量、有序、可持久化的日志。每个并发 worker 在关键节点写入一行：
 *
 *   kind = 'declared'  worker 开始处理 item 时声明意图（防重复动作）
 *   kind = 'fact'     worker 记录影响全局的事实（「已将 X 状态改为 Y」）
 *   kind = 'done'     worker 完成时总结成果与遗留
 *   kind = 'conflict' worker 发现自己与已完成/进行中的工作冲突时记录
 *
 * 存储：进程内环形缓冲（保留最近 N 条）+ append-only JSONL 持久化（agent dataDir 下），
 * 重启后仍可追溯。写入用 O_APPEND 单次写，天然原子，多 worker 并发写不交错。
 *
 * ## 本日志是**历史**，不是状态（2026-11-17 事故后确立）
 *
 * 一条 `declared` 说的是「过去某一刻我开始做过」，它**不会**因为时间流逝而失效，也
 * 不会因为环形缓冲挤出而变成「没发生过」。所以任何「现在谁在干活」的问题都**不能**
 * 用本日志回答 —— 旧实现正是这么干的（`recent().filter(declared)` 当作「正在进行中」），
 * 结果同一个实体在同一段并发上下文里既「在进行中」又「已完成」，分身据此宣布
 * 「由另一个 worker 处理」并停手。
 *
 * 权威在途信号只有一个：`AttentionController.getActiveClaims()`（已拿锁 + 正在跑回合
 * 的 worker 实时快照）。本日志只回答「过去发生过什么」。
 *
 * 消费方：
 *   - context-engine buildSystemPrompt 的「交接历史」段（只含终态 `done`/`conflict`）
 *   - attention concurrentWorkerLoop 的交接钩子（declared/done/conflict）
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

/** 交接记录类型。`declared` = 开始做过；`done` = 结束；`conflict` = 撞锁让位。 */
export type ConcurrentHandoffKind = 'declared' | 'done' | 'conflict';

/** 单条交接记录。 */
export interface ConcurrentHandoff {
  /** 记录 id（时间戳 + 序号）。 */
  id: string;
  /** 写这条记录的分身编号。 */
  workerId: number;
  /** ISO 时间戳。 */
  ts: string;
  /** 关联实体键（task:/requirement:/conv:/user:/a2a:…）。 */
  entityKey?: string;
  /** 记录类型。 */
  kind: ConcurrentHandoffKind;
  /** 一句话摘要：我要做什么 / 我发现的事实 / 我做完了 / 我检测到冲突。 */
  summary: string;
}

/** 注入上下文用的轻量子集（不含 id/ts，避免 prompt 携带元数据噪音）。 */
export interface ConcurrentHandoffLite {
  workerId: number;
  kind: ConcurrentHandoffKind;
  entityKey?: string;
  summary: string;
}

/** 默认保留的最大记录数（进程内环形缓冲 + 注入上下文的上限）。 */
export const HANDOFF_MAX_KEEP = 64;
/** 默认注入上下文的最大条数（受上下文预算约束）。 */
export const HANDOFF_CONTEXT_LIMIT = 8;

/**
 * 磁盘文件触发**压实（compaction）**的行数阈值。
 *
 * 旧实现纯 append、从不轮转 → `concurrent-handoffs.jsonl` 随运行时间**无界增长**
 * （每个 mailbox item 至少 2 行：declared + done）。越线时把内存环形缓冲的最后
 * `maxKeep` 条整体重写回文件，于是文件大小上有界、且内容与内存视图一致。
 */
export const HANDOFF_COMPACT_THRESHOLD = 512;

/**
 * 进程内单调计数器：与时间戳组合保证 id 唯一。
 *
 * 只靠 `Date.now()` 不够 —— 同一毫秒内创建的两个实例会用同一时间戳；
 * 只用实例级计数器也不够 —— 两个实例都从 1 开始。二者相乘（时间戳 + 全局
 * 单调 seq + 实例 token）才能既跨实例又跨毫秒唯一。
 */
let globalSeq = 0;

export class ConcurrentHandoffLog {
  private items: ConcurrentHandoff[] = [];
  private readonly filePath?: string;
  private readonly maxKeep: number;
  /** 实例 token：区分同一毫秒内创建的多个实例。 */
  private readonly token = Math.random().toString(36).slice(2, 8);
  /** 自上次压实以来追加的行数。 */
  private appendedLines = 0;

  constructor(filePath?: string, maxKeep: number = HANDOFF_MAX_KEEP) {
    this.filePath = filePath;
    this.maxKeep = Math.max(8, maxKeep);
  }

  /** 生成进程内唯一的记录 id。 */
  private nextId(): string {
    globalSeq += 1;
    return `${Date.now()}-${this.token}-${globalSeq}`;
  }

  /** 从磁盘加载既有记录（幂等；调用一次即可）。 */
  load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const lines = raw.split('\n');
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try {
          const rec = JSON.parse(t) as ConcurrentHandoff;
          if (rec && typeof rec.id === 'string' && typeof rec.summary === 'string') {
            this.items.push(rec);
          }
        } catch { /* 跳过损坏行 */ }
      }
      this.appendedLines = lines.length;
      // 只保留最近 maxKeep 条
      if (this.items.length > this.maxKeep) {
        this.items = this.items.slice(this.items.length - this.maxKeep);
      }
    } catch { /* 磁盘读取失败不阻塞 */ }
  }

  /** 追加一条记录（内存 + 尽力持久化）。 */
  append(
    kind: ConcurrentHandoffKind,
    workerId: number,
    entityKey: string | undefined,
    summary: string,
  ): ConcurrentHandoff {
    const rec: ConcurrentHandoff = {
      id: this.nextId(),
      workerId,
      ts: new Date().toISOString(),
      entityKey,
      kind,
      summary,
    };
    this.items.push(rec);
    if (this.items.length > this.maxKeep) this.items.shift();
    if (this.filePath) {
      try {
        appendFileSync(this.filePath, JSON.stringify(rec) + '\n', 'utf-8');
        this.appendedLines += 1;
        if (this.appendedLines >= HANDOFF_COMPACT_THRESHOLD) this.compactFile();
      } catch { /* 持久化失败不阻塞处理 */ }
    }
    return rec;
  }

  /** 把内存中的最近记录整体重写回磁盘（有界化文件增长）。 */
  private compactFile(): void {
    if (!this.filePath) return;
    try {
      const body = this.items.map(r => JSON.stringify(r)).join('\n');
      writeFileSync(this.filePath, body ? body + '\n' : '', 'utf-8');
      this.appendedLines = this.items.length;
    } catch { /* 压实失败下次再试 */ }
  }

  /** 最近 N 条（按时间升序返回；默认全部可用范围）。 */
  recent(n: number = HANDOFF_CONTEXT_LIMIT): ConcurrentHandoff[] {
    if (n <= 0) return [];
    return this.items.slice(-Math.min(n, this.items.length));
  }

  /** 清空（测试用 + 手动重置）—— 内存与**磁盘**同时清空。 */
  clear(): void {
    this.items = [];
    if (this.filePath) {
      // 旧实现是 `appendFileSync(path, '')`：只写 0 字节，**不截断文件**，
      // 于是重启后 load() 会把「已清空」的记录全部读回来。
      try { writeFileSync(this.filePath, '', 'utf-8'); } catch { /* ignore */ }
    }
    this.appendedLines = 0;
  }

  /** 当前记录数。 */
  get size(): number {
    return this.items.length;
  }

  /** 磁盘已写入行数（观测/测试用）。 */
  get diskLineCount(): number {
    return this.appendedLines;
  }
}

/**
 * 磁盘已写入行数（观测/测试用）。
 */
export interface HandoffDiskStats {
  lines: number;
}
