import {
  createLogger,
  generateId,
  MAILBOX_QUEUED_TTL_MS,
  TRIAGE_STALE_INFO_TTL_MS,
  buildDeliveryEnvelope,
  parseEnvelope,
  agentAddressRef,
  platformOriginRef,
  canTransitionSignal,
  catchAllTargetOf,
  isBounceReason,
  isKnownSignalStatus,
  normalizeSignalStatus,
  resolveEnvelopeTarget,
  type ActiveBounceReason,
  type AddressRef,
  type DeliveryEnvelope,
  type MailboxIntent,
  type MailboxItem,
  type MailboxItemType,
  type MailboxPayload,
  type MailboxItemMetadata,
  type MailboxItemRuntime,
  type MailboxItemStatus,
  type MailboxPriority,
  type SignalAddressLookup,
  MAILBOX_TYPE_REGISTRY,
  resolveEntityKeys,
  isStrictStateItem,
  routeMailboxItem,
} from '@markus/shared';
import type { EventBus } from './events.js';
import { bumpMergeCount, displayLabelOf } from './mailbox-summary.js';

const log = createLogger('mailbox');

/**
 * Thrown by `dequeueAsync` when it is woken by `cancelWait()` with an empty
 * queue.  This is the normal shutdown signal — callers should catch and exit.
 */
export class MailboxCancelledError extends Error {
  constructor() {
    super('Mailbox wait cancelled');
    this.name = 'MailboxCancelledError';
  }
}

/** Derived from the centralised MAILBOX_TYPE_REGISTRY in @markus/shared. */
const DEFAULT_PRIORITY: Record<MailboxItemType, MailboxPriority> = Object.fromEntries(
  Object.entries(MAILBOX_TYPE_REGISTRY).map(([k, v]) => [k, v.policy.priority]),
) as Record<MailboxItemType, MailboxPriority>;

/**
 * 认领租约默认 TTL（P0）。worker 认领 item 后持有租约；处理期间需**续租**，
 * 否则租约到期该项会被其它 worker 回收重认领（防崩溃/超时永久占位）。
 *
 * 取值须显著大于单次工具调用耗时、且大于续租间隔（见 attention 的续租定时器），
 * 以免长任务被误回收成重复处理。
 */
export const MAILBOX_LEASE_TTL_MS = 15 * 60_000;

/** 续租间隔 = TTL 的 1/3（留两次失败重试余量）。 */
export const MAILBOX_LEASE_RENEW_INTERVAL_MS = Math.floor(MAILBOX_LEASE_TTL_MS / 3);

// 「每 (task, round) 至多一条」不再是这里的私有集合：它已下沉到
// MAILBOX_TYPE_REGISTRY[type].policy.dedupePerRound，由 routeMailboxItem() 统一裁决
// （唯一决策点）。见 @markus/shared `routeMailboxItem`。

/**
 * 单播唤醒类型（P1 · 根因 #3）：这类 item 语义上「一次事件只需一个 worker 处理」，
 * 入队时**只唤醒恰好一个** idle waiter，而不是广播唤醒全部。
 *
 * 为什么：`review_request` 被投递给同一个 agent 的多个并发 worker 时，广播会让
 * N 个 worker 同时醒来自相竞争同一 item，败者「让位」后空转（实测 3 分身互让 + PM 4 轮裁决）。
 * 单播把「竞争」前移到唤醒选择处，从源头消除无谓唤醒。
 */
const UNICAST_WAKE_TYPES: ReadonlySet<MailboxItemType> = new Set<MailboxItemType>([
  'review_request',
]);

/**
 * P2 可观测事件名（结构化日志）。
 *
 * 仅日志、无指标后端：每条日志都带稳定的 `event` 字段与可加总的计数字段，
 * 可直接用 `grep` / 日志聚合按 `event` 计数得到「竞争次数 / 丢弃重复投递数」。
 */
export const MAILBOX_OBSERVABILITY_EVENTS = {
  /** 认领竞争：候选已被其它 worker / 实例认领，本次认领失败并让位。 */
  claimContested: 'mailbox.claim_contested',
  /** 认领通道异常（持久层抛错）→ 保守放行（fail-open）。 */
  claimError: 'mailbox.claim_error',
  /** 租约过期重放：过期租约被回收、item 退回 queued 后可被重新认领。 */
  leaseExpiredReplay: 'mailbox.lease_expired_replay',
  /** 处理中丢失租约（被回收或转手）→ 本实例已不是合法认领者。 */
  leaseLost: 'mailbox.lease_lost',
  /** 重复投递被丢弃：幂等键（items 唯一键 / 入队幂等键）拦截，未入队。 */
  duplicateDeliveryDropped: 'mailbox.duplicate_delivery_dropped',
  /**
   * 信号退信并归集到 catch-all（第六刀 C5 补入）。
   *
   * 为什么需要它：这条日志此前复用了 `duplicateDeliveryDropped`，于是「陈旧信号过期 /
   * 心跳折叠 / 报文缺字段 / 操作员丢弃」全都记成同一个「重复投递被拒」——事件名在撒谎，
   * 按 event 聚合得到的「重复投递数」是个混合口径。现在起：`duplicate*` 只描述真正的
   * 重复投递，本条描述其余全部退信，真实原因看 `dropReason` 字段。
   */
  signalBounced: 'mailbox.signal_bounced',
  /**
   * 重投复用原行回队（P1.x (a)(R6)）：同键冲突但既有行未收口（`dropped`/`failed`）
   * 或调用方显式交还在飞项 → 复用原行回队，**不新增行**。
   * count=1（按 event 求和 = 累计补偿重投数）。
   */
  deliveryReinjected: 'mailbox.delivery_reinjected',
  /** 单播唤醒：从多个 idle waiter 中确定性选出恰好一个。 */
  unicastWake: 'mailbox.unicast_wake',
} as const;

/**
 * 幂等键（P0 · 根因 #5）：`agent_id + source_type + task_id + round` 的后三段。
 * `agent_id` 由持久层的唯一索引列承担，本函数返回 `sourceType:taskId:round`。
 *
 * 返回 `undefined` 表示**不加约束**（类型不在作用域内，或缺少 taskId/round）。
 */
export function mailboxDedupKey(
  item: Pick<MailboxItem, 'sourceType' | 'payload' | 'metadata'> & {
    envelope?: Pick<DeliveryEnvelope, 'intent'>;
    round?: number;
  },
): string | undefined {
  return routeMailboxItem(item).dedupeKey;
}

/**
 * 投递来源 —— 投递点**真正知道**的那几件事（第六刀 §2.3）。
 *
 * 为什么不是把整份信封交给调用方：信封是「谁发给谁」的完整身份头，其中 `to`
 * 由 mailbox 自己知道（就是本 agentId），`signalClass` 由注册表派生，`intent`
 * 由调用方用结构化参数给出。让三个投递点各拼一份完整信封，就是三份形状定义。
 */
export interface DeliveryOrigin {
  /** 谁发的。`agent:<id>` / `im:<platform>:<user>` / 邮件地址，均只从 shared 构造点构造。 */
  from: DeliveryEnvelope['from'];
  /**
   * 平台内唯一 id（外部邮件 = RFC Message-ID）。缺省用本 item 的 `mbx_*` id。
   * 提供它就让「同一条外部消息投两次」在结构上只能落一行（V5）。
   */
  messageId?: string;
  /** 因果链（In-Reply-To / References 等价物）；只读保存，不参与路由/去重。 */
  externalThreadRef?: string | null;
  /** `from` 是否已验证（只有 `kind='external'` 有意义）；本卡恒 false。 */
  fromVerified?: boolean;
  /** 展示摘要；缺省用 `payload.summary`。 */
  subject?: string;
  /**
   * 收件人地址（第六刀 C3）：投递点声明的目标。缺省 = 本 agent（mailbox 自己知道收件人）。
   *
   * 声明它就让 `resolve(envelope)` 成为唯一解析器：解析不到 → 退信（`no_active_target` /
   * `unresolved_address`），而不是“暂存到当前 agent 算了”。结构上避免“错投给能收的人”。
   */
  to?: AddressRef;
}

export interface EnqueueOptions {
  priority?: MailboxPriority;
  metadata?: MailboxItemMetadata;
  /**
   * 投递意图（结构化）：`deliver`（默认）/ `trigger_execution` / `action_required`。
   * 取代 `payload.extra.triggerExecution` / `extra.actionRequired` 两个布尔推断。
   */
  intent?: MailboxIntent;
  /** 轮次（结构化）：幂等键 `(sourceType, taskId, round)` 的输入。 */
  round?: number;
  /**
   * 第七刀 C7-A：本条投递所属的 WorkUnit ref（`work_units.ref`）。
   *
   * 只在 WU 已存在时传；缺省 `undefined` = 不挂身份（旧行为）。
   */
  workUnitRef?: string | null;
  /** 投递来源（谁发的 / 外部 messageId）；缺省 = 平台自身（`noreply@`）。 */
  origin?: DeliveryOrigin;
  /**
   * In-process runtime callbacks (never persisted — see `MailboxItemRuntime`).
   * Persistence serializes only `payload` + `metadata`, so callbacks here cannot
   * reach the database.
   */
  runtime?: MailboxItemRuntime;
  /**
   * P1.x (a)(R2)：调用方明确声明「我正在交还这一条既有行」——停停机重投 / 崩溃恢复时，
   * 该 item 的持久行正是「本实例刚取走、未处理完就停机」的那一条。
   *
   * 传入后：跳过入队合并 + 命中既有行时走 **复用原行回队**（不新增行、不触发唯一键
   * 拒绝），而不是被「同键 → 幂等抑制」拦下（后者会让该行永远停在 `processing`）。
   */
  reuseItemId?: string;
}

export interface MailboxPersistence {
  /**
   * 持久化一个新 item。`dedupKey` 非空时，持久层须以 `(agent_id, dedupKey)` 唯一约束
   * 拒绝重复插入（P0 幂等键，根因 #5）——重复投递不产生第二行、不被重载/重投。
   *
   * @returns `false` = 本次插入被唯一键拒绝（= 重复投递，调用方**不得入队**）；
   *          `true` / `undefined`（旧实现或未接线）= 已落库。
   */
  save(item: MailboxItem, dedupKey?: string): void | boolean;
  /**
   * 第六刀 C2（V5）：按 `(agent, messageId)` 查既有的**非退信**行（只读最小字段）。
   * 未实现时跳过 messageId 幂等判定（旧持久层降级，行为同 C2 之前）。
   */
  findByMessageId?(agentId: string, messageId: string): MailboxExistingRow | undefined;
  /**
   * 第六刀 C2（§2.5）：把一次**没投进去**的投递写成 `status='bounced'` 的结构化退信行。
   *
   * 为什么必须落行而不是只写日志：旧实现把「没投进去」写成 `dropped` 终态，
   * 真实库 ≥28621 行没有任何回声，人被静默丢弃。退信必须可查、可按原因聚合。
   * catch-all 归集（`bounce_target`）是 C3 的事，本卡只保证「原因可查」。
   */
  saveBounced?(item: MailboxItem, dropReason: string): void;
  /** C3：`message_route(messageId)` 只读取证入口。未实现 ⇒ 工具不注册。 */
  findRouteByMessageId?(agentId: string, messageId: string): unknown[];
  /** C3：catch-all 概览只读。未实现 ⇒ 工具不注册。 */
  listCatchAll?(agentId: string, limit?: number): unknown;
  /**
   * C3：读一行的当前状态（ghost 路径用）。
   *
   * 行不在内存队列时，`drop()` 没有 `from` 状态就无法让矩阵裁决。没有这个读口，
   * 它只能“假定 queued”盲写：一个已收口（completed）的行会被鬼影 drop 重写成退信行，
   * 同一事实被第二次写坏。未实现 ⇒ 退回旧行为（只靠执行点的原因/桶校验）。
   */
  getStatus?(itemId: string): MailboxItemStatus | undefined;
  updateStatus(itemId: string, status: MailboxItemStatus, extra?: Partial<MailboxItem>): void;
  /** C3：陈旧 `processing` 行结案 → `bounced(drop_reason='lease_expired')`。
   *  When `currentOwnerId` is supplied, rows claimed by a DIFFERENT instance are also
   *  treated as stale (a dead instance's claim must not be "respected" merely because its
   *  lease has not expired yet). */
  markStaleProcessingAsBounced?(agentId: string, nowIso?: string, currentOwnerId?: string): number;
  /** Load persisted queued items for this agent (for recovery on restart). */
  loadQueued?(agentId: string): MailboxItem[];
  /** Load persisted deferred items for this agent (for auto-resurface). */
  loadDeferred?(agentId: string): MailboxItem[];
  /**
   * 原子认领（P0 · 根因 #2）：把 item 由 `queued` 迁移到 `processing`，同时写入
   * 认领者与租约。**语义等价于**：
   * `UPDATE ... SET status='processing', started_at=?, claimed_by=?, lease_until=?
   *    WHERE id=? AND status='queued'
   *      AND (claimed_by IS NULL OR lease_until < ?)`
   * 返回 `true` 仅当**本次调用是唯一胜者**（changes === 1）。
   * 未实现时 mailbox 退化为「本地即胜」（旧行为，保持向后兼容）。
   */
  claimItem?(itemId: string, ownerId: string, leaseUntil: string, startedAt: string): boolean;
  /** 续租：仅当当前认领者仍是 `ownerId` 且该项处于 `processing` 时成功。 */
  renewLease?(itemId: string, ownerId: string, leaseUntil: string): boolean;
  /** 释放认领（完成 / 丢弃 / 合并 / 回队时调用）。对非本人认领的项为 no-op。 */
  releaseClaim?(itemId: string, ownerId: string): void;
  /**
   * P1.x (a)(b)(d)（最小写 API）：**无条件**把既有行回队（不校验认领者）。
   *
   * 语义 = `status='queued'` + 清 `claimed_by`/`lease_until`/`started_at`/`completed_at`
   * + **刷新 `queued_at`**，一条 SQL 覆盖 (a) 复用原行 / (b) 刷新 TTL 基准 / (d) 启动回队。
   * **不得用 `releaseClaim` 代替**：其 `WHERE id=? AND claimed_by=?` 在重启后的新实例上
   * 因 `ownerId` 已变而 0 changes（静默 no-op）。
   *
   * @returns true = 命中并已回队；false = 行不存在 / 状态不允许回队。
   *          未实现时 mailbox 退化为 `updateStatus(id,'queued')`（不含 `queued_at` 刷新）。
   */
  requeueItem?(itemId: string, options?: { queuedAt?: string }): boolean;
  /**
   * P1.x (c)（最小只读 API）：按幂等键查询既有行（仅判定所需最小字段）。
   *
   * 没有它就无法区分「已在飞 → 抑制」与「已 dropped/failed 但该轮未收口 → 允许补偿重投」。
   * 未实现时 mailbox 退化为 P0 行为（仅依赖 `save()` 返回 false 一律拒重）。
   */
  findByDedupKey?(agentId: string, dedupKey: string): MailboxExistingRow | undefined;
  /**
   * 回收过期租约（P0）：把 `processing` 且租约已过期的 item 退回 `queued`
   * （清空 claimed_by / lease_until / started_at），返回回收条数。
   * 使崩溃或超时的 worker 不会永久占位。
   */
  releaseExpiredLeases?(agentId: string, nowIso: string): number;
}

