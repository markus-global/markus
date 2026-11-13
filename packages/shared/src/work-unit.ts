/**
 * WorkUnit — 一条「活」的身份对象（第七刀 C7-A）。
 *
 * 这个文件是 WorkUnit 的**唯一概念源**：状态集合、迁移矩阵、`ref` 命名。
 * 为什么要独立成模块而不是塞进 service：
 *
 *   1. **矩阵必须只有一个执行点。** 迁移合法性是「一个不变量」，判断它的地方
 *      多一处，就会长出第二套真相。这里只声明「什么能到什么」，不写库、不持状态；
 *      唯一的执行点在 `WorkUnitService.transition()`，唯一的 SQL 写在
 *      `SqliteWorkUnitRepo`（`scripts/architecture-guard.mjs` 的
 *      `work-unit-single-writer` 契约守这条）。
 *
 *   2. **`ref` 只能有一个生成器。** C6 给了 `mailbox_items.work_unit_ref` 列却
 *      写 0 行，理由就是「先建实体再建引用，别造悬空引用」。`ref` 是实体的幂等键：
 *      两套命名生成器 = 同一个执行纪元可以长出两个 WU，之后谁也说不清哪条是它。
 *      所以三个生产者（chat / task / a2a）**只许**调这里的 `WORK_UNIT_REF`，
 *      task 的 `task_<id>_r<round>` 沿用既有格式（零迁移），不新造。
 *
 * 纯声明模块：无 import、无副作用，storage / org-manager / core 都能安全引用。
 */

// ─── 状态 ─────────────────────────────────────────────────────────────────────

/**
 * 五个状态，全部可由结构回答，没有一个是从载荷推断出来的（R3）。
 *
 * - `running`       正在执行
 * - `idle`          回合结束、等下一次输入（不是「空闲」的闲聊，而是「这条活还活着」）
 * - `paused_budget` 预算到线暂停（C7-B 才会产生；本卡只让它可表达）
 * - `terminated`    被取消 / 失败收口
 * - `archived`      终态，归档后不再参与任何调度
 */
export type WorkUnitStatus = 'running' | 'idle' | 'paused_budget' | 'terminated' | 'archived';

/** 运行期可枚举的状态集合（读取侧校验用，顺序 = 生命周期顺序）。 */
export const WORK_UNIT_STATUSES: readonly WorkUnitStatus[] = [
  'running',
  'idle',
  'paused_budget',
  'terminated',
  'archived',
];

export function isWorkUnitStatus(value: unknown): value is WorkUnitStatus {
  return typeof value === 'string' && (WORK_UNIT_STATUSES as readonly string[]).includes(value);
}

// ─── 迁移矩阵（声明式：一处定义，一处执行）─────────────────────────────────

/**
 * `from → 允许到达的 to`。空数组 = 终态。
 *
 * | from | to | 触发 |
 * |---|---|---|
 * | running | idle / paused_budget / terminated | 回合收口 / 预算到线 / 取消 |
 * | idle | running / terminated | 新回合 / 取消 |
 * | paused_budget | running / terminated | 追加预算 / 取消 |
 * | terminated | archived | 归档 |
 * | archived | — | 终态 |
 *
 * **`archived → running` 必须判红**：归档是「这件事已经结束了」的唯一表达，
 * 允许复活就等于让归档变成可撤销的装饰，历史读数会开始漂移。
 * 需要继续干活时，正确做法是新建一个 WU（新 `ref` 或新 round），不是复活旧的。
 */
export const WU_TRANSITIONS: Readonly<Record<WorkUnitStatus, readonly WorkUnitStatus[]>> = {
  running: ['idle', 'paused_budget', 'terminated'],
  idle: ['running', 'terminated'],
  paused_budget: ['running', 'terminated'],
  terminated: ['archived'],
  archived: [],
};

