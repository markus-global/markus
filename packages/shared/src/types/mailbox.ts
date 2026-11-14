// ─── Mailbox Types ──────────────────────────────────────────────────────────

import type { DeliveryEnvelope, SignalClass } from '../mail.js';

export type MailboxItemType =
  | 'human_chat'
  | 'a2a_message'
  | 'task_status_update'
  | 'task_comment'
  | 'heartbeat'
  | 'review_request'
  | 'requirement_update'
  | 'requirement_comment'
  | 'mention'
  | 'system_event'
  | 'session_reply'
  | 'daily_report'
  | 'memory_consolidation'
  | 'workflow_update'
  | 'callback_result';

export type MailboxPriority = 0 | 1 | 2 | 3 | 4;

export const MailboxPriorityLevel = {
  critical: 0 as MailboxPriority,
  high: 1 as MailboxPriority,
  normal: 2 as MailboxPriority,
  low: 3 as MailboxPriority,
  background: 4 as MailboxPriority,
} as const;

export const PRIORITY_LABELS: Record<MailboxPriority, string> = {
  0: 'Critical',
  1: 'High',
  2: 'Normal',
  3: 'Low',
  4: 'Background',
};

// ─── Centralised Type Registry ─────────────────────────────────────────────
//
// THE single source of truth for all mailbox item type metadata.
// Every other module (core routing, attention heuristics, default priorities,
// frontend filters/labels/icons) MUST read from this registry.

export type MailboxCategory = 'interaction' | 'task' | 'notification' | 'system';

/**
 * 实体亲和作用域 —— 并发处理时「哪些 item 不能同时被两个 worker 处理」的维度。
 *
 * 每个 mailbox item 类型在注册表里声明自己参与的作用域列表（按优先级排序）；
 * 运行时取「第一个能解析出值的」作用域作为实体锁键。作用域列表**必须以
 * `'system'` 结尾**，作为无法解析出具体实体时的安全兜底（同一 Agent 内串行）。
 *
 * | scope | 键 | 含义 |
 * |---|---|---|
 * | `task` | `task:{taskId}` | 同一任务的所有事件永不并发 |
 * | `requirement` | `req:{requirementId}` | 同一需求永不并发 |
 * | `user` | `user:{senderId}` | 同一发起人的消息串行（防同用户矛盾回复） |
 * | `conversation` | `conv:{sessionId}` | 同一会话永不并发 |
 * | `channel` | `channel:{channelKey}` | 同一 A2A DM / 群聊频道永不并发 |
 * | `system` | `system:{agentId}` | 兜底：无具体实体 → 同 Agent 内串行 |
 */
export type MailboxEntityScope =
  | 'task'
  | 'requirement'
  | 'user'
  | 'conversation'
  | 'channel'
  | 'system';

/**
 * 作用域解析优先级（`system` 恒为最后兜底）。
 *
 * 全局唯一顺序 —— 各类型声明的 `entityScopes` 必须是本序列的**子序列**，
 * 只表达「参与哪些维度」，不自行定义顺序。校验见 shared-types.test.ts。
 *
 * **会话优先**（conversation 而非 user）是刻意的：聊天的并发隔离维度是
 * **会话/标签页**，不是发起人。同一个人在不同 session tab 里同时发言应当
 * 真并行（各 tab 各自上下文、各自流），只有**同一会话**才必须串行以保序。
 * 早期版本把 `user` 排在 `conversation` 之前，使同一个人的多标签页被全量
 * 串行（实测交接日志出现 41 次 `user:*` 冲突）；现改为会话优先。
 * `user` 仍保留在可选维度中，供确实需要「按人串行」的类型（如 mention）使用。
 */
export const ENTITY_SCOPE_ORDER: readonly MailboxEntityScope[] = [
  'task', 'requirement', 'user', 'conversation', 'channel', 'system',
];

/**
 * **展示面** —— 给人看的：文案 / 图标 / 分组。
 *
 * 改这里永远不会碰到运行时：并发锁、调度、幂等都在 `policy` 里。
 * （这正是 R1 的切线：过去一个结构混住四种关注点，改 UI 文案会碰到并发规则。）
 */
export interface MailboxTypePresentation {
  label: string;
  icon: string;
  category: MailboxCategory;
}

/**
 * **路由策略面** —— 给运行时看的。唯一读者是 {@link routeMailboxItem}。
 *
 * 别处**不得**直接读 `MAILBOX_TYPE_REGISTRY[t].policy.*`：所有消费者一律走
 * `routeMailboxItem(item)`，这样「一个 item 怎么被路由」永远只有一个答案。
 */