/** P1.x (c)：既有行在判定中需要的最小字段集（与 storage `MailboxDedupRow` 同形）。 */
export interface MailboxExistingRow {
  id: string;
  status: string;
  claimedBy?: string | null;
  leaseUntil?: string | null;
  queuedAt?: string;
}

/** P1.x (c)：重投/回投的三态判定结果。 */
export type ReinjectDecision =
  /** 行不存在 → 正常插入（新行）。 */
  | { action: 'insert' }
  /** 行存在但不得复用（在飞 / 已收口）→ 幂等抑制，返回既有行状态。 */
  | { action: 'suppress'; itemId: string; status: string; reason: 'in-flight' | 'settled' }
  /** 行存在且可补偿重投 → **复用原行回队**（不新增行）。 */
  | { action: 'reuse'; itemId: string };

/**
 * P1.x (c) · 幂等键命中后「新增 / 抑制 / 复用原行回队」的**唯一判定实现**（全库只此一处）。
 *
 * `mailbox.enqueue`（投递/冲突分支）与 `attention.ts` 停机重投（经
 * `mailbox.reEnqueueOnShutdown` → `enqueue({reuseItemId})`）**共用本函数**，
 * 禁止在别处内联同一判定（唯一例外：`enqueue` 内 `save()===false` 的竞态兜底）。
 *
 * 判定只依赖「既有行状态 + 调用方意图」，不读内存态（重启后内存队列为空，猜不得）。
 *
 *  - 行不存在 → `insert`（正常插入）；
 *  - 调用方声明 `explicitReuseId === 既有行 id`（停机重投：该行就是刚被本实例取走、
 *    未处理完的项）→ 一律 `reuse`；**即使其状态是 `processing`** —— 否则同键冲突会让
 *    这条在飞项永远停在 `processing`（直到租约过期甚至被 `MAILBOX_QUEUED_TTL_MS` 判死）；
 *  - 状态 ∈ {`bounced`,`failed`} / 历史 `dropped`（未收口终态）→ `reuse`（R6：丢消息后可补偿重投）；
 *    注意 `dropped` 已不是当前取值域（C3 删终态），这里只对**历史行**的读做兼容；
 *  - 状态 `catch_all`（已归集到概览、等人认领）→ `suppress(settled)`：再投一次会让同一条
 *    信号在概览里出现两次（违反「恰好可见一次」）；人认领走 `catch_all → queued`；
 *  - 状态 ∈ {`completed`,`merged`}（已收口 / 已合并）→ `suppress(settled)`（重投会重复执行）；
 *  - 其余（`queued` / `processing` / `deferred` / 未知）→ `suppress(in-flight)`（保守：宁延迟不重复）。
 */
export function resolveReinjectDecision(
  existing: MailboxExistingRow | undefined,
  intent?: { explicitReuseId?: string },
): ReinjectDecision {
  if (!existing) return { action: 'insert' };

  if (intent?.explicitReuseId && intent.explicitReuseId === existing.id) {
    return { action: 'reuse', itemId: existing.id };
  }

  // `dropped` 只为历史行（存盘早于 C3）读兼容：归一语义上它就是 bounced。
  if (existing.status === 'dropped' || existing.status === 'bounced' || existing.status === 'failed') {
    return { action: 'reuse', itemId: existing.id };
  }
  if (existing.status === 'completed' || existing.status === 'merged' || existing.status === 'catch_all') {
    return { action: 'suppress', itemId: existing.id, status: existing.status, reason: 'settled' };
  }
  return { action: 'suppress', itemId: existing.id, status: existing.status, reason: 'in-flight' };
}

/**
 * 持久化行 → 结构化字段（**唯一一处**）。
 *
 * C2 之前落库的行没有 `envelope` / `intent` / `round` 列（值为 NULL）。这些行的语义
 * （任务执行指令、评审轮次）必须继续成立，否则 resurface 后一个真实任务会被当成
 * 信息类信号 → 任务永久卡死。就在这里解码**一次**，下游只看到结构字段。
 *
 * **移除条件**：一旦真实库里 `envelope IS NULL` 的 mailbox_items 行数为 0（C4 实测后）。
 */
export function rehydrateStructuredFields(row: {
  id: string;
  agentId: string;
  sourceType: MailboxItemType;
  envelope?: string | null;
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}): { envelope?: DeliveryEnvelope; round?: number } {
  const payload = (row.payload ?? {}) as unknown as MailboxPayload;
  const extra = (payload.extra ?? {}) as Record<string, unknown>;
  const legacyRoundRaw = extra['round'] ?? row.metadata?.['round'];
  const round = typeof legacyRoundRaw === 'number' && Number.isFinite(legacyRoundRaw)
    ? legacyRoundRaw
    : undefined;

  const stored = parseEnvelope(row.envelope);
  if (stored) return { envelope: stored, round };

  // 旧行：无信封。只在这里从载荷解码 intent（trigger_execution / action_required），
  // 并用 item id 做 messageId（永不自撞，不会把历史行误判成重复投递）。
  const legacyIntent: MailboxIntent = extra['triggerExecution'] === true
    ? 'trigger_execution'
    : extra['actionRequired'] === true
      ? 'action_required'
      : 'deliver';
  const route = routeMailboxItem({ sourceType: row.sourceType, payload, metadata: row.metadata as MailboxItemMetadata | undefined, round });
  log.warn('Mailbox row has no envelope — rehydrated from payload (pre-C2 row)', {
    itemId: row.id, agentId: row.agentId, sourceType: row.sourceType, legacyIntent,
  });
  return {
    round,
    envelope: buildDeliveryEnvelope({
      from: platformOriginRef(),
      to: agentAddressRef(row.agentId),
      messageId: row.id,
      signalClass: route.signalClass,
      intent: legacyIntent,
      subject: typeof payload.summary === 'string' ? payload.summary : '',
    }),
  };
}

/**
 * Priority queue mailbox for an individual agent.
 * Items are ordered by priority (lower number = higher priority), then by arrival time (LIFO
 * within the same priority so the most recent message is processed first).
 * Emits 'mailbox:new-item' on the EventBus whenever a new item is enqueued,
 * which the AttentionController listens to for event-driven interrupts.
 */
export class AgentMailbox {
  private queue: MailboxItem[] = [];
  private readonly agentId: string;
  private readonly eventBus: EventBus;
  private persistence?: MailboxPersistence;
  /**
   * 本实例唯一认领者标识（P0）。跨进程 / 跨会话唯一，用于原子认领与租约归属校验：
   * 只有 `claimed_by` 与它相等时，本实例才能续租 / 释放 / 完成该项。
   */
  private readonly ownerId: string;
  /** 租约 TTL；可通过 `setLeaseTtlMs()` 覆盖（测试用）。 */
  private leaseTtlMs: number = MAILBOX_LEASE_TTL_MS;
  /**
   * Idle waiters — one per concurrently-dequeuing attention worker.
   * Multi-consumer: enqueue / unlock wake ALL waiters; each then re-dequeues
   * and `shift`-style selection keeps items exclusive. Single-waiter in
   * serial mode — exactly the old behavior.
   */
  private idleWaiters = new Set<() => void>();
  /** 实体亲和锁：entityKey → holder（处理中的 mailbox item id）。同一实体永不并发。 */
  private entityLocks = new Map<string, string>();
  /**
   * Set by cancelWait(): waiting dequeueAsync calls should exit with
   * MailboxCancelledError. Cleared on any real wakeup (enqueue/unlock),
   * so spurious broadcast wakes that lose the item race keep waiting.
   */
  private cancelPending = false;
  /**
   * 追踪当前正在被 worker 处理的心跳 item id（dequeue 后该项不在 this.queue 里了，
   * 无法用 queue.find 找到）。用于入队时折叠"正在跑的心跳还没结束就又触发"的
   * 场景——否则两条心跳会背靠背执行（间隔仅数秒），浪费 token + 垃圾会话。
   */
  private _processingHeartbeatId: string | undefined;

  constructor(agentId: string, eventBus: EventBus, persistence?: MailboxPersistence) {
    this.agentId = agentId;
    this.eventBus = eventBus;
    this.persistence = persistence;
    // 认领者唯一标识：agentId + 进程 pid + 进程内自增序号。
    // 用 pid 区分进程、自增序号区分同进程内多实例（测试常在一个进程内造多个 mailbox）。
    this.ownerId = `${agentId}#${typeof process !== 'undefined' ? process.pid : 0}#${AgentMailbox.nextOwnerSeq()}`;
  }

  /** 进程内自增，保证同一进程内多个 AgentMailbox 实例的 ownerId 互不相同。 */
  private static ownerSeq = 0;
  private static nextOwnerSeq(): number {
    return ++AgentMailbox.ownerSeq;
  }

  /** 本实例的认领者标识（诊断 / 测试用）。 */
  getOwnerId(): string {
    return this.ownerId;
  }

  /** 覆盖租约 TTL（毫秒）；测试用于快速验证过期回收。 */
  setLeaseTtlMs(ms: number): void {
    this.leaseTtlMs = Math.max(1, Math.floor(ms));
  }

  getLeaseTtlMs(): number {
    return this.leaseTtlMs;
  }

  setPersistence(p: MailboxPersistence): void {
    this.persistence = p;
  }

  /** 第六刀 C3：地址簿只读端口（`resolve(envelope)` 的唯一输入）。未接线 ⇒ 只认 `agent:` 直达。 */
  private addressLookup?: SignalAddressLookup;

  setAddressLookup(lookup: SignalAddressLookup): void {
    this.addressLookup = lookup;
  }

