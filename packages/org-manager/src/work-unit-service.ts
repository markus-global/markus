/**
 * WorkUnitService —— WorkUnit 的**唯一业务写者**（第七刀 C7-A）。
 *
 * 三层分工，一层一个职责，不许越界：
 *
 *   · `@markus/shared/work-unit`  —— 概念：状态集合 / 迁移矩阵 / `ref` 命名（纯函数）。
 *   · `SqliteWorkUnitRepo`        —— 存储：唯一一处 SQL 写 `work_units`。
 *   · `WorkUnitService`（本文件） —— 业务：**唯一调用** repo 写方法的地方；
 *                                   决定「写失败要不要打断业务」。
 *
 * 为什么「写失败不阻断业务」必须写在 service 这一层：
 * C6 的教训是「加了列却 0 行」——静默漏记。反向的错误同样致命：让一条记录失败
 * 把一次真实对话/任务/投递打断，就是把观测设施变成了业务故障点。所以这里的纪律是
 * **吞掉异常，但必须留下结构化事件**（`onEvent`），让「没记上」本身可被计数和告警，
 * 而不是靠人在日志里搜字符串。
 *
 * 矩阵错误是唯一例外：非法迁移是程序错误（不是可恢复的业务分支），必须抛出。
 * 静默把 `archived → running` 变成「什么都没发生」，状态机就等于不存在。
 */

import {
  WORK_UNIT_REF,
  WORK_UNIT_STATUSES,
  canTransitionWorkUnit,
  type WorkUnitRecord,
  type WorkUnitStatus,
} from '@markus/shared';

/** repo 的最小端口 —— 便于测试注入内存实现，不必起库。 */
export interface WorkUnitPort {
  ensure(seed: WorkUnitSeedLike): { row: WorkUnitRecord; created: boolean };
  transition(ref: string, to: WorkUnitStatus, opts?: WorkUnitTransitionOptionsLike): WorkUnitRecord;
  getByRef(ref: string): WorkUnitRecord | undefined;
  /** C7-B：迭代记账（`used` 唯一口径）。 */
  addUsage(ref: string, used: number): void;
  /** C7-B：回合开始时未知的 `context_ref` 后补（只填空值，绝不覆盖）。 */
  adoptContextRef(ref: string, contextRef: string): boolean;
  listByAgent(
    agentId: string,
    opts?: { statuses?: WorkUnitStatus[]; includeArchived?: boolean; limit?: number },
  ): WorkUnitRecord[];
  listChildren(parentId: string): WorkUnitRecord[];
  linkMailboxItem(itemId: string, ref: string): boolean;
}

export interface WorkUnitSeedLike {
  ref: string;
  agentId: string;
  status?: WorkUnitStatus;
  parentId?: string | null;
  /**
   * C7-B：父 WU 的 **ref**（调用方只知道「这一轮跑在哪条 WU 上」时用它）。
   *
   * ref → id 的解析归台账（唯一写者）：让每个调用点各自查一次，就是同一个事实
   * 长出多个解析器。`parentId` 优先；`parentRef` 解析不到时显式落 NULL（不猜）。
   */
  parentRef?: string | null;
  addressRef?: string | null;
  taskId?: string | null;
  model?: string | null;
  budget?: number | null;
  contextRef?: string | null;
  claimedBy?: string | null;
  leaseUntil?: string | null;
}

export interface WorkUnitTransitionOptionsLike {
  changedById?: string | null;
  changedByType?: 'human' | 'agent' | 'system';
  changedByName?: string | null;
  reason?: string | null;
  claimedBy?: string | null;
  leaseUntil?: string | null;
  stopReason?: string | null;
  resultRef?: string | null;
}

/**
 * 结构化事件 —— 取代「在日志里找一句话」。
 *
 * 断言「发生了」看 `type` 计数，断言「没发生」看计数为 0；两者都不断言日志文本。
 */
export interface WorkUnitEvent {
  type:
    | 'work_unit.ensure_failed'
    | 'work_unit.transition_failed'
    | 'work_unit.link_failed'
    | 'work_unit.usage_failed'
    | 'work_unit.created';
  ref?: string;
  itemId?: string;
  agentId?: string;
  error?: string;
}

/** `work_status()` 的返回形状：字段固定，全部来自对象查询。 */
export interface WorkStatusReport {
  agentId: string;
  count: number;
  units: Array<{
    ref: string;
    status: WorkUnitStatus;
    parentId: string | null;
    claimedBy: string | null;
    leaseUntil: string | null;
    budget: number | null;
    used: number;
  }>;
}