export interface MailboxTypePolicy {
  /** 调度：默认优先级（数字越小越先）。 */
  priority: MailboxPriority;
  /** 回合语义：处理该类型是否欠一个 LLM 回合。 */
  invokesLLM: boolean;
  /**
   * 并发亲和：参与实体锁的维度（优先级降序，最后一项必须是 `'system'`）。
   * 运行时每个能解析出值的维度都会上锁（见 {@link resolveEntityKeys}）。
   */
  affinity: readonly MailboxEntityScope[];
  /** 幂等：按 `(type, taskId, round)` 至多一条（见 {@link routeMailboxItem}）。 */
  dedupePerRound: boolean;
  /** 陈旧可丢：triage 时按年龄直接丢（list 由 limits 的 TRIAGE_STALE_DROP_TYPES 派生）。 */
  triageStaleDrop: boolean;
  /**
   * 后台工作：抢占判定里「当前在处理的是后台/系统工作」的判据。
   * **不得**再用展示字段 `category === 'system'` 表达这件运行时事实。
   */
  backgroundWork: boolean;
  /**
   * 权威态：命中即不得 defer / drop / merge / 批处理。
   *
   * **只读注册表数据 + 结构字段**（`envelope.intent`），不再有谓词、不再读 payload：
   * `extra.triggerExecution` 的判定与类型无关 → 由 {@link routeMailboxItem} 统一施加；
   * `extra.actionRequired` 是**按类型**成立的 → 由下面的 `actionRequiredStrict` 表达。
   */
  strictState: boolean;
  /**
   * `intent='action_required'` 对**本类型**是否构成权威态（数据驱动，替代原先写在
   * 代码里的 `t === 'requirement_update' || t === 'workflow_update'` 字符串判断）。
   *
   * 为什么必须按类型门控：心跳也可能带 `actionRequired`（此时它**不得被折叠**），
   * 但心跳**不是**权威态——把两者混成一个布尔会让心跳占满并发锁。
   */
  actionRequiredStrict: boolean;
}

export interface MailboxTypeDescriptor extends MailboxTypePresentation {
  /** 信号类别（信封 `signalClass` 的唯一来源；六类闭集，见 `@markus/shared` 的 mail 模块）。 */
  signalClass: SignalClass;
  policy: MailboxTypePolicy;
}