  /**
   * 投递状态机的**唯一执行点**（第六刀 §2.5 / FSM-2）。
   *
   * 所有信号状态变更——`bounce()`、陈旧清理、合并、回队——都必须走这里。它同时做三件
   * 不可拆的事，拆开就会出现「状态正确但原因缺失」的中间态：
   *  1. **矩阵校验**：`canTransitionSignal(from, to)` 不合法就拒绝 + 可行动日志；
   *  2. **退信必带原因**：`to='bounced'` 时 `dropReason` 必填且在闭集内；
   *  3. **归集必带桶**：`to='catch_all'` 时 `bounceTarget` 必填。
   *
   * `from` 未知（行不在内存：ghost / 已出队）时只跳过矩阵校验，原因/桶的强制校验照旧。
   */
  private updateSignalStatus(
    item: MailboxItem | { id: string; status?: MailboxItemStatus },
    to: MailboxItemStatus,
    opts: {
      dropReason?: ActiveBounceReason;
      bounceTarget?: string;
      extra?: Partial<MailboxItem>;
      why?: string;
      /**
       * 显式 `from`：调用方已读过**真实持久状态**（`getStatus`）时用它，
       * 而不是内存副本上的 `item.status`。
       *
       * 为什么必须有这条通道：内存副本会过期（ghost / 已被别处收口）。拿过期副本
       * 当 `from`，会让一条 `completed` 行被本地的 `processing` 覆盖 —— 那正是
       * 「同一事实被第二次写坏」，矩阵拦不住它，因为它看到的是一个假 `from`。
       */
      from?: MailboxItemStatus;
    } = {},
  ): boolean {
    const from = opts.from ?? (item as MailboxItem).status;
    if (from && !canTransitionSignal(from, to)) {
      log.error('Illegal mailbox signal transition refused', {
        agentId: this.agentId,
        itemId: item.id,
        from,
        to,
        reason: opts.why ?? '',
      });
      return false;
    }
    if (to === 'bounced' && (!opts.dropReason || !isBounceReason(opts.dropReason))) {
      log.error('Bounce refused — drop_reason is required and must be in the closed set', {
        agentId: this.agentId,
        itemId: item.id,
        dropReason: opts.dropReason ?? null,
      });
      return false;
    }
    if (to === 'catch_all' && !opts.bounceTarget) {
      log.error('Catch-all collection refused — bounce_target is required', {
        agentId: this.agentId, itemId: item.id,
      });
      return false;
    }

    const next = item as MailboxItem & { status: MailboxItemStatus };
    next.status = to;
    if (opts.dropReason) next.dropReason = opts.dropReason;
    if (opts.bounceTarget) next.bounceTarget = opts.bounceTarget;
    if (opts.extra) Object.assign(next, opts.extra);

    this.persistence?.updateStatus(item.id, to, {
      ...(opts.extra ?? {}),
      ...(opts.dropReason ? { dropReason: opts.dropReason } : {}),
      ...(opts.bounceTarget ? { bounceTarget: opts.bounceTarget } : {}),
    } as Partial<MailboxItem>);
    return true;
  }

  /**
   * **同状态字段写**（payload / priority / retryCount / mergeCount）：不改状态。
   *
   * 为什么必须单独一个口，而不是复用 `updateSignalStatus`：合并 survivor、改优先级
   * 这类操作**没有发生迁移**，硬塞一个 `to = from` 会让守卫无法区分「迁移动了状态」
   * 与「只是把合并后的 payload 落库」。显式命名之后，架构守卫只放行两处落库点
   * （本方法 + `updateSignalStatus`），第三处即红。
   *
   * 前置条件（调用方保证）：`fields` 里**不含** `status`；本方法原样写回当前状态。
   */
  private updateFields(item: MailboxItem, fields: Partial<MailboxItem>): void {
    this.persistence?.updateStatus(item.id, item.status, fields);
  }

  /**
   * **投影**（不落库的终态标记）：把**从未持久化**的行对象标成退信，供调用方读取。
   *
   * 为什么它不算“绕过矩阵”：这两条路径（幂等抑制 / messageId 重复）的 item 根本
   * 没有落库行（或被 `saveBounced` 单独插入），这里改的是**返回值投影**，不是任何
   * 已存在行的迁移。把它们集中在具名方法里，守卫才能把“投影”与“迁移”分开判定，
   * 而不是把内存赋值一律当违规。
   */
  private projectBounced(item: MailboxItem, dropReason: ActiveBounceReason): void {
    item.status = 'bounced';
    item.dropReason = dropReason;
  }

  /**
   * **投影**：原子认领（`claimItem`）已在 DB 内完成 `queued → processing`，
   * 并把 `started_at / claimed_by / lease_until` 一并写入；这里只把内存副本对齐。
   *
   * 与 `updateSignalStatus` 的分工：那一处是**内存 → DB** 的写者（矩阵在前）；
   * 这一处是**DB → 内存**的回写（矩阵已在调用侧的闸门判决过）。把两者写成同一个
   * 函数会让“到底谁在写库”变成注释题目 —— 而守卫要的是一个可判定的名字。
   */
  private projectClaimed(item: MailboxItem, startedAt: string): void {
    item.status = 'processing';
    item.startedAt = startedAt;
  }

  /**
   * **投影**：回队的持久写已由 `requeueItem`（原子 SQL，清认领 + 刷 `queued_at`）完成，
   * 这里只把内存副本对齐。矩阵在 `putBack()` 里预先裁决。
   */
  private projectRequeued(item: MailboxItem, queuedAt: string): void {
    item.status = 'queued';
    item.startedAt = undefined;
    item.claimedBy = undefined;
    item.leaseUntil = undefined;
    item.queuedAt = queuedAt;
  }

  /**
   * 从内存副本提取「可持久化字段」（storage.updateStatus 只认这几列）。
   *
   * 存在的理由：老的旁路写法把整个 item 当 extra 传下去（`updateStatus(id,'queued',item)`），
   * 读代码的人以为 payload / metadata 也落了库 —— 实际只落了 priority / retryCount
   * 那几列。把投影写成一个具名函数，行为不变而「到底写了什么」变得可读、可审。
   */
  private persistableFields(item: MailboxItem): Partial<MailboxItem> {
    return { priority: item.priority, retryCount: item.retryCount };
  }

  /**
   * 退信（第六刀 §2.5）：记录 + 归集到 catch-all 概览。
   *
   * 两步都是真实迁移（`X → bounced` 然后 `bounced → catch_all`），都走唯一执行点；
   * 外部只看到**一行**终态 `catch_all`，带原因与桶 —— 概览里恰好可见一次。
   *
   * 保留 `bounced` 这一跳而不是直接写 `catch_all`：前者是「没投进去」的事实，
   * 后者是「已交给概览里的人」。压成一种态会让「已记录但未归集」变得不可表达。
   */
  private bounceSignal(
    item: MailboxItem,
    dropReason: ActiveBounceReason,
    why?: string,
  ): MailboxItem {
    const bounceTarget = catchAllTargetOf(this.agentId);
    const inQueue = this.queue.some(q => q.id === item.id);
    if (!inQueue) {
      // 新行（从未被队列持有）：INSERT 一条带原因的退信行。
      this.persistence?.saveBounced?.(item, dropReason);
    }
    this.updateSignalStatus(item, 'bounced', { dropReason, why });
    this.updateSignalStatus(item, 'catch_all', { bounceTarget, why });
    log.warn('Mailbox signal bounced and collected into catch-all', {
      event: MAILBOX_OBSERVABILITY_EVENTS.signalBounced,
      agentId: this.agentId,
      itemId: item.id,
      type: item.sourceType,
      messageId: item.envelope?.messageId,
      dropReason,
      bounceTarget,
      reason: why ?? '',
      count: 1,
    });
    this.eventBus.emit('mailbox:bounced', {
      agentId: this.agentId,
      itemId: item.id,
      sourceType: item.sourceType,
      dropReason,
      bounceTarget,
    });
    return item;
  }

  /** C3 工具面：按 messageId 取最近一次路由事实（只读）。 */
  routeOfMessage(messageId: string): unknown[] {
    return this.persistence?.findRouteByMessageId?.(this.agentId, messageId) ?? [];
  }

  /** C3 工具面：catch-all 概览（只读）。 */
  catchAll(): unknown {
    return this.persistence?.listCatchAll?.(this.agentId) ?? { items: [], legacyDropped: 0 };
  }

  /**
   * On startup:
   * 1. Mark any persisted items stuck in 'processing' as `bounced(lease_expired)`
   *    and collect them into the catch-all overview (C3: the `dropped` terminal is gone).
   * 2. Reload surviving 'queued' items into the in-memory queue.
   * Returns { bounced, restored, expired, merged }.
   */
  recoverStaleItems(): { bounced: number; restored: number; expired: number; merged: number } {
    // Pass our ownerId: on startup any pre-existing 'processing' row belongs to a dead
    // prior process, so a foreign claim is stale even if its lease still looks valid.
    // 第六刀 C3：返回字段名从 `dropped` 改为 `bounced` —— 它写的就是 bounced 行，
    // 叫 dropped 会让调用方以为还有那个终态。
    const bounced = this.persistence?.markStaleProcessingAsBounced?.(this.agentId, undefined, this.ownerId) ?? 0;

    let restored = 0;
    let expired = 0;
    const now = Date.now();
    const queuedItems = this.persistence?.loadQueued?.(this.agentId) ?? [];
    for (const item of queuedItems) {
      if (this.queue.some(q => q.id === item.id)) continue;

      const age = now - new Date(item.queuedAt).getTime();
      // Hard TTL for everything; informational/callback ghosts expire sooner so a
      // long-running agent does not keep replaying stale background completions.
      const ttl = routeMailboxItem(item).triageStaleDrop ? TRIAGE_STALE_INFO_TTL_MS : MAILBOX_QUEUED_TTL_MS;
      if (age > ttl) {
        // C3：过期不是“归档”——它是“没投出去且原因可查”（stale_signal）。
        this.bounceSignal(item, 'stale_signal', 'queued-ttl-expired');
        expired++;
        continue;
      }
      this.insertSorted(item);
      restored++;
    }

    // Post-recovery dedup: merge duplicate items that were queued separately
    // before restart. Also collapses redundant heartbeats to a single entry.
    const merged = this.deduplicateQueue();

    if (restored > 0 || expired > 0 || merged > 0) {
      log.info('Mailbox recovery from DB', {
        agentId: this.agentId,
        restored,
        expired,
        merged,
      });
    }
    // If the attention loop is already waiting, restored items must wake it.
    if (restored > 0) this.wakeIdleLoop();
    return { bounced, restored, expired, merged };
  }

  /**
   * Runtime self-healing: mark DB items stuck in 'processing' as
   * `bounced(lease_expired)` + catch-all. Called by the watchdog when no item is
   * being processed in memory.
   *
   * 语义修正（不再标 'completed'）：completed = 「Agent 明确正常结束」——
   * 卡住/被打断/超时的工作**不属于完成**，且 completed 会让 resolveReinjectDecision
   * 判定为 settled（抑制同键补偿重投），等于把未完成工作静默吞掉。
   * 改标 'bounced'（C3：原因 `lease_expired`，同时归集到 catch-all）：异常可见 +
   * 允许后续补偿重投（bounced → reuse）。
   * 除「无认领/租约空/租约过期」外，还传入本实例 ownerId：**认领者非本实例**的行也判
   * 陈旧（跨实例死认领 —— 被杀实例的 in-flight 行租约未到期也不会永远卡 processing）。
   * 单进程下每个 agent 只有一个 AgentMailbox（只有 `Agent` 构造器会 new），故不存在会
   * 被误杀的「其它存活实例」。strict-state 项会回队重试。
   */
  cleanStaleProcessing(): number {
    return this.persistence?.markStaleProcessingAsBounced?.(this.agentId, undefined, this.ownerId) ?? 0;
  }

  /**
   * Deduplicate the in-memory queue after bulk restoration.
   * - For task_comment: merge items with the same taskId.
   * - For requirement_comment: merge items with the same requirementId.
   * - For heartbeat: keep only the latest one and drop the rest.
   * Status updates are NOT merged (structurally different from comments).
   * Returns the number of items removed.
   */
  private deduplicateQueue(): number {
    let removed = 0;

    // 1. Collapse heartbeats: keep only the most recent queued heartbeat
    const heartbeatIndices: number[] = [];
    for (let i = 0; i < this.queue.length; i++) {
      if (this.queue[i].status === 'queued' && this.queue[i].sourceType === 'heartbeat') {
        heartbeatIndices.push(i);
      }
    }
    if (heartbeatIndices.length > 1) {
      // Keep the last (most recent) heartbeat, drop the rest
      for (let k = heartbeatIndices.length - 2; k >= 0; k--) {
        const idx = heartbeatIndices[k];
        const [item] = this.queue.splice(idx, 1);
        // C3：折叠掉的旧巡检不是静默消失——它在概览里留一行 stale_signal。
        this.bounceSignal(item, 'stale_signal', 'heartbeat-collapsed');
        removed++;
      }
    }

    // 2. Merge task comments by taskId (status updates stay separate)
    removed += this.mergeByEntity(
      AgentMailbox.TASK_COMMENT_DEDUP_TYPES,
      (item) => item.payload.taskId ?? item.metadata?.taskId as string | undefined,
    );

    // 3. Merge requirement comments by requirementId (updates stay separate)
    removed += this.mergeByEntity(
      AgentMailbox.REQ_COMMENT_DEDUP_TYPES,
      (item) => item.payload.requirementId,
    );

    // 4. Merge a2a_messages by channelKey (group chat coalescing)
    removed += this.mergeByEntity(
      AgentMailbox.CHANNEL_DEDUP_TYPES,
      (item) => item.payload.extra?.channelKey as string | undefined,
    );

    return removed;
  }

