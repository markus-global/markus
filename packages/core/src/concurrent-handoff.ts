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
 * 消费方：
 *   - context-engine buildSystemPrompt 的「并发上下文」段（每轮注入最近 N 条）
 *   - attention concurrentWorkerLoop 的交接钩子（declared/done/conflict）
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';

/** 交接记录类型。 */
export type ConcurrentHandoffKind = 'declared' | 'fact' | 'done' | 'conflict';

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

let seq = 0;

/** 生成单调递增的记录 id。 */
function nextId(): string {
  seq += 1;
  return `${Date.now()}-${seq}`;
}

export class ConcurrentHandoffLog {
  private items: ConcurrentHandoff[] = [];
  private readonly filePath?: string;
  private readonly maxKeep: number;

  constructor(filePath?: string, maxKeep: number = HANDOFF_MAX_KEEP) {
    this.filePath = filePath;
    this.maxKeep = Math.max(8, maxKeep);
  }

  /** 从磁盘加载既有记录（幂等；调用一次即可）。 */
  load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const rec = JSON.parse(t) as ConcurrentHandoff;
          if (rec && typeof rec.id === 'string' && typeof rec.summary === 'string') {
            this.items.push(rec);
          }
        } catch { /* 跳过损坏行 */ }
      }
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
      id: nextId(),
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
      } catch { /* 持久化失败不阻塞处理 */ }
    }
    return rec;
  }

  /** 最近 N 条（按时间升序返回；默认全部可用范围）。 */
  recent(n: number = HANDOFF_CONTEXT_LIMIT): ConcurrentHandoff[] {
    if (n <= 0) return [];
    return this.items.slice(-Math.min(n, this.items.length));
  }

  /** 某实体的全部记录（用于实体亲和冲突检测）。 */
  byEntity(entityKey: string | undefined): ConcurrentHandoff[] {
    if (!entityKey) return [];
    return this.items.filter(r => r.entityKey === entityKey);
  }

  /** 当前进行中（declared 后未 done）的记录，按 workerId 去重取最新。 */
  inFlight(): ConcurrentHandoff[] {
    const byWorker = new Map<number, ConcurrentHandoff>();
    for (const r of this.items) {
      if (r.kind === 'declared' || r.kind === 'fact') {
        byWorker.set(r.workerId, r);
      }
      if (r.kind === 'done' || r.kind === 'conflict') {
        byWorker.delete(r.workerId);
      }
    }
    return [...byWorker.values()];
  }

  /** 清空（测试用 + 手动重置）。 */
  clear(): void {
    this.items = [];
    if (this.filePath) {
      try { appendFileSync(this.filePath, '', 'utf-8'); } catch { /* ignore */ }
    }
  }

  /** 当前记录数。 */
  get size(): number {
    return this.items.length;
  }
}

/** 把交接记录格式化为上下文注入文本（供 buildSystemPrompt 使用）。 */
export function formatHandoffsForContext(handoffs: ConcurrentHandoff[]): string {
  if (handoffs.length === 0) return '';
  const lines = handoffs.map(h => {
    const who = `worker ${h.workerId}`;
    const kindLabel =
      h.kind === 'declared' ? '开始'
      : h.kind === 'fact' ? '发现'
      : h.kind === 'done' ? '完成'
      : '冲突';
    const ent = h.entityKey ? `（${h.entityKey}）` : '';
    return `- ${who} ${kindLabel}${ent}：${h.summary}`;
  });
  return lines.join('\n');
}