// Two fields were removed here on 2026-10-25 — not renamed, deleted:
//
// - `activityType`: the activity row describes what the agent was DOING, which is
//   the turn's scenario, not the mailbox type. The mailbox type is a lossy proxy:
//   `review_request` arrives as scenario `review` (internal work), yet this table
//   claimed `chat`. Two tables disagreed about one fact, and only the scenario
//   table was ever read. The single mapping now lives in
//   `SCENARIO_ACTIVITY_TYPE` (@markus/core), exhaustively typed over AgentScenario.
// - `createsActivity`: a per-type boolean cannot express the actual rule. A
//   `task_comment` creates no activity when injected into a running turn, but does
//   when it falls through to handleMessage — the outcome is contextual. Nothing
//   read the field, so it recorded a rule the runtime never followed.
export const MAILBOX_TYPE_REGISTRY: Record<MailboxItemType, MailboxTypeDescriptor> = {
  //                                                                                     ── policy.affinity (precedence order; MUST end with 'system')
  system_event:         { label: 'System Event',         category: 'system',       icon: '⚙',  signalClass: 'system',           policy: { priority: 1, invokesLLM: true,  affinity: ['system'], dedupePerRound: false, triageStaleDrop: false, backgroundWork: true,  strictState: false, actionRequiredStrict: false } },
  human_chat:           { label: 'Chat',                 category: 'interaction',  icon: '💬', signalClass: 'chat',             policy: { priority: 0, invokesLLM: true,  affinity: ['task', 'requirement', 'conversation', 'system'], dedupePerRound: false, triageStaleDrop: false, backgroundWork: false, strictState: false, actionRequiredStrict: false } },
  task_comment:         { label: 'Task Comment',         category: 'task',         icon: '💬', signalClass: 'record',          policy: { priority: 2, invokesLLM: false, affinity: ['task', 'requirement', 'system'], dedupePerRound: false, triageStaleDrop: false, backgroundWork: false, strictState: false, actionRequiredStrict: false } },
  mention:              { label: 'Mention',              category: 'interaction',  icon: '@',  signalClass: 'chat',             policy: { priority: 1, invokesLLM: true,  affinity: ['task', 'requirement', 'user', 'conversation', 'system'], dedupePerRound: false, triageStaleDrop: false, backgroundWork: false, strictState: false, actionRequiredStrict: false } },
  session_reply:        { label: 'Session Reply',        category: 'task',         icon: '↩',  signalClass: 'chat',             policy: { priority: 1, invokesLLM: true,  affinity: ['task', 'requirement', 'conversation', 'system'], dedupePerRound: false, triageStaleDrop: false, backgroundWork: false, strictState: false, actionRequiredStrict: false } },
  task_status_update:   { label: 'Task Status',          category: 'task',         icon: '📋', signalClass: 'record',          policy: { priority: 1, invokesLLM: false, affinity: ['task', 'system'], dedupePerRound: false, triageStaleDrop: true,  backgroundWork: false, strictState: false, actionRequiredStrict: false } },
  a2a_message:          { label: 'Agent Message',        category: 'interaction',  icon: '🔗', signalClass: 'a2a',              policy: { priority: 2, invokesLLM: true,  affinity: ['task', 'requirement', 'channel', 'system'], dedupePerRound: false, triageStaleDrop: false, backgroundWork: false, strictState: false, actionRequiredStrict: false } },
  review_request:       { label: 'Review Request',       category: 'task',         icon: '👀', signalClass: 'governance_event', policy: { priority: 1, invokesLLM: true,  affinity: ['task', 'requirement', 'system'], dedupePerRound: true,  triageStaleDrop: false, backgroundWork: false, strictState: true,  actionRequiredStrict: false } },
  requirement_comment:  { label: 'Requirement Comment',  category: 'task',         icon: '💬', signalClass: 'record',          policy: { priority: 2, invokesLLM: false, affinity: ['task', 'requirement', 'system'], dedupePerRound: false, triageStaleDrop: false, backgroundWork: false, strictState: false, actionRequiredStrict: false } },
  requirement_update:   { label: 'Requirement Update',   category: 'notification', icon: '📝', signalClass: 'governance_event', policy: { priority: 1, invokesLLM: false, affinity: ['requirement', 'system'], dedupePerRound: false, triageStaleDrop: false, backgroundWork: false, strictState: false, actionRequiredStrict: true } },
  daily_report:         { label: 'Daily Report',         category: 'system',       icon: '📊', signalClass: 'system',           policy: { priority: 2, invokesLLM: true,  affinity: ['system'], dedupePerRound: false, triageStaleDrop: true,  backgroundWork: true,  strictState: false, actionRequiredStrict: false } },
  heartbeat:            { label: 'Heartbeat',            category: 'system',       icon: '♡',  signalClass: 'system',           policy: { priority: 3, invokesLLM: true,  affinity: ['system'], dedupePerRound: false, triageStaleDrop: true,  backgroundWork: true,  strictState: false, actionRequiredStrict: false } },
  memory_consolidation: { label: 'Memory Consolidation', category: 'system',       icon: '🧠', signalClass: 'system',           policy: { priority: 4, invokesLLM: true,  affinity: ['system'], dedupePerRound: false, triageStaleDrop: true,  backgroundWork: true,  strictState: false, actionRequiredStrict: false } },
  workflow_update:      { label: 'Workflow Update',      category: 'task',         icon: '🔄', signalClass: 'governance_event', policy: { priority: 2, invokesLLM: true,  affinity: ['task', 'requirement', 'system'], dedupePerRound: false, triageStaleDrop: false, backgroundWork: false, strictState: false, actionRequiredStrict: true } },
  callback_result:      { label: 'Callback Result',      category: 'system',       icon: '↩',  signalClass: 'callback',         policy: { priority: 1, invokesLLM: true,  affinity: ['conversation', 'system'], dedupePerRound: false, triageStaleDrop: true,  backgroundWork: true,  strictState: false, actionRequiredStrict: false } },
};

// ─── The single routing decision point ───────────────────────────────────────
//
// Every runtime question of the form "how is this item routed?" — priority,
// whether it owes an LLM turn, which entities it locks, whether its state is
// authoritative, whether it may be dropped when stale, what its idempotency key
// is — is answered HERE and nowhere else. Consumers call `routeMailboxItem()`
// instead of reading `MAILBOX_TYPE_REGISTRY[...].policy.*` or writing their own
// `sourceType === '…'` chains.
//
// Pure: no IO, no clock, no randomness. Same input → same output (cacheable, and
// lockable by table-driven golden tests).

export type MailboxItemLite = Pick<MailboxItem, 'sourceType' | 'payload' | 'metadata'> & {
  /**
   * 身份头（结构化）。路由只读它的 `intent` —— **不读 `payload.extra`**（R3'）。
   * 缺省（旧行 / 未接线调用方）= 无信封 → 按 `deliver` 处理。
   */
  envelope?: Pick<DeliveryEnvelope, 'intent'>;
  /** 轮次（结构化，替代 `payload.extra.round` / `metadata.round` 两处散读）。 */
  round?: number;
};

export interface MailboxRoute {
  type: MailboxItemType;
  /** 信封 `signalClass` 的唯一来源：路由决策点同时是分类决策点。 */
  signalClass: SignalClass;
  priority: MailboxPriority;
  invokesLLM: boolean;
  affinity: readonly MailboxEntityScope[];
  strictState: boolean;
  triageStaleDrop: boolean;
  /** 抢占判定用：该项是否属于后台/系统工作。 */
  backgroundWork: boolean;
  /** `undefined` = the item carries no idempotency constraint. */
  dedupeKey?: string;
}