  /**
   * Merge queued items of the given types that share the same entity key.
   * The first item in queue order becomes the survivor; subsequent items
   * have their content appended and are then removed.
   */
  private mergeByEntity(
    eligibleTypes: ReadonlySet<MailboxItemType>,
    getKey: (item: MailboxItem) => string | undefined,
  ): number {
    let removed = 0;
    const seen = new Map<string, number>(); // entityKey → index of survivor in queue

    for (let i = 0; i < this.queue.length; i++) {
      const item = this.queue[i];
      if (item.status !== 'queued' || !eligibleTypes.has(item.sourceType)) continue;
      // 审计 P1-2：用统一 strict 谓词（4 类），而非只看 triggerExecution，否则
      // review_request / requirement_update[actionRequired] / workflow_update[actionRequired]
      // 会被同实体 informational item 合并吞掉。
      if (isStrictStateItem(item)) continue;

      const key = getKey(item);
      if (!key) continue;

      const survivorIdx = seen.get(key);
      if (survivorIdx === undefined) {
        seen.set(key, i);
        continue;
      }

      // Merge into survivor
      const survivor = this.queue[survivorIdx];
      survivor.payload.content += `\n\n---\n\n${item.payload.content}`;
      bumpMergeCount(survivor);
      // Elevate priority if the new item is higher priority
      if (item.priority < survivor.priority) {
        survivor.priority = item.priority;
      }
      // 合并是**同状态字段写**（内容/优先级变了，状态没变）——走字段口，不伪装成迁移。
      this.updateFields(survivor, this.persistableFields(survivor));

      // Remove the duplicate (mark as merged, not dropped — content is preserved in survivor)
      this.updateSignalStatus(item, 'merged', { extra: { mergedInto: survivor.id }, why: 'entity-merge' });
      this.queue.splice(i, 1);
      removed++;
      i--; // re-check same index since we spliced
    }

    return removed;
  }

  /**
   * Pre-triage consolidation: merge all queued items that share the same
   * taskId or requirementId into a single consolidated item, regardless
   * of sourceType.  This runs right before triage so the LLM sees one
   * consolidated item per entity instead of N scattered ones.
   *
   * Unlike enqueue-time dedup (which only merges same-type comments),
   * this cross-type merge produces a comprehensive context block:
   *   "[task_status_update] Task assigned → ...\n[a2a_message] Review ...\n[task_comment] ..."
   *
   * Returns the number of items removed.
   */
  consolidateByEntity(): number {
    let removed = 0;

    // Group by taskId
    removed += this.consolidateGroup(
      (item) => item.payload.taskId ?? (item.metadata?.taskId as string | undefined),
    );

    // Group by requirementId (only for items that don't also have a taskId)
    removed += this.consolidateGroup(
      (item) => {
        if (item.payload.taskId || item.metadata?.taskId) return undefined;
        return item.payload.requirementId;
      },
    );

    // Group the remaining a2a messages by **entity**, so the agent reads one
    // conversation thread instead of N separate items.
    //
    // C8-A：这是**呈现层合并**（为了一个线程读一次），不是并发/调度判定 ——
    // 那两件事由 `resolveEntityKeys()` 回答。既是呈现层，合并键就必须和实体一致：
    // 有 WorkUnit 的用 `work_unit_ref`（一件事一条），没有的（旧行 / 非 WU 链路）
    // 才退到 `channelKey`。
    //
    // 为什么不能只按 channelKey（旧写法）：同一频道里**两件不同的事**会被并成一条，
    // agent 只看到一段拼接文本，第二件事的执行理由消失；反过来同一件事经两个频道
    // 到达又不合并。两种错都由「用投递通道当实体」造成，与 C8-A 的根因同一个。
    removed += this.consolidateGroup(
      (item) => {
        if (item.sourceType !== 'a2a_message') return undefined;
        if (item.payload.taskId || item.metadata?.taskId) return undefined;
        if (item.payload.requirementId) return undefined;
        return item.workUnitRef ?? (item.payload.extra?.channelKey as string | undefined);
      },
      { skipProtectedCheck: true },
    );

    if (removed > 0) {
      log.info('Pre-triage consolidation', { agentId: this.agentId, merged: removed });
    }
    return removed;
  }

  /**
   * 预合并阶段**禁止合并**的类型（P1 · 根因 #4）。
   *
   * 这些 item 承载正式状态流转，被合并就会把它吞进 informational item 而丢失执行
   * （审计 dim2 M2：strict-state 项被 consolidateGroup 合并 → 评审可能永不执行）。
   * `review_request` 与 `human_chat` 同属「必须独立、完整走一次执行路径」的事件 ——
   * 与 @markus/shared `isStrictStateItem()` 的判定保持一致。
   */
  private static readonly CONSOLIDATION_PROTECTED_TYPES: ReadonlySet<MailboxItemType> = new Set([
    'human_chat',
    'review_request',
  ]);

  /**
   * 按 `getKey` 给出的实体键做**呈现层预合并**：队列里同键的 queued 项并成一条，
   * 让 LLM 一件事只读一次而不是读 N 条散件。
   *
   * 它**不**决定调度、不并发互斥、不改身份 —— 那三件事的唯一判定点是
   * `resolveEntityKeys()` / `routeMailboxItem()`。合并只动 `payload.content`，被并入
   * 的那条落 `merged` 终态并记 `mergedInto`，内容不会丢。
   *
   * （旧签名有个 `_groupType: string` 参数，三个调用点传 `'task'` / `'requirement'` /
   * `'channel'` 却从没人读 —— 它唯一的作用是让“按频道分组”看起来像一条规则。
   * C8-A 删掉它：分组读什么，只看 `getKey`。）
   */
  private consolidateGroup(
    getKey: (item: MailboxItem) => string | undefined,
    opts?: { skipProtectedCheck?: boolean },
  ): number {
    let removed = 0;
    const seen = new Map<string, number>();

    for (let i = 0; i < this.queue.length; i++) {
      const item = this.queue[i];
      if (item.status !== 'queued') continue;
      if (isStrictStateItem(item)) continue;
      if (!opts?.skipProtectedCheck && AgentMailbox.CONSOLIDATION_PROTECTED_TYPES.has(item.sourceType)) continue;

      const key = getKey(item);
      if (!key) continue;

      const survivorIdx = seen.get(key);
      if (survivorIdx === undefined) {
        seen.set(key, i);
        continue;
      }

      const survivor = this.queue[survivorIdx];
      const typeLabel = item.sourceType !== survivor.sourceType
        ? `[${item.sourceType}] ` : '';
      survivor.payload.content += `\n\n---\n\n${typeLabel}${item.payload.content}`;
      bumpMergeCount(survivor);
      if (item.priority < survivor.priority) {
        survivor.priority = item.priority;
      }
      this.updateFields(survivor, this.persistableFields(survivor));

      this.updateSignalStatus(item, 'merged', { extra: { mergedInto: survivor.id }, why: 'cross-type-consolidate' });
      this.queue.splice(i, 1);
      removed++;
      i--;
    }

    return removed;
  }

  /**
   * Add an item to the mailbox. Returns the item ID.
   * Emits 'mailbox:new-item' so the AttentionController can react.
   */
  // Enqueue-time dedup: only comments merge with other comments for the same entity.
  // Cross-type consolidation happens later in consolidateByEntity() before triage.
  private static readonly TASK_COMMENT_DEDUP_TYPES: ReadonlySet<MailboxItemType> = new Set([
    'task_comment',
  ]);
  private static readonly REQ_COMMENT_DEDUP_TYPES: ReadonlySet<MailboxItemType> = new Set([
    'requirement_comment',
  ]);
  private static readonly CHANNEL_DEDUP_TYPES: ReadonlySet<MailboxItemType> = new Set([
    'a2a_message',
  ]);

  enqueue(
    sourceType: MailboxItemType,
    payload: MailboxPayload,
    options?: EnqueueOptions,
  ): MailboxItem {
    // 投递意图 / 轮次：**结构化参数**，不再从 `payload.extra` 推断（R3'）。
    // 一次路由决策同时给出 strictState / affinity / dedupeKey / signalClass——
    // 信封的 signalClass 也来自这里，避免出现「第二个分类器」。
    const intent: MailboxIntent = options?.intent ?? 'deliver';
    const route = routeMailboxItem({
      sourceType,
      payload,
      metadata: options?.metadata,
      envelope: { intent },
      round: options?.round,
    });

    // 注意：显式复用（reuseItemId）不走内存合并 —— 调用方要求把**这一条在飞项**
    // 送回队列，若被合并进别的 item，原行会永远停在 processing（直到租约过期 / 被 TTL 判死）。
    // 合并进去的那条项的旧信封保留（合并的是内容，不是身份）。
    const reuseItemId = options?.reuseItemId;
    const merged = reuseItemId
      ? undefined
      : this.tryMergeIntoExisting(sourceType, payload, options?.workUnitRef ?? null);
    if (merged) {
      this.eventBus.emit('mailbox:new-item', { agentId: this.agentId, item: merged });
      this.wakeIdleLoop();
      return merged;
    }

    // ── 心跳折叠（C）─────────────────────────────────────────────────────────
    // 心跳是**幂等巡检**：队里已经有一条没被处理的巡检时，再来一条不产生任何新信息。
    //
    // 【为什么心跳特别容易造成并发空转】心跳项不带任何实体维度（没有 taskId /
    // requirementId / senderId / sessionId / channelKey），`resolveEntityKeys` 会退化成
    // `system:<agentId>` —— 这是**一把全局单键**。于是并发模式下所有 worker 抢同一把锁，
    // 抢不到就 putBack + 退避重试（见 concurrentWorkerLoop 的 conflict 分支）。实测同一
    // 分钟内堆 3 条心跳即产生 16 次 conflict；且每次成功处理都会**新开一个会话**。
    //
    // 【为什么是「折叠」而不是 tryMergeIntoExisting 的「合并」】合并会把
    // "Heartbeat triggered at …" 追加进 content —— 对巡检毫无信息量，纯噪声还会
    // 撑大上下文。这里直接保留既有那条、丢弃这次触发。
    //
    // 【安全阀】既有项若长期卡在 queued，会被 MAILBOX_QUEUED_TTL_MS（3 天）判死回收，
    // 之后新心跳即可正常入队 —— 不会因为折叠而永久吞掉巡检。
    //
    // 折叠 queued 队列中的心跳 + 正在 processing 的心跳：
    //   · queued   —— 队列里已有一条等着的，再入队纯浪费。
    //   · processing—— 有一个 worker 正在跑 LLM 心跳巡检；若此刻再入队，
    //                该 worker 一结束就会立刻取走新的一条 → 两条心跳背靠背执行
    //                （实测间隔仅 7~12 秒），白白消耗 token 且产生垃圾会话。
    //                丢失的这一次巡检会在下一个正常调度周期（小时级）自动补回，
    //                相比密集触发的 token 浪费完全可以接受。
    //
    // 注意：dequeue() 会把项从 this.queue 中 splice 掉，所以 processing 状态的项
    // 无法用 queue.find 找到。改用 _processingHeartbeatId 字段追踪。
    //
    // 【安全阀】既有项若长期卡在 processing/queued，会被 MAILBOX_QUEUED_TTL_MS
    // （3 天）判死回收，之后新心跳即可正常入队 —— 不会因为折叠而永久吞掉巡检。
    //
    // ⚠️ 必须同时判 `sourceType === 'heartbeat'`：漏了它就会在「队列里恰有一条心跳」时
    // 把**任何**类型的飞来件都当成重复心跳折叠掉（含 human_chat 用户消息）—— 这会静默
    // 吞消息，是本改动最危险的写法。测试 `心跳与其它类型共存时互不干扰` 专门守这条。
    if (
      !reuseItemId
      && sourceType === 'heartbeat'
      // 【不得折叠带动作的心跳】折叠保留既有那条、丢弃本次这条；若本次携带
      // actionRequired / directMention，折叠就等于静默丢掉一个待办动作 → 只折叠纯巡检心跳。
      // 旧读法 `extra.actionRequired` 已换成结构字段 `intent`（同样由入参决定）。
      && intent !== 'action_required'
      && payload.extra?.directMention !== true
    ) {
      const queuedHb = this.queue.find(
        i => i.sourceType === 'heartbeat' && i.status === 'queued',
      );
      const pendingHeartbeat = queuedHb ?? (this._processingHeartbeatId
        ? { id: this._processingHeartbeatId } as MailboxItem
        : undefined);
      if (pendingHeartbeat) {
        // 刻意 **不** emit 'mailbox:new-item'：队列内容没有任何变化，发「新项」事件会
        // 误导 triage / 中断抢占判定。只推一下 idle waiter，确保这条巡检会被取走。
        this.wakeIdleLoop();
        // 折叠时了结 incoming 的 responsePromise：投递方可能在 await（如测试的
        // processViaMailbox / 调度器的 triggerHeartbeat 返回值）。折叠 = 本次触发
        // 被在跑的巡检吸收，语义等价于「这次巡检不产生新结果」，必须显式 resolve，
        // 否则调用方永久挂起（参考 suppressDuplicateDelivery 的 Promise 了结约定；
        // 实测路径：HB 处理完 resolve 后、complete() 清 _processingHeartbeatId 前的
        // 窗口内再入队 HB → 被折叠 → 原实现让其 promise 悬挂 → 测试 10s 超时）。
        const foldedPromise = pendingHeartbeat.id === this._processingHeartbeatId
          ? options?.runtime?.responsePromise
          : undefined;
        if (foldedPromise) {
          try { foldedPromise.resolve('[heartbeat-collapsed]'); } catch { /* caller gone */ }
        }
        log.debug('Mailbox enqueue-time heartbeat collapse: duplicate suppressed', {
          agentId: this.agentId,
          existingId: pendingHeartbeat.id,
        });
        return pendingHeartbeat;
      }
    }

    const itemId = reuseItemId ?? generateId('mbx');
    // ── 信封：唯一装配点（第六刀 §2.1 / I4）──────────────────────────────
    // `to` 由 mailbox 自己知道（就是本 agent）；`signalClass` 来自唯一路由决策；
    // `from` / `messageId` 由投递点提供。因此每条新信号都必带信封，不存在第三条路径。
    const origin = options?.origin;
    const envelope: DeliveryEnvelope = buildDeliveryEnvelope({
      from: origin?.from ?? platformOriginRef(),
      to: origin?.to ?? agentAddressRef(this.agentId),
      messageId: origin?.messageId ?? itemId,
      signalClass: route.signalClass,
      intent,
      subject: origin?.subject ?? payload.summary,
      externalThreadRef: origin?.externalThreadRef ?? null,
      fromVerified: origin?.fromVerified ?? false,
    });

    // ── C3 / I3：唯一解析器 —— 收件人解析不出来就退信，绝不静默吞掉 ──────────────
    // 这是「没有第三种「悄悄丢掉」」的**执行点**：`resolve(envelope)` 只读信封
    // （`payload` / `sourceType` 在这个签名里根本拿不到，I2 是构造性的，不是靠自觉的）。
    // 三种失败都走同一条退信通道，区别只在原因：
    //  - 信封 `to` 没有 active 目标 → `no_active_target`
    //  - `to` 根本不是可投的内部地址（外部域 / 平台保留 / IM 身份）→ `unresolved_address`
    //  - `to` 解析到了**别的 agent** → 也是 `no_active_target`（本邮箱不是它的收件人；
    //    结构上不允许「错投给能收的人」）
    const resolution = resolveEnvelopeTarget(envelope, this.agentId, this.addressLookup);
    if (!resolution.matched || resolution.agentId !== this.agentId) {
      const bounced: MailboxItem = {
        id: itemId,
        agentId: this.agentId,
        sourceType,
        priority: options?.priority ?? DEFAULT_PRIORITY[sourceType],
        status: 'queued',
        payload,
        metadata: options?.metadata,
        envelope,
        round: options?.round,
        queuedAt: new Date().toISOString(),
        runtime: options?.runtime,
      };
      return this.bounceSignal(
        bounced,
        resolution.matched ? 'no_active_target' : resolution.reason,
        resolution.matched
          ? `addressed-to-other-agent:${resolution.agentId}`
          : `unresolved:${resolution.address}`,
      );
    }

    const item: MailboxItem = {
      id: itemId,
      agentId: this.agentId,
      sourceType,
      priority: options?.priority ?? DEFAULT_PRIORITY[sourceType],
      status: 'queued',
      payload,
      metadata: options?.metadata,
      envelope,
      round: options?.round,
      workUnitRef: options?.workUnitRef ?? null,
      queuedAt: new Date().toISOString(),
      runtime: options?.runtime,
    };

    // ── C2 / V5：同一条消息不得入队两次 ─────────────────────────────────
    // 幂等身份是 `envelope.messageId`（外部邮件 = RFC Message-ID；平台内 = 发送方给的 id）。
    // 命中既有非退信行 → 本次投递写一条 `duplicate_message_id` 退信行后返回，
    // 不产生第二条 queued（旧行为是静默“suppressed”，人看不到任何回声）。
    if (this.persistence?.findByMessageId) {
      const existing = this.persistence.findByMessageId(this.agentId, envelope.messageId);
      if (existing) return this.bounceDuplicateMessage(item, existing);
    }

    // P0 幂等键（根因 #5）：**先落库再入内存队列**。落库被唯一键拒绝（返回 false）
    // 即「同一 (agent, sourceType, taskId, round) 已投递过」——此时**不入队**，
    // 让「不产生重复投递」成为显式语义，而不是靠后续「无 DB 行 → 认领失败」间接兜住。
    const dedupKey = mailboxDedupKey(item);

    // P1.x (c)：先按幂等键读既有行状态，再走**唯一判定函数**（而非直接 `save()`）：
    // 这样才能区分「在飞 → 抑制」/「已 dropped 未收口 → 复用原行重投」/「已收口 → 拒」。
    if (dedupKey && this.persistence?.findByDedupKey) {
      const existing = this.persistedRowFor(dedupKey);
      if (existing) {
        const decision = resolveReinjectDecision(existing, { explicitReuseId: reuseItemId });
        if (decision.action === 'suppress') {
          return this.suppressDuplicateDelivery(item, sourceType, dedupKey, decision.status);
        }
        // insert / reuse 都交由同一回队实现：它先尝试按 id 回队（行存在 → 复用），
        // 行不存在时才退回正常插入。
        return this.reinjectExistingRow(item, dedupKey, decision.action === 'reuse' ? existing : undefined);
      }
    }
    // 显式交还在飞项（停机重投）但没有幂等键（如 a2a_message）：直接按原 id 回队。
    if (reuseItemId) return this.reinjectExistingRow(item, dedupKey);

    const persisted = this.persistence?.save(item, dedupKey);
    if (persisted === false) {
      // 竞态兜底（D3）：仅在「findByDedupKey 未实现（旧持久层）」或「查询→插入」之间的极小
      // 窗口内被并发插入时到达。停机重投的**主路径**已由上方的复用分支承担，不再是这里。
      return this.suppressDuplicateDelivery(item, sourceType, dedupKey);
    }

    this.insertSorted(item);

    log.debug('Mailbox enqueue', {
      agentId: this.agentId,
      itemId: item.id,
      type: sourceType,
      priority: item.priority,
      summary: displayLabelOf(payload, 80),
      depth: this.queue.length,
    });

    this.eventBus.emit('mailbox:new-item', { agentId: this.agentId, item });
    // P1：把「入队事件」的类型 + 路由键交给唤醒器，让其对单播类型只唤醒一个 waiter。
    this.wakeIdleLoop({ type: sourceType, key: AgentMailbox.unicastRouteKey(item) });

    return item;
  }