export class WorkUnitService {
  private failures = 0;
  private created = 0;
  private readonly onEvent: (event: WorkUnitEvent) => void;

  constructor(private readonly deps: { repo: WorkUnitPort; onEvent?: (event: WorkUnitEvent) => void }) {
    this.onEvent = deps.onEvent ?? (() => {});
  }

  /** 计数面：测试与看板读这个，不读日志文本。 */
  getStats(): { failures: number; created: number } {
    return { failures: this.failures, created: this.created };
  }

  /**
   * 幂等建 WU。**永不抛出**（写失败 → 结构化事件 + 计数 + 返回 null）。
   *
   * 返回 `null` 是诚实的答案：调用方可以继续干活，但「这条活没有身份」这件事
   * 已经被计入 `failures`，而不是被假装成功。
   */
  ensure(seed: WorkUnitSeedLike): WorkUnitRecord | null {
    if (!seed.ref || !seed.agentId) {
      this.fail('work_unit.ensure_failed', seed.ref, undefined, 'ref and agentId are required');
      return null;
    }
    try {
      const resolved = this.withParentId(seed);
      const { row, created } = this.deps.repo.ensure(resolved);
      if (created) {
        this.created += 1;
        this.emit({ type: 'work_unit.created', ref: row.ref, agentId: row.agentId });
      }
      return row;
    } catch (err) {
      this.fail('work_unit.ensure_failed', seed.ref, seed.agentId, String(err));
      return null;
    }
  }

  /**
   * 迁移 —— 矩阵的**唯一执行点**。非法迁移**抛出**（`WorkUnitTransitionError`，
   * 带 `code='invalid_work_unit_transition'`），状态保持不变。
   */
  transition(
    ref: string,
    to: WorkUnitStatus,
    opts?: WorkUnitTransitionOptionsLike,
  ): WorkUnitRecord {
    const current = this.deps.repo.getByRef(ref);
    if (!current) {
      throw new Error(`WorkUnit transition failed: ref "${ref}" not found`);
    }
    // 前置判定放在这里，而不是只依赖 repo 里的 `WHERE status = ?`：
    // 让「矩阵不允许」与「并发抢先」这两种失败有可区分的错误码。
    if (!canTransitionWorkUnit(current.status, to)) {
      const err = new Error(
        `Invalid WorkUnit transition for ${ref}: ${current.status} → ${to} is not in WU_TRANSITIONS`,
      ) as Error & { code?: string; from?: WorkUnitStatus; to?: WorkUnitStatus };
      err.code = 'invalid_work_unit_transition';
      err.from = current.status;
      err.to = to;
      throw err;
    }
    return this.deps.repo.transition(ref, to, opts);
  }