// 2026-11-12（第六刀 C2）：`hasAuthorityFlag()` 与 `buildRoundDedupKey()` 已删除。
//
// 两者都在**从载荷推断结构**（R3'）：`payload.extra.triggerExecution` 决定权威态、
// `payload.extra.round` 决定幂等键。同一份结构因此有两处来源（载荷 + 结构列），
// 改一处不改另一处就会出现「路由说跑、去重说别跑」这类只有线上才看得见的裂缝。
//
// 现在：权威态只读结构字段 `envelope.intent`（按类型的门控在注册表
// `actionRequiredStrict`），幂等键只读结构字段 `round`。下面两个函数是各自的唯一判定点。

/**
 * 权威态：`intent` 与注册表按类型的门控共同决定。**唯一判定点**。
 *
 * - `trigger_execution` 与类型无关（任务执行指令落在任一类型上都必须真跑）；
 * - `action_required` 只对声明了 `actionRequiredStrict` 的类型成立（需求/工作流收尾）。
 */
function isAuthoritativeUnderPolicy(item: MailboxItemLite, p: MailboxTypePolicy): boolean {
  const intent = item.envelope?.intent ?? 'deliver';
  if (intent === 'trigger_execution') return true;
  return intent === 'action_required' && p.actionRequiredStrict;
}

/** `(sourceType, taskId, round)` — 幂等键形状的唯一写者，输入全为结构字段。 */
function roundDedupKeyOf(item: MailboxItemLite): string | undefined {
  const taskId = item.payload.taskId ?? (item.metadata?.taskId as string | undefined);
  const round = item.round;
  if (!taskId || typeof round !== 'number' || !Number.isFinite(round)) return undefined;
  return `${item.sourceType}:${taskId}:${round}`;
}

/** Conservative fallback for an unregistered type: run, don't drop, don't throw. */
const UNKNOWN_ROUTE: Omit<MailboxRoute, 'type'> = {
  signalClass: 'system',
  priority: 2,
  invokesLLM: true,
  affinity: ['system'],
  strictState: false,
  triageStaleDrop: false,
  backgroundWork: false,
  dedupeKey: undefined,
};

export function routeMailboxItem(item: MailboxItemLite): MailboxRoute {
  const descriptor = MAILBOX_TYPE_REGISTRY[item.sourceType];
  if (!descriptor) return { type: item.sourceType, ...UNKNOWN_ROUTE };
  const p = descriptor.policy;
  const strictState = isAuthoritativeUnderPolicy(item, p) || p.strictState;
  const dedupeKey = p.dedupePerRound ? roundDedupKeyOf(item) : undefined;
  return {
    type: item.sourceType,
    signalClass: descriptor.signalClass,
    priority: p.priority,
    invokesLLM: p.invokesLLM,
    affinity: p.affinity,
    strictState,
    triageStaleDrop: p.triageStaleDrop,
    backgroundWork: p.backgroundWork,
    dedupeKey,
  };
}

export const MAILBOX_CATEGORIES: Record<MailboxCategory, { label: string; types: MailboxItemType[] }> = {
  interaction:  { label: 'Interaction',  types: ['human_chat', 'a2a_message', 'mention'] },
  task:         { label: 'Task',         types: ['task_status_update', 'task_comment', 'requirement_comment', 'review_request', 'session_reply', 'workflow_update'] },
  notification: { label: 'Notification', types: ['requirement_update'] },
  system:       { label: 'System',       types: ['system_event', 'heartbeat', 'daily_report', 'memory_consolidation', 'callback_result'] },
};

// ─── Entity Affinity Resolution ─────────────────────────────────────────────
// Single source of truth for "which entity does this item belong to" — used by
// the mailbox's concurrent-mode entity lock. The per-type scope list lives in
// MAILBOX_TYPE_REGISTRY (data, not code), so adding a mailbox type cannot
// silently fall outside concurrency protection.

/**
 * Resolve the full set of entity-affinity lock keys for a mailbox item.
 *
 * An item can belong to **several** entities at once (e.g. a human chat is both
 * `user:{senderId}` and `conv:{sessionId}`). Every resolved key is locked, so
 * two items conflict if they share **any** entity — a strictly safer rule than
 * picking a single "primary" key.
 *
 * `'system'` is a **fallback only**: it is used when no concrete scope resolves
 * (otherwise every chat would also lock `system:{agentId}` and destroy all
 * concurrency). The result is therefore never empty.
 *
 * Key namespaces (`task:` / `req:` / `conv:` / `user:` / `channel:` / `system:`)
 * are part of the contract and shared with the handoff log.
 */