  /**
   * Wake all attention workers blocked in `dequeueAsync`.
   */
  private wakeIdleLoop(routeHint?: { type: MailboxItemType; key: string }): void {
    if (this.idleWaiters.size === 0) return;

    // P1 单播（根因 #3）：语义上「一次事件只需一个 worker」的类型只唤醒**恰好一个**
    // waiter。广播唤醒 N 个 worker 会让它们同时醒来自相竞争同一 item，败者让位后
    // 空转（实测 3 分身互让 + PM 连续 4 轮裁决）。
    //
    // 只当存在多个 waiter 时才需要单播；单 waiter 时广播 / 单播等价（走到下面的分支）。
    if (routeHint && UNICAST_WAKE_TYPES.has(routeHint.type)
      && this.idleWaiters.size > 1) {
      const waiters = [...this.idleWaiters];
      // 确定性路由：hash(taskId+round) % n —— 同一轮评审稳定落到同一 waiter，
      // 不依赖注册顺序、不用随机数（可复现、可断言）。
      const idx = AgentMailbox.hashKey(routeHint.key) % waiters.length;
      const target = waiters[idx]!;
      // 只把被选中的 waiter 移出在册集合并唤醒；**其余保持注册**（若一并移出而不
      // resolve，它们将永远不再被唤醒 = 死锁）。
      this.idleWaiters.delete(target);
      this.cancelPending = false;
      log.info('Mailbox unicast wake — exactly one waiter selected', {
        event: MAILBOX_OBSERVABILITY_EVENTS.unicastWake,
        agentId: this.agentId,
        type: routeHint.type,
        routeKey: routeHint.key,
        waiters: waiters.length,
        targetIndex: idx,
      });
      target();
      return;
    }

    const waiters = [...this.idleWaiters];
    this.idleWaiters.clear();
    // Real work arrived — cancel intent is void (stop → restart scenario).
    this.cancelPending = false;
    for (const resolve of waiters) resolve();
  }