/** 矩阵判定 —— 纯函数，不抛异常，供读取侧/测试直接断言。 */
export function canTransitionWorkUnit(from: WorkUnitStatus, to: WorkUnitStatus): boolean {
  return (WU_TRANSITIONS[from] ?? []).includes(to);
}

/** 非法迁移的结构化错误：调用方靠 `code` 判定，不靠解析错误文本。 */
export class WorkUnitTransitionError extends Error {
  readonly code = 'invalid_work_unit_transition';
  constructor(
    readonly from: WorkUnitStatus,
    readonly to: WorkUnitStatus,
    readonly ref: string,
    readonly allowed: readonly WorkUnitStatus[],
  ) {
    super(
      `Invalid WorkUnit transition for ${ref}: ${from} → ${to} is not in WU_TRANSITIONS. ` +
        `Allowed from ${from}: ${allowed.length ? allowed.join(', ') : '<none, terminal state>'}.`,
    );
    this.name = 'WorkUnitTransitionError';
  }
}

/**
 * 矩阵的断言版 —— **唯一的判定入口**，`WorkUnitService.transition()` 调它。
 *
 * 抛 `WorkUnitTransitionError`（带 `code`），而不是返回 boolean：
 * 非法迁移是程序错误，不是可恢复的业务分支；静默返回 false 会让调用方
 * 以为「迁移失败了但世界照常」，于是状态机形同虚设。
 */
export function assertWorkUnitTransition(
  from: WorkUnitStatus,
  to: WorkUnitStatus,
  ref: string,
): void {
  if (!canTransitionWorkUnit(from, to)) {
    throw new WorkUnitTransitionError(from, to, ref, WU_TRANSITIONS[from] ?? []);
  }
}

// ─── `ref` 命名（唯一生成器）────────────────────────────────────────────────

/**
 * `ref` = 幂等键（唯一索引 `uq_work_units_ref` 兜底）。三个生产者只许调这里。
 *
 * 命名规则为什么这么定：
 *
 * - **chat** `session:<dbSessionId>:r<round>` —— 一轮对话 = 一个 WU。`round` 是该
 *   会话里第几轮用户输入（1 起）。会话身份是 DB 会话 id（`cs_*`），不是内存会话
 *   key（`sess_*`）：前者才是可持久化、可复查的那一个。
 * - **task** `task_<taskId>_r<round>` —— **沿用既有格式**。这个字符串今天已经是
 *   「执行纪元」的身份：在飞登记表的键、执行会话 id 都用它。再造一套命名等于
 *   给同一个纪元发两张身份证，所以这里只是把既有格式**收敛到单一生成器**。
 * - **a2a** `a2a:<channelKey>:<deliveryId>` —— 一次投递 = 一个 WU。`deliveryId`
 *   与信封 `messageId` 是同一个值（投递身份在 C6 已经唯一），重投同一跳不会
 *   生成第二个 WU。
 */
export const WORK_UNIT_REF = {
  chat(sessionId: string, round: number): string {
    return `session:${sessionId}:r${round}`;
  },
  task(taskId: string, round: number): string {
    return `task_${taskId}_r${round}`;
  },
  a2a(channelKey: string, deliveryId: string): string {
    return `a2a:${channelKey}:${deliveryId}`;
  },
} as const;

// ─── 行结构（读取侧的形状，与 work_units 列一一对应）───────────────────────

/**
 * 一行 WorkUnit。字段严格按执行计划 §2，**不加派生列**：
 * 派生值（例如 `isActive`）在读取处即时算，存下来就是第二个真相。
 */
export interface WorkUnitRecord {
  id: string;
  parentId: string | null;
  ref: string;
  agentId: string;
  addressRef: string | null;
  taskId: string | null;
  model: string | null;
  status: WorkUnitStatus;
  budget: number | null;
  used: number;
  claimedBy: string | null;
  leaseUntil: string | null;
  stopReason: string | null;
  resultRef: string | null;
  contextRef: string | null;
  archivedAt: string | null;
}