export function resolveEntityKeys(
  item: Pick<MailboxItem, 'sourceType' | 'payload' | 'metadata'>,
  agentId: string,
): string[] {
  const scopes = routeMailboxItem(item).affinity;
  const keys: string[] = [];
  for (const scope of scopes) {
    if (scope === 'system') break; // fallback handled below
    switch (scope) {
      case 'task': {
        const id = item.payload.taskId ?? item.metadata?.taskId;
        if (id) keys.push(`task:${id}`);
        break;
      }
      case 'requirement': {
        const id = item.payload.requirementId;
        if (id) keys.push(`req:${id}`);
        break;
      }
      case 'user': {
        const id = item.metadata?.senderId;
        if (id) keys.push(`user:${id}`);
        break;
      }
      case 'conversation': {
        const id = item.metadata?.dbSessionId ?? item.metadata?.sessionId;
        if (id) keys.push(`conv:${id}`);
        break;
      }
      case 'channel': {
        const id = item.payload.extra?.channelKey as string | undefined;
        if (id) keys.push(`channel:${id}`);
        break;
      }
    }
  }
  if (keys.length === 0) keys.push(`system:${agentId}`);
  return dedupeKeys(keys);
}

/**
 * Convenience single-key form: the item's **primary** entity key (first resolved).
 * Used for logging / handoff records / conflict messages; locking uses
 * `resolveEntityKeys` so that every entity dimension is protected.
 */
export function resolveEntityKey(
  item: Pick<MailboxItem, 'sourceType' | 'payload' | 'metadata'>,
  agentId: string,
): string {
  return resolveEntityKeys(item, agentId)[0];
}

function dedupeKeys(keys: string[]): string[] {
  return keys.length > 1 ? [...new Set(keys)] : keys;
}

export type MailboxItemStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'deferred'
  | 'merged'
  /**
   * 退信（第六刀 §2.5）：**不再有「静默丢掉」这个终态**。`bounced` 行必带
   * `drop_reason`（五类可产生原因 + 一类预留的闭集）。
   *
   * 与 `catch_all` 的分工：`bounced` = 「这次没投进去」这一事实的记录；
   * `catch_all` = 该记录**已归集到概览**（`bounce_target` 写值），等人认领或归档。
   * 两者都是终态行会出现的值，但同一行只停在其中之一（见 {@link MAILBOX_TRANSITIONS}）。
   */
  | 'bounced'
  /**
   * catch-all 概览态（第六刀 §2.5 `bounced → catch_all`）：退信已被归集，
   * 在概览里**恰好可见一次**且原因可查。人认领 → `queued`；归档 → 停留（不迁移）。
   */
  | 'catch_all';

// ─── FSM-2：投递状态机（声明式矩阵）────────────────────────────────────────
//
// 第六刀 §2.5 / 主计划 §4.2（FSM-2）。**唯一**的执行点是
// `AgentMailbox.updateSignalStatus()`（core），本表是它的判据；任何绕过它的迁移
// 都被 `architecture-guard` 判红。
//
// 矩阵按**真实代码**枚举，而不是按设计稿的简化图。差集是刻意记录下来的事实：
// 设计稿只画了主链路，而 `defer`/`merge`/`complete` 在 core 的**排队态**上也会发生
// （`defer()` 从队列 splice、`merge()` 合并两条排队项、triage 的 inline 完成）。
// 若按设计稿裁剪，这些合法路径会在运行时被判非法 —— 那是把图当事实，不是把代码当事实。
//
// | from | to | 触发 |
// |---|---|---|
// | queued | processing | 原子认领（claimedBy + leaseUntil）|
// | queued | deferred / merged / completed / bounced | preempt 前置决策、入队合并、inline 完成、陈旧清理 |
// | processing | completed / deferred / merged / bounced | 回合收口 / preempt / 合并 / 解析失败·收件人不存在·租约失效 |
// | processing | queued | 回队（requeue / putBack / 租约过期回收 / 补偿重投）|
// | deferred | queued | resurfaceDue() |
// | bounced | catch_all | 归集到概览（写 bounce_target）|
// | bounced | queued | **补偿重投复用原行**（P1.x R6：同幂等键再投一次时复用既有 bounced 行，不新增行；storage `requeueItem` 的 WHERE 也显式列了 `bounced`）|
// | catch_all | queued | 人认领（re-queue 给真实目标）|
// | completed / merged | — | 终态，不迁移 |
//
// `bounced → queued` 曾经漏在表外：设计稿只看“归集”一条路径，但真实代码里**补偿重投**
// 走的就是“复用既有未收口行”，而 `bounced` 正是未收口终态。矩阵不收录它，这条合法路径
// 就会在运行时被判非法（restart 后重投会静默失败）——又一次“把图当事实”。
//
// `dropped` **不在取值域内**：历史行保留只读，读路径经 `normalizeSignalStatus()`
// 归一为 `bounced`，绝不改写历史数据（不回填、不批量 UPDATE）。
export const MAILBOX_TRANSITIONS: Readonly<Record<MailboxItemStatus, readonly MailboxItemStatus[]>> = Object.freeze({
  queued: ['processing', 'deferred', 'merged', 'completed', 'bounced'],
  processing: ['completed', 'deferred', 'merged', 'bounced', 'queued'],
  deferred: ['queued'],
  bounced: ['catch_all', 'queued'],
  catch_all: ['queued'],
  completed: [],
  merged: [],
});