  /**
   * 稳定字符串散列（FNV-1a 32bit）—— 单播路由用。
   * 纯函数：同一 key 恒返回同一值，使「哪个 waiter 被唤醒」可预测、可测试。
   */
  private static hashKey(key: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  /**
   * 单播路由键：优先 `(taskId, round)`（与幂等键同源），退化到幂等键 / item id。
   * 保证同一轮评审请求的路由键稳定。
   */
  private static unicastRouteKey(item: MailboxItem): string {
    const taskId = item.payload.taskId ?? (item.metadata?.taskId as string | undefined);
    // 结构字段（第六刀 C2）：载荷里的 `extra.round` / `metadata.round` 不再是事实来源 ——
    // 同一份「这是第几轮」若有两个读法，单播路由和幂等键就会给出不同答案。
    const round = item.round;
    if (taskId) return `${taskId}:r${round ?? '?'}`;
    return mailboxDedupKey(item) ?? item.id;
  }

  /**
   * Whether any queued item is currently runnable (i.e. not blocked by an
   * entity lock). Used to avoid waking workers on exclusively locked queues.
   */
  private hasRunnableItem(): boolean {
    return this.queue.some(it => it.status === 'queued' && !this.isItemEntityLocked(it));
  }

  /**
   * 实体亲和键**集合**：一个 item 可同时属于多个实体维度（如 human_chat 既是
   * `user:{senderId}` 又是 `conv:{sessionId}`），**全部**需要锁定。
   *
   * 作用域映射是**声明式**的 —— 由 `MAILBOX_TYPE_REGISTRY[type].policy.affinity`
   * 定义（见 @markus/shared `resolveEntityKeys`），而不是在这里硬编码 if 链，
   * 因此新增 mailbox 类型不会静默绕过并发保护。
   *
   * 返回值恒为非空数组：无法解析出具体实体时退化为 `['system:{agentId}']`
   * （同 Agent 内串行），即「未知 = 保守串行」而非「未知 = 完全并发」。
   */
  entityKeysOf(item: MailboxItem): string[] {
    return resolveEntityKeys(item, this.agentId);
  }

  /**
   * 主实体键（用于日志 / 交接记录 / 冲突提示）。
   * 加锁请用 `entityKeysOf` + `lockEntities`，否则会漏掉其他实体维度。
   */
  entityKeyOf(item: MailboxItem): string {
    return this.entityKeysOf(item)[0];
  }

  /**
   * 一次性锁定多个实体键（全有或全无）。
   *
   * 全部键在同一个同步块内获取，不存在「部分持有后等待」的窗口，
   * 因此不会与其他 worker 形成环路等待（无死锁）。任一键已被占用则
   * 回滚已获取的键并返回 false。
   */
  lockEntities(entityKeys: readonly string[], holder: string): boolean {
    const acquired: string[] = [];
    for (const key of entityKeys) {
      if (this.entityLocks.has(key)) {
        for (const held of acquired) this.entityLocks.delete(held);
        return false;
      }
      this.entityLocks.set(key, holder);
      acquired.push(key);
    }
    return true;
  }

  /** 释放一组实体键（仅当持有者匹配时）。 */
  unlockEntities(entityKeys: readonly string[], holder: string): void {
    let released = false;
    for (const key of entityKeys) {
      if (this.entityLocks.get(key) === holder) {
        this.entityLocks.delete(key);
        released = true;
      }
    }
    // 锁释放可能让被阻塞的同实体 item 变得可运行 —— 唤醒等待的 worker。
    if (released) this.wakeIdleLoop();
  }

  /** 尝试锁定实体。成功返回 true；已被其他 worker 持有返回 false。 */
  lockEntity(entityKey: string, holder: string): boolean {
    return this.lockEntities([entityKey], holder);
  }

  /** 释放实体锁（仅当持有者匹配时；处理中止/完成路径调用）。 */
  unlockEntity(entityKey: string, holder: string): void {
    this.unlockEntities([entityKey], holder);
  }

  /** 实体是否被其他处理持有。 */
  isEntityLocked(entityKey: string | undefined): boolean {
    return !!entityKey && this.entityLocks.has(entityKey);
  }

  /** item 的任一实体维度是否已被锁定。 */
  isItemEntityLocked(item: MailboxItem): boolean {
    return this.entityKeysOf(item).some(k => this.entityLocks.has(k));
  }

  /**
   * 原子认领一项（P0 · 根因 #2）。持久层支持 `claimItem` 时以 DB 原子条件更新决定
   * **唯一胜者**；不支持时退化为「本地即胜」（旧行为，保持向后兼容）。
   *
   * @returns true = 本实例赢得认领（可处理）；false = 已被他人认领 / 正在处理。
   */
  private tryClaim(item: MailboxItem): boolean {
    const p = this.persistence;
    if (!p?.claimItem) return true; // 无持久层或旧实现：本地即胜
    // 矩阵闸门：认领就是 `queued → processing` 这条边。在这里先判，
    // 才能让原子 SQL 端口与矩阵共用同一份判据（否则矩阵只对内存路径生效）。
    if (!canTransitionSignal(item.status, 'processing')) {
      log.error('claim refused by the transition matrix', {
        agentId: this.agentId, itemId: item.id, from: item.status,
      });
      return false;
    }
    const startedAt = new Date().toISOString();
    const leaseUntil = new Date(Date.now() + this.leaseTtlMs).toISOString();
    let won = false;
    try {
      won = p.claimItem(item.id, this.ownerId, leaseUntil, startedAt);
    } catch (err) {
      // 认领通道故障时保守放行，避免整条注意力循环因持久层异常停摆。
      log.warn('Mailbox claimItem threw — falling back to local claim', {
        event: MAILBOX_OBSERVABILITY_EVENTS.claimError,
        agentId: this.agentId, itemId: item.id, type: item.sourceType, error: String(err),
      });
      return true;
    }
    if (won) {
      item.claimedBy = this.ownerId;
      item.leaseUntil = leaseUntil;
      item.startedAt = startedAt;
    }
    return won;
  }

  /** 释放本实例对该项的认领（幂等；非本人认领为 no-op）。 */
  private releaseClaim(itemId: string): void {
    try {
      this.persistence?.releaseClaim?.(itemId, this.ownerId);
    } catch (err) {
      log.warn('Mailbox releaseClaim threw', { agentId: this.agentId, itemId, error: String(err) });
    }
  }

  /**
   * 续租（P0 租约机制）：处理期间周期调用。返回 false 表示**租约已丢失**
   * （被回收或转手），调用方应视为「自己已不再是合法认领者」。
   */
  renewLease(itemId: string): boolean {
    const p = this.persistence;
    if (!p?.renewLease) return true; // 无租约机制 → 视为始终持有
    const leaseUntil = new Date(Date.now() + this.leaseTtlMs).toISOString();
    let ok = false;
    try {
      ok = p.renewLease(itemId, this.ownerId, leaseUntil);
    } catch (err) {
      log.warn('Mailbox renewLease threw', { agentId: this.agentId, itemId, error: String(err) });
      return true; // 持久层异常不阻断处理
    }
    if (!ok) {
      log.warn('Mailbox lease lost — item was reclaimed or handed over', {
        event: MAILBOX_OBSERVABILITY_EVENTS.leaseLost,
        agentId: this.agentId, itemId, ownerId: this.ownerId, count: 1,
      });
    }
    return ok;
  }

  /**
   * 回收过期租约并把退回的 item 重新载入内存队列（P0）。
   * 供注意力循环的空闲/恢复周期调用：崩溃或超时的 worker 不会永久占位。
   *
   * @returns 被回收（退回 queued）的条数。
   */
  reclaimExpiredLeases(): number {
    const p = this.persistence;
    if (!p?.releaseExpiredLeases) return 0;
    let n = 0;
    try {
      n = p.releaseExpiredLeases(this.agentId, new Date().toISOString());
    } catch (err) {
      log.warn('Mailbox releaseExpiredLeases threw', { agentId: this.agentId, error: String(err) });
      return 0;
    }
    if (n > 0) {
      // P2 可观测：`leaseExpiredReplay` —— 「租约过期重放」。
      // 计数字段：count=n（按 event 求和 = 累计被回收重放的项数）。
      log.warn('Reclaimed mailbox items with expired leases', {
        event: MAILBOX_OBSERVABILITY_EVENTS.leaseExpiredReplay,
        agentId: this.agentId, count: n,
      });
      // 退回的行已在 DB 变为 queued，需要重新载入内存队列才会被再次认领。
      for (const item of p.loadQueued?.(this.agentId) ?? []) {
        if (this.queue.some(q => q.id === item.id)) continue;
        this.insertSorted(item);
      }
      this.wakeIdleLoop();
    }
    return n;
  }

  /**
   * Remove and return the highest-priority runnable item (skips items whose
   * entity is currently locked by another worker; falls back to the next one).
   * Returns undefined if the queue is empty or all items are entity-locked.
   *
   * P0：取件时**原子认领**——持久层可用时以 DB 条件更新决定唯一胜者。
   * 认领失败（已被其它实例/worker 拿走）的候选会被移出本地队列并继续找下一个，
   * 保证「同一 item 至多一个 worker 处理」。
   */
  dequeue(): MailboxItem | undefined {
    for (;;) {
      const idx = this.queue.findIndex(it => it.status === 'queued' && !this.isItemEntityLocked(it));
      if (idx === -1) return undefined;
      const candidate = this.queue[idx]!;

      if (!this.persistence?.claimItem) {
        // 旧路径：无原子认领能力 → 本地即胜（保持原行为逐字节兼容）。
        const candidate = this.queue[idx]!;
        const startedAt = new Date().toISOString();
        const applied = this.updateSignalStatus(candidate, 'processing', {
          extra: { startedAt }, why: 'dequeue-local-claim',
        });
        this.queue.splice(idx, 1);
        if (!applied) {
          log.error('dequeue: transition refused — candidate dropped from queue to avoid a spin', {
            agentId: this.agentId, itemId: candidate.id, from: candidate.status,
          });
          return undefined;
        }
        if (candidate.sourceType === 'heartbeat') this._processingHeartbeatId = candidate.id;
        return candidate;
      }

      if (!this.tryClaim(candidate)) {
        // 已被他人认领 / 正在处理：本地副本失效，移出后继续找下一个候选。
        this.queue.splice(idx, 1);
        // P2 可观测：`claimContested` —— 「认领竞争」。
        // 计数字段：count=1（按 event 求和 = 累计认领竞争次数）。
        log.info('Mailbox item already claimed by another worker — skipped', {
          event: MAILBOX_OBSERVABILITY_EVENTS.claimContested,
          agentId: this.agentId,
          itemId: candidate.id,
          ownerId: this.ownerId,
          type: candidate.sourceType,
          taskId: candidate.payload.taskId ?? candidate.metadata?.taskId,
          count: 1,
        });
        continue;
      }

      const [item] = this.queue.splice(idx, 1);
      // 原子认领已在 DB 内完成 queued → processing；矩阵在 tryClaim 之前已裁决过。
      this.projectClaimed(item!, item!.startedAt ?? new Date().toISOString());
      if (item!.sourceType === 'heartbeat') this._processingHeartbeatId = item!.id;
      return item;
    }
  }

  /**
   * Block until an item is available, then dequeue it.
   * Throws `MailboxCancelledError` if woken by `cancelWait()` with an empty queue
   * (normal shutdown path — the attention loop should catch and exit cleanly).
   *
   * Arms the idle waiter BEFORE re-checking the queue so an enqueue that lands
   * between the empty check and wait cannot lose its wakeup (classic lost-wakeup
   * race — leaves attention "idle" forever with items still queued).
   */
  async dequeueAsync(): Promise<MailboxItem> {
    for (;;) {
      const item = this.dequeue();
      if (item) {
        this.cancelPending = false;
        return item;
      }

      await new Promise<void>(resolve => {
        this.idleWaiters.add(resolve);
        // Close the race: runnable work may have arrived after the empty dequeue above.
        if (this.hasRunnableItem()) {
          this.idleWaiters.delete(resolve);
          resolve();
        }
      });

      const afterWake = this.dequeue();
      if (afterWake) {
        this.cancelPending = false;
        return afterWake;
      }
      // Genuine cancel (shutdown): throw so the loop exits cleanly. Note we do NOT
      // clear cancelPending here — every waiter woken by cancelWait must exit too.
      if (this.cancelPending) {
        throw new MailboxCancelledError();
      }
      // Either another waiter won the item race (spurious broadcast wake) or
      // everything remaining is entity-locked — keep waiting for the next
      // enqueue / lock-release wakeup.
    }
  }

  /**
   * Nudge the attention loop if it is parked idle while work is already queued.
   * Used by the watchdog / recovery paths as a belt-and-suspenders wakeup.
   */
  nudgeIfPending(): void {
    if (this.queue.length > 0) this.wakeIdleLoop();
  }

  /**
   * Peek at the highest-priority item without removing it.
   */
  peek(): MailboxItem | undefined {
    return this.queue[0];
  }

  /**
   * Check if there are any pending items with priority <= threshold.
   */
  hasItemAbovePriority(threshold: MailboxPriority): boolean {
    return this.queue.length > 0 && this.queue[0].priority <= threshold;
  }

  /**
   * Get all items currently in the queue (snapshot, not live reference).
   */
  getQueuedItems(): MailboxItem[] {
    return [...this.queue];
  }

  /**
   * Mark an item as completed and remove from in-memory queue if still present.
   */
  complete(itemId: string): void {
    if (itemId === this._processingHeartbeatId) this._processingHeartbeatId = undefined;
    const idx = this.queue.findIndex(i => i.id === itemId);
    const inQueue = idx !== -1 ? this.queue[idx]! : undefined;
    // 行不在内存时**先读真实状态**，不假定 queued：矩阵要拿真 `from` 才能拦下
    // 「一个已收口/已归集的终态行被 complete() 覆盖」这类第二次写坏。
    const from: MailboxItemStatus | undefined = inQueue?.status ?? this.persistence?.getStatus?.(itemId);
    const now = new Date().toISOString();
    const applied = this.updateSignalStatus(
      inQueue ?? { id: itemId, status: from },
      'completed',
      { extra: { completedAt: now }, why: 'turn-complete', from },
    );
    if (idx !== -1) this.queue.splice(idx, 1);
    this.releaseClaim(itemId);
    if (!applied) {
      // 拒绝是可观测事件，不是静默 no-op：调用方（attention）会因此看到一个未收口的行。
      log.error('complete() refused by the transition matrix — row kept in its terminal state', {
        agentId: this.agentId, itemId, from: from ?? null,
      });
    }
  }

  /**
   * Mark an item as deferred with a reason. The item is removed from the active queue.
   */
  defer(itemId: string, until?: string): MailboxItem | undefined {
    const idx = this.queue.findIndex(i => i.id === itemId);
    if (idx === -1) return undefined;

    const item = this.queue[idx]!;
    const applied = this.updateSignalStatus(item, 'deferred', {
      extra: { deferredUntil: until }, why: 'defer',
    });
    if (!applied) return undefined;
    this.queue.splice(idx, 1);
    return item;
  }

  /**
   * Defer an item that has already been dequeued (not in the queue).
   * Used when processing is interrupted (preempted) and the item should
   * be resumed later.  Only updates persistence — does NOT re-insert
   * into the in-memory queue (resurfaceDue handles that on the next idle cycle).
   */
  deferDequeued(item: MailboxItem, until?: string): void {
    const applied = this.updateSignalStatus(item, 'deferred', {
      extra: { deferredUntil: until }, why: 'defer-dequeued', from: item.status,
    });
    if (!applied) {
      log.error('deferDequeued refused by the transition matrix', {
        agentId: this.agentId, itemId: item.id, from: item.status,
      });
      return;
    }
    item.startedAt = undefined;
    this.releaseClaim(item.id);
  }

  /**
   * Mark an item as merged into another item.
   */
  merge(itemId: string, intoItemId: string): MailboxItem | undefined {
    const idx = this.queue.findIndex(i => i.id === itemId);
    if (idx === -1) return undefined;

    const item = this.queue[idx]!;
    const applied = this.updateSignalStatus(item, 'merged', {
      extra: { mergedInto: intoItemId }, why: 'merge',
    });
    if (!applied) return undefined;
    this.queue.splice(idx, 1);
    this.releaseClaim(item.id);
    return item;
  }

  /**
   * Drop an item from the queue（第六刀 C3：**不再有 `dropped` 终态**）。
   *
   * Agent/操作员判定「这条信号不该处理了」是一个**决定**，不是事故：它现在写为
   * `bounced(stale_signal)` 并归集到 catch-all 概览（`bounce_target`），所以
   * 「谁在哪一刻决定丢弃什么」在概览里与其它退信同构，而不是一个没有回声的终态。
   *
   * If the item is not in the in-memory queue (ghost / already dequeued), still
   * write the bounce in persistence so agent tools can clear orphans idempotently.
   *
   * `dropReason`（第六刀 C5）：调用方若知道**更真实的**原因（例如入参校验失败的
   * `payload_invalid`），必须显式传入；默认值 `stale_signal` 只覆盖「主动决定丢弃」
   * 这一族（陈旧过期、被新状态取代、人/Agent 判断不必处理）。默认值不是万能桶：
   * 处理中途因报文不合格而终结的路径必须传原因，否则旧语义被悄悄扩大。
   */
  drop(itemId: string, reason?: string, dropReason: ActiveBounceReason = 'stale_signal'): MailboxItem | undefined {
    const why = reason ?? 'unspecified';
    const idx = this.queue.findIndex(i => i.id === itemId);
    if (idx === -1) {
      // 行不在内存：先读它的真实状态，让矩阵裁决（而不是假定 queued 盲写）。
      // 不读状态的话，一个已收口（completed）的行会被幽灵 drop 重写成退信行 ——
      // 同一事实被第二次写坏，正是矩阵要禁止的那类迁移。
      const current = this.persistence?.getStatus?.(itemId);
      if (current === 'completed' || current === 'merged') {
        log.warn('Ghost drop refused — row is already settled', {
          agentId: this.agentId, itemId, status: current,
        });
        return undefined;
      }
      const ghost: MailboxItem = {
        id: itemId,
        agentId: this.agentId,
        sourceType: 'system_event',
        priority: 4,
        status: current ?? 'queued',
        payload: { summary: `Ghost bounce: ${why}`, content: why },
        metadata: {},
        queuedAt: new Date().toISOString(),
      };
      this.bounceSignal(ghost, dropReason, why);
      this.releaseClaim(itemId);
      log.info('Mailbox ghost item bounced (not in queue)', {
        agentId: this.agentId, itemId, reason: why, fromStatus: current ?? 'unknown',
      });
      this.eventBus.emit('mailbox:dropped', { agentId: this.agentId, itemId, sourceType: undefined, reason: why });
      return undefined;
    }

    const [item] = this.queue.splice(idx, 1);
    this.bounceSignal(item, dropReason, why);
    this.releaseClaim(item.id);
    // A drop is a *decision*, not an accident: make who/why/what observable so a
    // disappearing message can be traced back instead of just not arriving.
    log.info('Mailbox item bounced (drop decision)', {
      agentId: this.agentId, itemId: item.id, type: item.sourceType, reason: why,
    });
    this.eventBus.emit('mailbox:dropped', {
      agentId: this.agentId, itemId: item.id, sourceType: item.sourceType, reason: why,
    });
    return item;
  }

  /**
   * Drop queued `task_status_update` items for a specific task.
   * Only targets informational notifications — execution-trigger items
   * and other types (comments, mentions) are preserved.
   */
  dropStatusUpdatesByTaskId(taskId: string): number {
    const toRemove: number[] = [];
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const item = this.queue[i];
      if (item.status === 'queued'
        && item.sourceType === 'task_status_update'
        && !isStrictStateItem(item)
        && (item.payload.taskId === taskId || item.metadata?.taskId === taskId)) {
        toRemove.push(i);
      }
    }
    for (const idx of toRemove) {
      const [item] = this.queue.splice(idx, 1);
      this.bounceSignal(item, 'stale_signal', `superseded-status-update:${taskId}`);
    }
    return toRemove.length;
  }