  /**
   * 业务路径用的迁移：吞掉**非矩阵**失败（记事件），矩阵失败照样抛。
   *
   * 为什么要分开：任务/对话流程不该因为「记账失败」而失败（观测设施不能变成故障点），
   * 但非法迁移是代码写错了，必须让测试与开发立刻看到。
   */
  tryTransition(
    ref: string,
    to: WorkUnitStatus,
    opts?: WorkUnitTransitionOptionsLike,
  ): WorkUnitRecord | null {
    try {
      return this.transition(ref, to, opts);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'invalid_work_unit_transition') throw err;
      this.fail('work_unit.transition_failed', ref, undefined, String(err));
      return null;
    }
  }

  /**
   * 让 C6 墓碑变活：把本次执行的 WU ref 写到触发它的 mailbox 行上。
   *
   * 调用纪律：**WU 已存在之后**才写（先实体后引用）。itemId 或 ref 未知就直接跳过 ——
   * 宁可这一行留 NULL，也不猜「大概是最近那条」、更不为了凑一个 ref 临时造一行 WU。
   * `ref === null` 是调用方的显式表态（这条活此刻没有 WU），静默 no-op 不抛。
   */
  linkMailboxItem(itemId: string | null | undefined, ref: string | null): boolean {
    if (!itemId || !ref) return false;
    try {
      const ok = this.deps.repo.linkMailboxItem(itemId, ref);
      if (!ok) {
        // 0 行被改 = 这一行不存在或已被收口清理。不是错误，但必须可见。
        this.emit({ type: 'work_unit.link_failed', ref, itemId, error: 'mailbox item not found' });
      }
      return ok;
    } catch (err) {
      this.fail('work_unit.link_failed', ref, undefined, String(err), itemId);
      return false;
    }
  }

  /**
   * 自省读面：`work_status()` 的答案。
   *
   * 只从 `work_units` 读，**不读 payload、不读会话文本、不读注入块**。
   * 这是需求 §10.1 缺口 A 的关闭点：答案必须有权威对象背书，否则「我有几个 worker
   * 在跑」只能是一份会漂移的快照。
   */
  workStatus(agentId: string, opts?: { limit?: number; statuses?: WorkUnitStatus[] }): WorkStatusReport {
    const limit = opts?.limit ?? 50;
    const rows = this.deps.repo.listByAgent(agentId, { statuses: opts?.statuses, limit });
    return {
      agentId,
      count: rows.length,
      units: rows.map((r) => ({
        ref: r.ref,
        status: r.status,
        parentId: r.parentId,
        claimedBy: r.claimedBy,
        leaseUntil: r.leaseUntil,
        budget: r.budget,
        used: r.used,
      })),
    };
  }

  /** 子 WU 的只读视图（C7-B 才有写入者；本卡读空集是对的）。 */
  children(parentId: string): WorkUnitRecord[] {
    return this.deps.repo.listChildren(parentId);
  }

  /**
   * C7-B —— 迭代记账。`used` 的单位是 **iteration 次数**（与 `budget` 同口径）。
   *
   * 为什么记账必须走这里而不是各委派路径自己 UPDATE：一个事实只能有一个写者。
   * 委派路径只负责「我花了多少次」这一个输入，落库口径在这里统一。
   * 非矩阵错误吞掉并记结构化事件（观测不得成为业务故障点）。
   */
  recordUsage(ref: string, used: number): void {
    if (!Number.isFinite(used) || used <= 0) return;
    try {
      this.deps.repo.addUsage(ref, Math.floor(used));
    } catch (err) {
      this.fail('work_unit.usage_failed', ref, undefined, String(err));
    }
  }

  /**
   * C7-B —— 子 WU 收口：先记账（`used`），再迁移状态。
   *
   * `paused_budget` 与 `idle` 的差别是结构性的：「被预算停下的」与「干完了的」
   * 必须能从状态（和 `status_transitions` 行）读出来，不能只写在结果文本里。
   * 迁移用 `tryTransition`：业务路径不该因为记账失败而失败，但**非法迁移照样抛**。
   */
  settle(
    ref: string,
    opts: { used: number; status: 'idle' | 'paused_budget'; reason: string },
  ): void {
    this.recordUsage(ref, opts.used);
    this.tryTransition(ref, opts.status, { changedByType: 'system', reason: opts.reason });
  }

  /**
   * `parentRef` → `parentId` 的**唯一**解析点（C7-B）。
   *
   * 解析不到就落 NULL，也不改写 ref —— 子 WU 仍然成立，只是父子链缺一环。
   * 不抛：父 WU 可能属于另一个已归档的回合，那不该阻断新一条活。
   */
  private withParentId(seed: WorkUnitSeedLike): WorkUnitSeedLike {
    if (seed.parentId !== undefined || !seed.parentRef) return seed;
    const parent = this.deps.repo.getByRef(seed.parentRef);
    return { ...seed, parentId: parent ? parent.id : null };
  }

  /**
   * C7-B —— 回合开始时还确定不了的 `context_ref` 后补（chat 一轮的会话身份）。
   *
   * 只填空值、绝不覆盖：一处「后补」如果可以改写已有值，它就成了第二个写者，
   * `work_units.context_ref` 也就不再是会话锁键的可信来源。
   */
  adoptContextRef(ref: string, contextRef: string | null | undefined): boolean {
    if (!ref || !contextRef) return false;
    try {
      return this.deps.repo.adoptContextRef(ref, contextRef);
    } catch (err) {
      this.fail('work_unit.link_failed', ref, undefined, String(err));
      return false;
    }
  }

  private emit(event: WorkUnitEvent): void {
    try {
      this.onEvent(event);
    } catch {
      // 事件消费者自己炸了不能反过来打断业务；计数已经在 failures/created 里。
    }
  }

  private fail(
    type: WorkUnitEvent['type'],
    ref?: string,
    agentId?: string,
    error?: string,
    itemId?: string,
  ): void {
    this.failures += 1;
    this.emit({ type, ref, agentId, error, itemId });
  }
}

/** 三个 `ref` 生成器对外只暴露这一个聚合（生产代码不直接拼字符串）。 */
export { WORK_UNIT_REF, WORK_UNIT_STATUSES };
export type { WorkUnitRecord, WorkUnitStatus };