/**
 * `from` 是否在当前取值域内。
 *
 * 为什么需要它：真实库里有 C3 之前的 `failed` 行（`requeueItem` 的 WHERE 里仍列着它）。
 * 这类值是**取值域外的历史态**，矩阵没有它的规则，但它们仍必须能被补偿重投回队。
 * 用这个谓词把“矩阵能判的”与“历史遗留只能由端口 SQL 自律的”分开，
 * 而不是让 `MAILBOX_TRANSITIONS[未知]` 抛 TypeError（那是把数据问题变成崩溃）。
 */
export function isKnownSignalStatus(status: string): status is MailboxItemStatus {
  return Object.prototype.hasOwnProperty.call(MAILBOX_TRANSITIONS, status);
}

/**
 * 迁移是否合法。**同一状态 → 同一状态** 永远允许：那不是迁移，而是字段更新
 * （例如 `updatePriority()` 在改优先级时顺带写一次同状态）。把它判非法会制造一类
 * 「改个优先级把队列卡死」的假失败。
 *
 * **取值域外的 `from`（历史 `failed`）一律判非法**（不是抛异常）：它没有规则可依，
 * 不该被任何“默认放行”的写法接住 —— 否则新增一个未知状态就等于自动获得所有出口。
 */
export function canTransitionSignal(from: MailboxItemStatus | string, to: MailboxItemStatus): boolean {
  if (from === to) return true;
  if (!isKnownSignalStatus(from)) return false;
  return MAILBOX_TRANSITIONS[from].includes(to);
}

/**
 * 历史状态 → 当前取值域。**读路径唯一归一函数**。
 *
 * `dropped` 是本刀删掉的终态（真实库 ≥28,621 行、无 `drop_reason`、无回声）。
 * 历史行**只读**：这里只把读到的值映射成 `bounced`，不 UPDATE 任何行。
 */
export function normalizeSignalStatus(raw: string): MailboxItemStatus {
  if (raw === 'dropped') return 'bounced';
  return raw as MailboxItemStatus;
}

/** 已归集/待归集的退信态（概览读者用这一个谓词，别处不得再写 `=== 'bounced'`）。 */
export function isBounceSignalStatus(status: MailboxItemStatus): boolean {
  return status === 'bounced' || status === 'catch_all';
}

// `catchAllTargetOf()` / `CATCH_ALL_PREFIX` 定义在 `mail.ts`（低层，无循环依赖），
// 由本模块经 index 一并导出。这里不重复定义 —— 同一事实两个写者必然漂移。

export interface MailboxItem {
  id: string;
  agentId: string;
  sourceType: MailboxItemType;
  priority: MailboxPriority;
  status: MailboxItemStatus;
  payload: MailboxPayload;
  metadata?: MailboxItemMetadata;
  /**
   * 投递信封（第六刀 §2.1）：**每条新信号的唯一身份头**。
   *
   * 由 `AgentMailbox.enqueue()` 在唯一装配点生成（形状写者是
   * `buildDeliveryEnvelope()`）；投递点只提供 `from` / `messageId`。
   * 旧行（C2 之前落库）为 `undefined` = 无信封，读路径 `warn` 并回退到 `agentId`。
   */
  envelope?: DeliveryEnvelope;
  /**
   * 本轮轮次（结构化）：幂等键 `(sourceType, taskId, round)` 的输入。
   * 从 `payload.extra.round` / `metadata.round` 提上来的结构字段（§2.1 硬规则 3）。
   */
  round?: number;
  /**
   * 第七刀 C7-A：这条 item 属于哪个 WorkUnit（`work_units.ref`）。
   *
   * 由生产者在**实体已存在之后**写入，不是入队时猜出来的。旧行为 `null`，
   * 意义是「这条投递在 WU 之前发生」——诚实留空，不补造身份。
   */
  workUnitRef?: string | null;
  /**
   * 退信原因（`status='bounced'` 时必填，六类闭集）；其它状态恒 `undefined`。
   * `undefined` + `bounced` = 不可建模的退信，写入侧由 `isActiveBounceReason` 拒绝。
   */
  dropReason?: string;
  /** catch-all 概览项 id（C3 写值）；本卡只加列。 */
  bounceTarget?: string;
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
  deferredUntil?: string;
  mergedInto?: string;
  /** Tracks how many times this item has been retried after abnormal completion. */
  retryCount?: number;
  /**
   * 原子认领者标识（P0 · 并发正确性）：认领该 item 的 worker 实例 id
   * （形如 `agentId#pid#seq`）。只有认领者本人有资格续租 / 释放 / 完成该项；
   * 其它实例即使持有内存副本也不得处理（`claimed_by` 不匹配即非本人）。
   */
  claimedBy?: string;
  /**
   * 认领租约到期时间（ISO 8601）。语义：`claimedBy` 非空且 `leaseUntil < now`
   * → 该项为「租约过期的孤儿」，可被其它 worker（含其它进程实例）重新认领。
   */
  leaseUntil?: string;
  /**
   * 进程内运行期回调（不在持久化面内；见 {@link MailboxItemRuntime}）。
   * 持久化只写 `payload` + `metadata`，因此这里永远不会落库。
   */
  runtime?: MailboxItemRuntime;
}