  /**
   * Re-queue an item for retry after abnormal completion.
   * Increments `retryCount`, resets status to 'queued', and re-inserts
   * at its original priority position.
   */
  requeue(item: MailboxItem): void {
    if (item.id === this._processingHeartbeatId) this._processingHeartbeatId = undefined;
    const retryCount = (item.retryCount ?? 0) + 1;
    const applied = this.updateSignalStatus(item, 'queued', {
      extra: { retryCount } as Partial<MailboxItem>, why: 'requeue-retry', from: item.status,
    });
    if (!applied) {
      // 已收口/已归集的行不得被「重试」复活：矩阵拒绝，且不插入队列。
      log.error('requeue refused by the transition matrix — terminal row not revived', {
        agentId: this.agentId, itemId: item.id, from: item.status, type: item.sourceType,
      });
      return;
    }
    item.retryCount = retryCount;
    item.startedAt = undefined;
    item.completedAt = undefined;
    this.insertSorted(item);
    this.releaseClaim(item.id);
    log.info('Mailbox item requeued for retry', {
      agentId: this.agentId,
      itemId: item.id,
      type: item.sourceType,
      retryCount: item.retryCount,
    });

    this.eventBus.emit('mailbox:new-item', { agentId: this.agentId, item });
    this.wakeIdleLoop();
  }

  /**
   * Return a dequeued item to the queue without incrementing retryCount.
   * Used by the triage phase when it picks a different item to process.
   *
   * P1.x (a)(b)：回队持久写走**同一条**路径（`requeuePersisted` → `requeueItem`）：
   * 无条件清 `claimed_by`/`lease_until` + **刷新 `queued_at`**。
   * 不再用 `releaseClaim` —— 其 `WHERE id=? AND claimed_by=?` 在「新实例回队旧实例遗留行」
   * 时因 `ownerId` 已变而 0 changes（静默 no-op）；不刷 `queued_at` 还会让刚回队的行
   * 在同一次 `recoverStaleItems` 中被 TTL 判 expired → dropped。
   */
  putBack(item: MailboxItem): void {
    const queuedAt = new Date().toISOString();
    // 矩阵闸门：只有“未收口”的行才能因回队而重新排队；completed/merged 不在出口集里。
    if (!canTransitionSignal(item.status, 'queued')) {
      log.error('putBack refused by the transition matrix — terminal row not re-queued', {
        agentId: this.agentId, itemId: item.id, from: item.status,
      });
      return;
    }
    this.projectRequeued(item, queuedAt);
    this.insertSorted(item);
    this.requeuePersisted(item.id, queuedAt);
  }

  /**
   * P1.x (a)(R2) · 停机重投 / 崩溃恢复：把本实例**在飞的 item** 交还队列。
   *
   * 与 `enqueue` 的冲突分支共用**同一个判定实现** `resolveReinjectDecision`（D3）：
   * 经 `enqueue(..., { reuseItemId: item.id })` 声明「我正持有这一条」，使判定走
   * 「复用原行回队」而不是「同键 → 幂等抑制」（后者会让该行永远停在 `processing`）。
   *
   * @returns 回队后的 item（`status === 'queued'`）；若既有行已收口则返回被抑制的 item。
   */
  reEnqueueOnShutdown(item: MailboxItem): MailboxItem {
    return this.enqueue(item.sourceType, item.payload, {
      priority: item.priority,
      metadata: item.metadata,
      reuseItemId: item.id,
    });
  }

  /**
   * P1.x (c)：读取幂等键对应的既有行（只读）。
   * 持久层未实现 `findByDedupKey` 时返回 undefined → 调用方退化为 P0 行为。
   */
  private persistedRowFor(dedupKey: string): MailboxExistingRow | undefined {
    const p = this.persistence;
    if (!p?.findByDedupKey) return undefined;
    try {
      return p.findByDedupKey(this.agentId, dedupKey) ?? undefined;
    } catch (err) {
      log.warn('Mailbox findByDedupKey threw', { agentId: this.agentId, dedupKey, error: String(err) });
      return undefined;
    }
  }

  /**
   * P1.x (a)(b)(d)：把既有行**无条件**回队（复用原行，不新增行）。
   *
   * 未实现 `requeueItem` 的旧持久层退化为 `updateStatus(id,'queued')`（不刷 `queued_at`）。
   *
   * @returns true = 已确认回队；false = 行不存在 / 状态不允许 / 无持久层。
   */
  private requeuePersisted(itemId: string, queuedAt: string): boolean {
    const p = this.persistence;
    if (!p) return false;
    try {
      if (p.requeueItem) {
        // 原子端口也过矩阵：`requeueItem` 的 SQL 本身就是 `X → queued` 这条边，
        // 不让它在矩阵之外自定许可集合（否则“矩阵是唯一判据”只对内存路径成立）。
        // `getStatus` 归一历史 `dropped → bounced`；取值域外的历史 `failed` 交给
        // 端口 SQL 自律（它的 WHERE 已显式列了合法集合）。
        const raw = p.getStatus?.(itemId);
        const from = raw === undefined ? undefined : normalizeSignalStatus(raw);
        if (from !== undefined && isKnownSignalStatus(from) && !canTransitionSignal(from, 'queued')) {
          log.error('requeue refused by the transition matrix — terminal row not revived', {
            agentId: this.agentId, itemId, from,
          });
          return false;
        }
        return p.requeueItem(itemId, { queuedAt }) !== false;
      }
      // 旧持久层降级路径：仍然走唯一执行点（拿真实 from 让矩阵裁决），
      // 而不是直接 `p.updateStatus(id,'queued')` 盲写——那是一个已收口行被
      // “补偿重投”复活的入口，也是把 14 处旁路养大的同一类写法。
      return this.updateSignalStatus(
        { id: itemId, status: p.getStatus?.(itemId) },
        'queued',
        { why: 'requeue-persisted-fallback' },
      );
    } catch (err) {
      log.warn('Mailbox requeue of persisted row threw', {
        agentId: this.agentId, itemId, error: String(err),
      });
      return false;
    }
  }

  /**
   * P1.x (a)(R2)：**复用既有行回队**（不新增行、不触发唯一键拒绝）。
   *
   * 返回的 item `status === 'queued'`；**绝不返回 `dropped`** —— QA 原始打回症状正是
   * 「re-enqueue 返回 `status=dropped`、队列 `0→0`」，调用方（attention.ts 停机重投）
   * 会据此误判为「消息已丢弃」。
   *
   * 行不存在（从未落库）时才退回正常插入；行存在但不可回队（已 `completed`/`merged`）
   * 则归入幂等抑制，不复活已收口轮次。
   */
  private reinjectExistingRow(
    item: MailboxItem,
    dedupKey: string | undefined,
    existing?: MailboxExistingRow,
  ): MailboxItem {
    const targetId = existing?.id ?? item.id;
    const queuedAt = new Date().toISOString();
    const requeued: MailboxItem = {
      ...item,
      id: targetId,
      status: 'queued',
      queuedAt,
      startedAt: undefined,
      completedAt: undefined,
      claimedBy: undefined,
      leaseUntil: undefined,
    };

    if (this.requeuePersisted(targetId, queuedAt)) {
      if (!this.queue.some(q => q.id === targetId)) this.insertSorted(requeued);
      // P2 可观测：`deliveryReinjected` —— 「补偿重投复用原行回队」。
      // 计数字段：count=1（按 event 求和 = 累计复用回队数）。
      log.warn('Mailbox redelivery reuse — existing row requeued (no new row)', {
        event: MAILBOX_OBSERVABILITY_EVENTS.deliveryReinjected,
        agentId: this.agentId,
        itemId: targetId,
        type: item.sourceType,
        dedupKey,
        previousStatus: existing?.status ?? 'processing',
        count: 1,
      });
      this.eventBus.emit('mailbox:new-item', { agentId: this.agentId, item: requeued });
      this.wakeIdleLoop({ type: item.sourceType, key: AgentMailbox.unicastRouteKey(requeued) });
      return requeued;
    }

    // 行不存在 → 正常插入（保持 P0 行为：先落库再入队）。
    const persisted = this.persistence?.save(requeued, dedupKey);
    if (persisted === false) {
      return this.suppressDuplicateDelivery(requeued, item.sourceType, dedupKey, existing?.status);
    }
    if (!this.queue.some(q => q.id === targetId)) this.insertSorted(requeued);
    this.eventBus.emit('mailbox:new-item', { agentId: this.agentId, item: requeued });
    this.wakeIdleLoop({ type: item.sourceType, key: AgentMailbox.unicastRouteKey(requeued) });
    return requeued;
  }

  /**
   * P1.x (c) suppress 分支：既有投递在飞 / 已收口 → 本次投递**不入队**。
   * 保留 P0/P1 的全部可观测与 Promise 了结语义。
   */
  private suppressDuplicateDelivery(
    item: MailboxItem,
    sourceType: MailboxItemType,
    dedupKey: string | undefined,
    existingStatus?: string,
  ): MailboxItem {
    // P2 可观测：`duplicateDeliveryDropped` —— 「被丢弃的重复投递」。
    // 计数字段：count=1（按 event 求和 = 累计丢弃的重复投递数）、dedupKey = 幂等键。
    log.warn('Duplicate mailbox delivery rejected by idempotency key — not enqueued', {
      event: MAILBOX_OBSERVABILITY_EVENTS.duplicateDeliveryDropped,
      agentId: this.agentId,
      itemId: item.id,
      type: sourceType,
      dedupKey,
      existingStatus,
      taskId: item.payload.taskId ?? item.metadata?.taskId,
      round: item.payload.extra?.round ?? (item.metadata as Record<string, unknown> | undefined)?.['round'],
      count: 1,
    });
    this.eventBus.emit('mailbox:duplicate-rejected', {
      agentId: this.agentId,
      itemId: item.id,
      sourceType,
      dedupKey,
    });
    // 投递方可能在 await responsePromise（如 notifyReviewer 的 .then）：
    // 重复投递既然被抑制，就必须显式了结该 Promise，否则调用方永久挂起
    // （其内存态 activeReviews 会残留 → 后续轮次的评审通知被误抑制）。
    const pending = item.runtime?.responsePromise;
    if (pending) {
      try { pending.resolve('[duplicate-delivery-suppressed]'); } catch { /* caller gone */ }
    }
    this.projectBounced(item, 'duplicate_message_id');
    return item;
  }

  /**
   * C2 / V5：同一条 `messageId` 重复投递 → 写一条结构化退信行（`bounced`）。
   *
   * 三条纪律：
   * 1. **不静默**：旧实现只 `log.warn` 就返回，人 / 概览都看不到这次投递失败了；
   * 2. **不改既有行**：既有 queued/processing 行是另一条信号的状态，改它就是第二写者；
   * 3. **可建模**：退信行带 `drop_reason='duplicate_message_id'`，`bounce_target` 留空
   *    （catch-all 归集是 C3 的写者）。
   */
  private bounceDuplicateMessage(
    item: MailboxItem,
    existing: MailboxExistingRow,
  ): MailboxItem {
    log.warn('Duplicate mailbox delivery bounced — same messageId already queued', {
      event: MAILBOX_OBSERVABILITY_EVENTS.duplicateDeliveryDropped,
      agentId: this.agentId,
      itemId: item.id,
      type: item.sourceType,
      messageId: item.envelope?.messageId,
      existingId: existing.id,
      existingStatus: existing.status,
      dropReason: 'duplicate_message_id',
      count: 1,
    });
    this.persistence?.saveBounced?.(item, 'duplicate_message_id');
    this.eventBus.emit('mailbox:duplicate-rejected', {
      agentId: this.agentId,
      itemId: item.id,
      sourceType: item.sourceType,
      dedupKey: item.envelope?.messageId,
    });
    // 投递方可能在 await responsePromise：被退信就必须显式了结，否则调用方永久挂起。
    const pending = item.runtime?.responsePromise;
    if (pending) {
      try { pending.resolve('[duplicate-message-bounced]'); } catch { /* caller gone */ }
    }
    this.projectBounced(item, 'duplicate_message_id');
    return item;
  }

