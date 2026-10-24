/**
 * 会话绑定的持久化别名表（`cs_` → `sess_`）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 *
 * 历史上一个对话有两个 id：DB 的 `cs_…`（chat_sessions，UI 全以它为键）和内存
 * 的 `sess_…`（MemoryStore 的上下文单位）。二者的对应关系曾放在 `agent.ts` 的
 * **进程内** `Map` 里：重启即失 → 只能从 DB 瘦重建（`chat_messages` 只存
 * user/assistant，tool calls 全丢，现场观测过 57 条 → 3 条）。
 *
 * 单写之后，新会话的 memory 主键**就是** `cs_`，不需要绑定。这张表只服务**存量
 * 旧会话**：那个对话的富上下文活在一个旧 `sess_*.json` 里，需要跨重启记住它。
 *
 * ── 边界 ───────────────────────────────────────────────────────────────────
 *
 * * 它**不是**第二个权威：唯一的权威是 `cs_`，这里只是一张「旧文件在哪」的别名。
 * * 目标文件不存在 → 视为无绑定，调用方回退到重建（不抛错、不假装成功）。
 * * 文件损坏 / 形状不对 → 降级为空绑定。一个坏 JSON 不能卡住 Agent 启动。
 * * 每次读写都回落磁盘（`read → modify → rename`），因为同一 Agent 可能有多个
 *   worker 共享这个目录；纯内存缓存会互相覆盖。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface BindingFileShape {
  version: number;
  bindings: Record<string, string>;
}

const VERSION = 1;

export class SessionBindingStore {
  constructor(private readonly filePath: string) {}

  /** 解析 `cs_…` → 旧的内存会话 id。无绑定 / 文件坏了都返回 undefined。 */
  resolve(dbSessionId: string): string | undefined {
    return this.read().bindings[dbSessionId];
  }

  /** 反向解析：内存会话 id → `cs_…`（供「我现在在哪个 DB 会话里」这类问题）。 */
  resolveReverse(memorySessionId: string): string | undefined {
    for (const [dbId, memId] of Object.entries(this.read().bindings)) {
      if (memId === memorySessionId) return dbId;
    }
    return undefined;
  }

  bind(dbSessionId: string, memorySessionId: string): void {
    if (!dbSessionId || !memorySessionId) return;
    const current = this.read();
    current.bindings[dbSessionId] = memorySessionId;
    this.write(current);
  }

  unbind(dbSessionId: string): void {
    const current = this.read();
    if (!(dbSessionId in current.bindings)) return;
    delete current.bindings[dbSessionId];
    this.write(current);
  }

  entries(): Array<[dbSessionId: string, memorySessionId: string]> {
    return Object.entries(this.read().bindings);
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────

  private read(): BindingFileShape {
    if (!existsSync(this.filePath)) return { version: VERSION, bindings: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as Partial<BindingFileShape>;
      const bindings = parsed?.bindings;
      if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) {
        return { version: VERSION, bindings: {} };
      }
      // 只接受 string→string 的条目；坏值静默丢弃，避免污染解析结果。
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(bindings)) {
        if (typeof k === 'string' && typeof v === 'string' && k && v) clean[k] = v;
      }
      return { version: VERSION, bindings: clean };
    } catch {
      // 损坏文件：降级为空绑定。不删它（保留现场），下次写会被整体替换。
      return { version: VERSION, bindings: {} };
    }
  }

  private write(next: BindingFileShape): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(next, null, 2));
      renameSync(tmp, this.filePath); // 原子替换：读到的永远是完整文件
    } catch {
      // 绑定是「优化」而非正确性前提：写失败只是下次回退到重建，绝不让它抛穿。
    }
  }
}