/**
 * 严格状态管理事件（Strict State Items）判定。
 *
 * 这类 mailbox item 承载了「任务/需求/工作流」的正式状态流转，必须走独立、
 * 完整的执行路径（executeTask / review / requirement_action / workflow_action），
 * 绝不能：
 *  - 被 defer / drop（持久化会丢失 onLog 等闭包 → resurface 后无法执行 → 任务卡死）
 *  - 被合并（consolidate / merge，会把评审/收尾内容吞进 informational item 而丢失）
 *  - 被 deliberation 批处理或 inline 完成（执行日志不会挂在 task 下，且状态变更不完整）
 *
 * 深度决策（deliberation）只允许对这类事件「排序 / 保持原样」，由正常出队路径单独处理。
 */
export function isStrictStateItem(item: {
  sourceType: MailboxItemType;
  payload: MailboxPayload;
}): boolean {
  return routeMailboxItem(item).strictState;
}

/** 是否为「正式任务执行」item（`intent='trigger_execution'`）。是 isStrictStateItem 的特例。 */
export function isTaskExecutionItem(item: {
  sourceType: MailboxItemType;
  payload: MailboxPayload;
  envelope?: Pick<DeliveryEnvelope, 'intent'>;
}): boolean {
  // 只读结构字段：`payload.extra.triggerExecution` 已不是事实来源（见 routeMailboxItem 上方注释）。
  return item.envelope?.intent === 'trigger_execution';
}

export interface MailboxPayload {
  summary: string;
  content: string;
  /** Structured multi-message array for merged channel items (group chat, A2A). */
  messages?: Array<{
    senderId?: string;
    senderName: string;
    content: string;
    timestamp: string;
  }>;
  /** For task_status_update */
  taskId?: string;
  /** For requirement_update */
  requirementId?: string;
  /** For review_request */
  reviewContext?: string;
  /** Arbitrary extra data */
  extra?: Record<string, unknown>;
}

export interface MailboxItemMetadata {
  senderId?: string;
  senderName?: string;
  senderRole?: string;
  isFirstConversation?: boolean;
  sessionId?: string;
  /** DB-level session ID (ses_*) for cross-session merge prevention in attention heuristics */
  dbSessionId?: string;
  taskId?: string;
  channelContext?: string;
  /**
   * How many items were folded into this one by dedup/consolidation.
   *
   * Lives here (a structured field) rather than as a `(+N)` suffix on the
   * display summary — structure must not be recoverable only by parsing a
   * human-readable string. Legacy items that predate this field still carry the
   * suffix, so readers fall back to parsing it (see `mergeCountOf`).
   */
  mergeCount?: number;
  /** When true, this item is a continuation of a previous conversation — not a new request. */
  isResume?: boolean;
}

/**
 * In-process runtime callbacks — **never persisted**.
 *
 * These live only on `MailboxItem.runtime`. Persistence serializes only
 * `payload` + `metadata`, so a function here is *structurally* unable to reach
 * the database — no strip guard required at any write path. "Is the initiator
 * still waiting?" reads this; after a restart it is naturally undefined (the
 * initiating request thread is gone).
 */
export interface MailboxItemRuntime {
  /** The initiator's resolver; absent after restart ⇒ initiator is gone. */
  responsePromise?: {
    resolve: (value: string) => void;
    reject: (reason: unknown) => void;
  };
}

// ─── Decision Types ─────────────────────────────────────────────────────────

export type DecisionType =
  | 'pick'
  | 'continue'
  | 'preempt'
  | 'cancel'
  | 'defer'
  | 'merge'
  | 'delegate'
  | 'drop'
  | 'complete'
  | 'triage';

// ─── Triage Types ──────────────────────────────────────────────────────────