  /**
   * Dequeue a specific item by ID (not just the head of the queue).
   * Used by the triage phase to pick its chosen item.
   */
  dequeueById(id: string): MailboxItem | undefined {
    const idx = this.queue.findIndex(i => i.id === id);
    if (idx === -1) return undefined;
    const candidate = this.queue[idx]!;

    if (!this.persistence?.claimItem) {
      const candidate = this.queue[idx]!;
      const startedAt = new Date().toISOString();
      const applied = this.updateSignalStatus(candidate, 'processing', {
        extra: { startedAt }, why: 'dequeue-by-id-local-claim',
      });
      this.queue.splice(idx, 1);
      if (!applied) {
        log.error('dequeueById: transition refused — candidate dropped to avoid a spin', {
          agentId: this.agentId, itemId: id, from: candidate.status,
        });
        return undefined;
      }
      return candidate;
    }

    if (!this.tryClaim(candidate)) {
      // 已被他人认领：本地副本失效，移出并拒交（不返回半认领的 item）。
      this.queue.splice(idx, 1);
      log.info('Mailbox item already claimed by another worker — dequeueById rejected', {
        agentId: this.agentId, itemId: id, ownerId: this.ownerId,
      });
      return undefined;
    }

    const [item] = this.queue.splice(idx, 1);
    this.projectClaimed(item!, item!.startedAt ?? new Date().toISOString());
    return item;
  }

  getById(itemId: string): MailboxItem | undefined {
    return this.queue.find(i => i.id === itemId);
  }

  updatePriority(itemId: string, newPriority: number): boolean {
    const idx = this.queue.findIndex(i => i.id === itemId);
    if (idx < 0) return false;
    const item = this.queue.splice(idx, 1)[0]!;
    item.priority = newPriority as MailboxPriority;
    this.insertSorted(item);
    // 注意：不能依赖 save()——save 现为幂等插入语义（ON CONFLICT DO NOTHING），
    // 同一 id 的二次 save 不落库且返回 false，改优先级会被静默丢弃。
    // 这是**同状态字段写**（不是迁移）：走具名字段口，守卫据此区分二者。
    this.updateFields(item, { priority: item.priority });
    return true;
  }

  /**
   * Re-enqueue a deferred item back into the active queue.
   */
  resurface(item: MailboxItem): void {
    const applied = this.updateSignalStatus(item, 'queued', {
      why: 'resurface-due', from: item.status,
    });
    if (!applied) {
      log.error('resurface refused by the transition matrix — row not re-queued', {
        agentId: this.agentId, itemId: item.id, from: item.status,
      });
      return;
    }
    item.deferredUntil = undefined;
    this.insertSorted(item);
    this.eventBus.emit('mailbox:new-item', { agentId: this.agentId, item });
    this.wakeIdleLoop();
  }

  /**
   * Resurface all deferred items that are due (deferredUntil <= now) or
   * have no deferredUntil set (deferred without a time = resume on next idle).
   * Called at the top of each attention loop idle cycle.
   */
  resurfaceDue(): number {
    const deferred = this.persistence?.loadDeferred?.(this.agentId) ?? [];
    const now = Date.now();
    let resurfaced = 0;
    for (const item of deferred) {
      if (this.queue.some(q => q.id === item.id)) continue;
      const isDue = !item.deferredUntil || new Date(item.deferredUntil).getTime() <= now;
      if (isDue) {
        this.resurface(item);
        resurfaced++;
      }
    }
    if (resurfaced > 0) {
      log.info('Resurfaced deferred items', { agentId: this.agentId, count: resurfaced });
    }
    return resurfaced;
  }

  /**
   * Single entry for **time-driven mailbox upkeep**. Called by the agent clock
   * on a fixed cadence, independent of queue activity — this is what releases a
   * due deferred item on an otherwise idle agent (the attention loop only calls
   * `resurfaceDue()` when it iterates, which it does not do while parked on an
   * empty queue).
   *
   * Each step is independently guarded: a partial persistence backend or a
   * throwing reconcile never blocks the others.
   */
  runMaintenance(): { resurfaced: number; reclaimed: number; cleaned: number; purged: number } {
    const safe = (label: string, fn: () => number): number => {
      try {
        return fn();
      } catch (err) {
        log.warn('Mailbox maintenance step failed', { agentId: this.agentId, step: label, error: String(err) });
        return 0;
      }
    };
    const resurfaced = safe('resurfaceDue', () => this.resurfaceDue());
    const reclaimed = safe('reclaimExpiredLeases', () => this.reclaimExpiredLeases());
    const cleaned = safe('cleanStaleProcessing', () => this.cleanStaleProcessing());
    const purged = safe('purgeStaleItems', () => this.purgeStaleItems());
    if (resurfaced || reclaimed || cleaned || purged) {
      log.info('Mailbox maintenance', { agentId: this.agentId, resurfaced, reclaimed, cleaned, purged });
    }
    return { resurfaced, reclaimed, cleaned, purged };
  }

  /**
   * Auto-drop stale informational items from the queue.
   * Called before triage to keep the queue lean — old informational items
   * (task_status_update, heartbeat, etc.) carry context that has already
   * decayed and would only waste LLM attention budget.
   */
  purgeStaleItems(): number {
    const now = Date.now();
    const toRemove: number[] = [];

    for (let i = this.queue.length - 1; i >= 0; i--) {
      const item = this.queue[i];
      if (item.status !== 'queued') continue;
      // Only drop informational types, never human messages / A2A / execution triggers
      if (!routeMailboxItem(item).triageStaleDrop) continue;
      // …and even within the stale types, anything the agent still owes must survive
      // age expiry — otherwise a real message vanishes with no trace.
      if (this.isNeverPurgeable(item)) {
        log.info('Stale purge skipped a non-informational item', {
          agentId: this.agentId, itemId: item.id, type: item.sourceType,
        });
        continue;
      }

      const age = now - new Date(item.queuedAt).getTime();
      if (age > TRIAGE_STALE_INFO_TTL_MS) {
        toRemove.push(i);
      }
    }

    const droppedTypes = new Set<string>();
    for (const idx of toRemove) {
      const [item] = this.queue.splice(idx, 1);
      // C3：陈旧信息项过期 = “没投出去”（stale_signal），在概览里恰好可见一次。
      droppedTypes.add(item.sourceType);
      this.bounceSignal(item, 'stale_signal', 'triage-stale-purge');
    }

    if (toRemove.length > 0) {
      log.info('Stale purge archived informational items', {
        agentId: this.agentId,
        count: toRemove.length,
        types: [...droppedTypes].join(','),
      });
    }
    return toRemove.length;
  }

  /**
   * The purge's remit is **purely informational** items. Anything that carries a
   * user-visible reply, or an action the agent still owes, must never be reclaimed
   * by age — that is exactly how a real message goes missing (silent drop).
   */
  private isNeverPurgeable(item: MailboxItem): boolean {
    if (isStrictStateItem(item)) return true;
    // callback_result carries a reply the user can see in the Team Chat bubble.
    if (item.sourceType === 'callback_result') return true;
    const extra = item.payload?.extra;
    // 结构字段优先；`directMention` 本卡不动（§2.1 只授权 triggerExecution /
    // actionRequired / round 三个字段上提，其余标记留在载荷里，口径已写入文档）。
    if (item.envelope?.intent === 'action_required') return true;
    if (extra?.directMention) return true;
    return false;
  }

  get depth(): number {
    return this.queue.length;
  }

  get isEmpty(): boolean {
    return this.queue.length === 0;
  }

  /**
   * Check for items with the same taskId already in the queue (for dedup).
   */
  findByTaskId(taskId: string): MailboxItem | undefined {
    return this.queue.find(
      i => i.payload.taskId === taskId || i.metadata?.taskId === taskId,
    );
  }

  findByRequirementId(requirementId: string): MailboxItem | undefined {
    return this.queue.find(i => i.payload.requirementId === requirementId);
  }

  /**
   * Cancel the idle wait (used during shutdown). Wakes ALL waiting workers.
   */
  cancelWait(): void {
    this.cancelPending = true;
    if (this.idleWaiters.size > 0) {
      const waiters = [...this.idleWaiters];
      this.idleWaiters.clear();
      for (const resolve of waiters) resolve();
    }
  }

  /**
   * If a queued (not yet processing) item exists for the same entity and a
   * dedup-eligible type, append the new content into it and return the
   * existing item.  Returns undefined when no merge candidate is found.
   *
   * `workUnitRef` 是**入参**而不是从队列里反查：身份只存在于生产方交给我们的那一份
   * （C8-A）。频道类合并因此按**实体**比，而不是按“这次从哪个频道到的”比 ——
   * 同一频道里两件不同的事不能被并成一条，否则第二件事的执行理由会消失。
   * 旧行（无 WU）仍退化到 `channelKey`，行为与之前一致。
   */
  private tryMergeIntoExisting(
    sourceType: MailboxItemType,
    payload: MailboxPayload,
    workUnitRef: string | null = null,
  ): MailboxItem | undefined {
    // Never merge strict-state items (execution trigger / review / action-required updates)
    // — they must remain standalone。审计 P1-2。
    if (isStrictStateItem({ sourceType, payload })) return undefined;

    let existing: MailboxItem | undefined;

    if (AgentMailbox.TASK_COMMENT_DEDUP_TYPES.has(sourceType)) {
      const taskId = payload.taskId;
      if (taskId) {
        existing = this.queue.find(
          i => i.status === 'queued'
            && AgentMailbox.TASK_COMMENT_DEDUP_TYPES.has(i.sourceType)
            && !isStrictStateItem(i)
            && (i.payload.taskId === taskId || i.metadata?.taskId === taskId),
        );
      }
    } else if (AgentMailbox.REQ_COMMENT_DEDUP_TYPES.has(sourceType)) {
      const reqId = payload.requirementId;
      if (reqId) {
        existing = this.queue.find(
          i => i.status === 'queued'
            && AgentMailbox.REQ_COMMENT_DEDUP_TYPES.has(i.sourceType)
            && i.payload.requirementId === reqId,
        );
      }
    } else if (AgentMailbox.CHANNEL_DEDUP_TYPES.has(sourceType)) {
      const channelKey = payload.extra?.channelKey as string | undefined;
      // C8-A：合并键 = 实体（WU ref），旧行才退到频道。
      const entityKey = workUnitRef ?? channelKey;
      if (entityKey) {
        existing = this.queue.find(
          i => i.status === 'queued'
            && AgentMailbox.CHANNEL_DEDUP_TYPES.has(i.sourceType)
            && (i.workUnitRef ?? (i.payload.extra?.channelKey as string | undefined)) === entityKey,
        );
      }
    }

    if (!existing) return undefined;

    // For channel-based merges, use structured messages array
    if (AgentMailbox.CHANNEL_DEDUP_TYPES.has(sourceType) && payload.extra?.channelKey) {
      const senderName = payload.extra?.senderName as string || 'unknown';
      const newMsg = { senderId: payload.extra?.senderId as string | undefined, senderName, content: payload.content, timestamp: new Date().toISOString() };
      if (!existing.payload.messages) {
        const existingSender = existing.payload.extra?.senderName as string || 'unknown';
        existing.payload.messages = [{ senderId: existing.payload.extra?.senderId as string | undefined, senderName: existingSender, content: existing.payload.content, timestamp: existing.queuedAt }];
      }
      existing.payload.messages.push(newMsg);
      existing.payload.content += `\n\n---\n[${senderName}]: ${payload.content}`;
    } else {
      existing.payload.content += `\n\n---\n\n${payload.content}`;
    }
    bumpMergeCount(existing);
    // 同状态字段写（dedup 合并只是往既有 queued 行里追加内容）。
    this.updateFields(existing, this.persistableFields(existing));
    log.debug('Mailbox enqueue-time dedup: merged into existing item', {
      agentId: this.agentId,
      existingId: existing.id,
      sourceType,
    });
    return existing;
  }

  /**
   * Insert item into the queue maintaining priority order.
   * Within the same priority, newer items go first (LIFO) so the most
   * recent message is processed before older ones — a user's latest
   * instruction may supersede earlier ones.
   */
  private insertSorted(item: MailboxItem): void {
    let insertIdx = this.queue.length;
    for (let i = 0; i < this.queue.length; i++) {
      if (this.queue[i].priority >= item.priority) {
        insertIdx = i;
        break;
      }
    }
    this.queue.splice(insertIdx, 0, item);
  }
}