export interface TriageContext {
  agentName: string;
  agentRole?: string;
  recentMainSessionMessages: Array<{ role: string; content: string }>;
  recentActivitySummaries: string[];
  activeTaskIds?: string[];
}

export interface TriageResult {
  processItemId: string;
  deferItemIds: string[];
  dropItemIds: string[];
  inlineCompletedIds?: string[];
  reasoning: string;
}

export interface DeliberationResult {
  /** Primary item to process (backward compat). Ignored if processItemIds is set. */
  processItemId: string;
  /** Batch of items to process together in one LLM session. Overrides processItemId when length > 1. */
  processItemIds?: string[];
  /** Optional synthesis/instruction for batch processing context. */
  batchContext?: string;
  deferItemIds: string[];
  dropItemIds: string[];
  inlineCompletedIds: string[];
  reasoning: string;
  situationalAwareness?: string;
  /** Memory operations to apply after deliberation completes. */
  memoryUpdates?: Array<{
    type: 'working' | 'longterm';
    key: string;
    content: string;
  }>;
}

export interface AttentionDecision {
  id: string;
  agentId: string;
  decisionType: DecisionType;
  mailboxItemId: string;
  context: DecisionContext;
  reasoning: string;
  outcome?: string;
  createdAt: string;
}

export interface DecisionContext {
  currentFocusType?: string;
  currentFocusLabel?: string;
  currentFocusItemId?: string;
  mailboxDepth: number;
  queuedItemTypes: string[];
}

// ─── Attention State ────────────────────────────────────────────────────────

export type AttentionState = 'idle' | 'focused' | 'deciding';

export interface AgentMindState {
  attentionState: AttentionState;
  isDeliberating?: boolean;
  deliberationActivity?: {
    activityId: string;
    label: string;
    startedAt: string;
  };
  currentFocus?: {
    mailboxItemId: string;
    type: MailboxItemType;
    label: string;
    startedAt: string;
    taskId?: string;
  };
  mailboxDepth: number;
  queuedItems: Array<{
    id: string;
    sourceType: MailboxItemType;
    priority: MailboxPriority;
    summary: string;
    queuedAt: string;
    /** 严格状态管理事件（正式任务执行/评审/收尾动作）——不可 defer/drop/合并/批处理，必须单独执行。 */
    isStrictState?: boolean;
  }>;
  deferredItems: Array<{
    id: string;
    sourceType: MailboxItemType;
    summary: string;
    deferredUntil?: string;
  }>;
  recentDecisions: AttentionDecision[];
  lastTriage?: {
    reasoning: string;
    processedItemId: string;
    deferredItemIds: string[];
    droppedItemIds: string[];
    inlineCompletedIds: string[];
    timestamp: string;
  };
}

// ─── User Notification Type Registry ─────────────────────────────────────────

export type UserNotificationType =
  | 'approval_request'
  | 'task_created'
  | 'task_completed'
  | 'task_review'
  | 'task_failed'
  | 'requirement_created'
  | 'requirement_decision'
  | 'agent_report'
  | 'system';

export type UserNotificationActionType = 'none' | 'navigate' | 'open_chat';

export interface UserNotificationTypeDescriptor {
  label: string;
  icon: string;
  defaultPriority: 'low' | 'normal' | 'high' | 'urgent';
  actionType: UserNotificationActionType;
  category: 'agent' | 'task' | 'approval' | 'system';
}

export const USER_NOTIFICATION_TYPE_REGISTRY: Record<UserNotificationType, UserNotificationTypeDescriptor> = {
  approval_request:    { label: 'Approval Request',      icon: '🔐', defaultPriority: 'high',   actionType: 'navigate',  category: 'approval' },
  task_created:        { label: 'Task Created',          icon: '📋', defaultPriority: 'normal', actionType: 'navigate',  category: 'task' },
  task_completed:      { label: 'Task Completed',        icon: '✅', defaultPriority: 'normal', actionType: 'navigate',  category: 'task' },
  task_review:         { label: 'Task Review',           icon: '👁️', defaultPriority: 'normal', actionType: 'navigate',  category: 'task' },
  task_failed:         { label: 'Task Failed',           icon: '❌', defaultPriority: 'high',   actionType: 'navigate',  category: 'task' },
  requirement_created: { label: 'Requirement Proposed',  icon: '📝', defaultPriority: 'high',   actionType: 'navigate',  category: 'task' },
  requirement_decision:{ label: 'Requirement Decision',  icon: '⚖️', defaultPriority: 'normal', actionType: 'navigate',  category: 'task' },
  agent_report:        { label: 'Agent Report',          icon: '📊', defaultPriority: 'normal', actionType: 'none',      category: 'agent' },
  system:              { label: 'System',                icon: '⚙️', defaultPriority: 'normal', actionType: 'none',      category: 'system' },
};
