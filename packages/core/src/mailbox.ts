import {
  createLogger,
  generateId,
  MAILBOX_QUEUED_TTL_MS,
  TRIAGE_STALE_INFO_TTL_MS,
  TRIAGE_STALE_DROP_TYPES,
  type MailboxItem,
  type MailboxItemType,
  type MailboxPayload,
  type MailboxItemMetadata,
  type MailboxItemStatus,
  type MailboxPriority,
  MAILBOX_TYPE_REGISTRY,
  resolveEntityKeys,
} from '@markus/shared';
import type { EventBus } from './events.js';

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
  Object.entries(MAILBOX_TYPE_REGISTRY).map(([k, v]) => [k, v.defaultPriority]),
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

/**
 * 「每 (task, round) 至多一条」的类型集合（P0 幂等键作用域）。
 *
 * 只对**语义上确实至多一次**的类型生效，且必须同时具备 `taskId` 与 `round`
 * —— 否则不加约束。这样既拿到跨进程去重，又不会误伤「同一任务同一轮可有多条」
 * 的类型（如 task_comment：同轮可发表多条评论），守住「不改产品语义」的边界。
 */
const AT_MOST_ONCE_PER_ROUND_TYPES: ReadonlySet<MailboxItemType> = new Set<MailboxItemType>([
  'review_request',
]);

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
  item: Pick<MailboxItem, 'sourceType' | 'payload' | 'metadata'>,
): string | undefined {
  if (!AT_MOST_ONCE_PER_ROUND_TYPES.has(item.sourceType)) return undefined;
  const taskId = item.payload.taskId ?? (item.metadata?.taskId as string | undefined);
  const roundRaw = item.payload.extra?.round ?? (item.metadata as Record<string, unknown> | undefined)?.round;
  const round = typeof roundRaw === 'number' && Number.isFinite(roundRaw) ? roundRaw : undefined;
  if (!taskId || round === undefined) return undefined;
  return `${item.sourceType}:${taskId}:${round}`;
}

export interface EnqueueOptions {
  priority?: MailboxPriority;
  metadata?: MailboxItemMetadata;
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
  updateStatus(itemId: string, status: MailboxItemStatus, extra?: Partial<MailboxItem>): void;
  /** Mark all items stuck in 'processing' as 'dropped' (stale after restart). */
  markStaleProcessingAsDropped?(agentId: string): number;
  /**
   * Mark stuck 'processing' items as 'completed' (runtime self-healing).
   *
   * `ownerId` = 本实例认领者标识。传入后，持久层只清理「无认领 / 租约已过期 /
   * **本实例自己持有**」的行，从而**不误杀其它实例仍在有效租约内处理**的项（跨实例互踩）。
   */
  markStaleProcessingAsCompleted?(agentId: string, ownerId?: string): number;
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
   * 回收过期租约（P0）：把 `processing` 且租约已过期的 item 退回 `queued`
   * （清空 claimed_by / lease_until / started_at），返回回收条数。
   * 使崩溃或超时的 worker 不会永久占位。
   */
  releaseExpiredLeases?(agentId: string, nowIso: string): number;
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

  /**
   * On startup:
   * 1. Mark any persisted items stuck in 'processing' as 'dropped'.
   * 2. Reload surviving 'queued' items into the in-memory queue.
   * Returns { dropped, restored }.
   */
  recoverStaleItems(): { dropped: number; restored: number; expired: number; merged: number } {
    const dropped = this.persistence?.markStaleProcessingAsDropped?.(this.agentId) ?? 0;

    let restored = 0;
    let expired = 0;
    const now = Date.now();
    const queuedItems = this.persistence?.loadQueued?.(this.agentId) ?? [];
    const staleTypes = new Set(TRIAGE_STALE_DROP_TYPES);
    for (const item of queuedItems) {
      if (this.queue.some(q => q.id === item.id)) continue;

      const age = now - new Date(item.queuedAt).getTime();
      // Hard TTL for everything; informational/callback ghosts expire sooner so a
      // long-running agent does not keep replaying stale background completions.
      const ttl = staleTypes.has(item.sourceType) ? TRIAGE_STALE_INFO_TTL_MS : MAILBOX_QUEUED_TTL_MS;
      if (age > ttl) {
        this.persistence?.updateStatus(item.id, 'dropped');
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
    return { dropped, restored, expired, merged };
  }

  /**
   * Runtime self-healing: mark DB items stuck in 'processing' as 'completed'.
   * Called by the watchdog when no item is being processed in memory.
   * Unlike recoverStaleItems (startup-only, marks as 'dropped'), this uses
   * 'completed' because the processing likely did finish — the DB update
   * just failed silently or was interrupted.
   */
  cleanStaleProcessing(): number {
    // 传 ownerId：只清理「无认领 / 租约过期 / 本实例持有」的行，
    // 避免把其它实例仍有效租约内的 processing 项误标为 completed（跨实例互踩）。
    return this.persistence?.markStaleProcessingAsCompleted?.(this.agentId, this.ownerId) ?? 0;
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
        this.persistence?.updateStatus(item.id, 'dropped');
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
      if (item.payload.extra?.triggerExecution) continue;

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
      survivor.payload.summary += ` (+1)`;
      // Elevate priority if the new item is higher priority
      if (item.priority < survivor.priority) {
        survivor.priority = item.priority;
      }
      this.persistence?.updateStatus(survivor.id, 'queued', survivor);

      // Remove the duplicate (mark as merged, not dropped — content is preserved in survivor)
      this.queue.splice(i, 1);
      this.persistence?.updateStatus(item.id, 'merged', { mergedInto: survivor.id });
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
      'task',
    );

    // Group by requirementId (only for items that don't also have a taskId)
    removed += this.consolidateGroup(
      (item) => {
        if (item.payload.taskId || item.metadata?.taskId) return undefined;
        return item.payload.requirementId;
      },
      'requirement',
    );

    // Group by channel: merge a2a_messages from the same group chat so the
    // agent reads them as one conversation thread instead of N separate items.
    // Skip items already grouped by task/requirement above.
    removed += this.consolidateGroup(
      (item) => {
        if (item.sourceType !== 'a2a_message') return undefined;
        if (item.payload.taskId || item.metadata?.taskId) return undefined;
        if (item.payload.requirementId) return undefined;
        return item.payload.extra?.channelKey as string | undefined;
      },
      'channel',
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

  private consolidateGroup(
    getKey: (item: MailboxItem) => string | undefined,
    _groupType: string,
    opts?: { skipProtectedCheck?: boolean },
  ): number {
    let removed = 0;
    const seen = new Map<string, number>();

    for (let i = 0; i < this.queue.length; i++) {
      const item = this.queue[i];
      if (item.status !== 'queued') continue;
      if (item.payload.extra?.triggerExecution) continue;
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
      const countMatch = survivor.payload.summary.match(/\((\+\d+)\)$/);
      if (countMatch) {
        const prev = parseInt(countMatch[1].slice(1), 10);
        survivor.payload.summary = survivor.payload.summary.replace(/\(\+\d+\)$/, `(+${prev + 1})`);
      } else {
        survivor.payload.summary += ' (+1)';
      }
      if (item.priority < survivor.priority) {
        survivor.priority = item.priority;
      }
      this.persistence?.updateStatus(survivor.id, 'queued', survivor);

      this.queue.splice(i, 1);
      this.persistence?.updateStatus(item.id, 'merged', { mergedInto: survivor.id });
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
    // Enqueue-time dedup: merge into existing queued item for the same entity
    const merged = this.tryMergeIntoExisting(sourceType, payload);
    if (merged) {
      this.eventBus.emit('mailbox:new-item', { agentId: this.agentId, item: merged });
      this.wakeIdleLoop();
      return merged;
    }

    const item: MailboxItem = {
      id: generateId('mbx'),
      agentId: this.agentId,
      sourceType,
      priority: options?.priority ?? DEFAULT_PRIORITY[sourceType],
      status: 'queued',
      payload,
      metadata: options?.metadata,
      queuedAt: new Date().toISOString(),
    };

    // P0 幂等键（根因 #5）：**先落库再入内存队列**。落库被唯一键拒绝（返回 false）
    // 即「同一 (agent, sourceType, taskId, round) 已投递过」——此时**不入队**，
    // 让「不产生重复投递」成为显式语义，而不是靠后续「无 DB 行 → 认领失败」间接兜住。
    const dedupKey = mailboxDedupKey(item);
    const persisted = this.persistence?.save(item, dedupKey);
    if (persisted === false) {
      // P2 可观测：`duplicateDeliveryDropped` —— 「被丢弃的重复投递」。
      // 计数字段：count=1（按 event 求和 = 累计丢弃的重复投递数）、dedupKey = 幂等键。
      log.warn('Duplicate mailbox delivery rejected by idempotency key — not enqueued', {
        event: MAILBOX_OBSERVABILITY_EVENTS.duplicateDeliveryDropped,
        agentId: this.agentId,
        itemId: item.id,
        type: sourceType,
        dedupKey,
        taskId: payload.taskId ?? item.metadata?.taskId,
        round: payload.extra?.round ?? (item.metadata as Record<string, unknown> | undefined)?.['round'],
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
      const pending = item.metadata?.responsePromise;
      if (pending) {
        try { pending.resolve('[duplicate-delivery-suppressed]'); } catch { /* caller gone */ }
      }
      item.status = 'dropped';
      return item;
    }

    this.insertSorted(item);

    log.debug('Mailbox enqueue', {
      agentId: this.agentId,
      itemId: item.id,
      type: sourceType,
      priority: item.priority,
      summary: payload.summary.slice(0, 80),
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
    const roundRaw = item.payload.extra?.round
      ?? (item.metadata as Record<string, unknown> | undefined)?.['round'];
    const round = typeof roundRaw === 'number' && Number.isFinite(roundRaw) ? roundRaw : undefined;
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
   * 作用域映射是**声明式**的 —— 由 `MAILBOX_TYPE_REGISTRY[type].entityScopes`
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
        const [item] = this.queue.splice(idx, 1);
        item!.status = 'processing';
        item!.startedAt = new Date().toISOString();
        this.persistence?.updateStatus(item!.id, 'processing', { startedAt: item!.startedAt });
        return item;
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
      item!.status = 'processing';
      // claimItem 已在 DB 内一并写入 processing + started_at + claimed_by + lease_until。
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
    const idx = this.queue.findIndex(i => i.id === itemId);
    if (idx !== -1) {
      const [item] = this.queue.splice(idx, 1);
      item.status = 'completed';
    }
    const now = new Date().toISOString();
    this.persistence?.updateStatus(itemId, 'completed', { completedAt: now });
    this.releaseClaim(itemId);
  }

  /**
   * Mark an item as deferred with a reason. The item is removed from the active queue.
   */
  defer(itemId: string, until?: string): MailboxItem | undefined {
    const idx = this.queue.findIndex(i => i.id === itemId);
    if (idx === -1) return undefined;

    const [item] = this.queue.splice(idx, 1);
    item.status = 'deferred';
    item.deferredUntil = until;
    this.persistence?.updateStatus(item.id, 'deferred', { deferredUntil: until });
    return item;
  }

  /**
   * Defer an item that has already been dequeued (not in the queue).
   * Used when processing is interrupted (preempted) and the item should
   * be resumed later.  Only updates persistence — does NOT re-insert
   * into the in-memory queue (resurfaceDue handles that on the next idle cycle).
   */
  deferDequeued(item: MailboxItem, until?: string): void {
    item.status = 'deferred';
    item.deferredUntil = until;
    item.startedAt = undefined;
    this.persistence?.updateStatus(item.id, 'deferred', { deferredUntil: until });
    this.releaseClaim(item.id);
  }

  /**
   * Mark an item as merged into another item.
   */
  merge(itemId: string, intoItemId: string): MailboxItem | undefined {
    const idx = this.queue.findIndex(i => i.id === itemId);
    if (idx === -1) return undefined;

    const [item] = this.queue.splice(idx, 1);
    item.status = 'merged';
    item.mergedInto = intoItemId;
    this.persistence?.updateStatus(item.id, 'merged', { mergedInto: intoItemId });
    this.releaseClaim(item.id);
    return item;
  }

  /**
   * Drop an item from the queue.
   * If the item is not in the in-memory queue (ghost / already dequeued), still
   * mark it dropped in persistence so agent tools can clear orphans idempotently.
   */
  drop(itemId: string): MailboxItem | undefined {
    const idx = this.queue.findIndex(i => i.id === itemId);
    if (idx === -1) {
      this.persistence?.updateStatus(itemId, 'dropped');
      this.releaseClaim(itemId);
      return undefined;
    }

    const [item] = this.queue.splice(idx, 1);
    item.status = 'dropped';
    this.persistence?.updateStatus(item.id, 'dropped');
    this.releaseClaim(item.id);
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
        && !item.payload.extra?.triggerExecution
        && (item.payload.taskId === taskId || item.metadata?.taskId === taskId)) {
        toRemove.push(i);
      }
    }
    for (const idx of toRemove) {
      const [item] = this.queue.splice(idx, 1);
      this.persistence?.updateStatus(item.id, 'dropped');
    }
    return toRemove.length;
  }

  /**
   * Re-queue an item for retry after abnormal completion.
   * Increments `retryCount`, resets status to 'queued', and re-inserts
   * at its original priority position.
   */
  requeue(item: MailboxItem): void {
    item.retryCount = (item.retryCount ?? 0) + 1;
    item.status = 'queued';
    item.startedAt = undefined;
    item.completedAt = undefined;
    this.insertSorted(item);
    this.persistence?.updateStatus(item.id, 'queued', { retryCount: item.retryCount } as Partial<MailboxItem>);
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
   */
  putBack(item: MailboxItem): void {
    item.status = 'queued';
    item.startedAt = undefined;
    this.insertSorted(item);
    this.persistence?.updateStatus(item.id, 'queued');
    this.releaseClaim(item.id);
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
      const [item] = this.queue.splice(idx, 1);
      item!.status = 'processing';
      item!.startedAt = new Date().toISOString();
      this.persistence?.updateStatus(item!.id, 'processing', { startedAt: item!.startedAt });
      return item;
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
    item!.status = 'processing';
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
    // 同一 id 的二次 save 不落库且返回 false，改优先级会被静默丢弃。改走 updateStatus。
    this.persistence?.updateStatus(item.id, item.status, { priority: item.priority });
    return true;
  }

  /**
   * Re-enqueue a deferred item back into the active queue.
   */
  resurface(item: MailboxItem): void {
    item.status = 'queued';
    item.deferredUntil = undefined;
    this.insertSorted(item);
    this.persistence?.updateStatus(item.id, 'queued');
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
   * Auto-drop stale informational items from the queue.
   * Called before triage to keep the queue lean — old informational items
   * (task_status_update, heartbeat, etc.) carry context that has already
   * decayed and would only waste LLM attention budget.
   */
  purgeStaleItems(): number {
    const now = Date.now();
    const staleTypes = new Set(TRIAGE_STALE_DROP_TYPES);
    const toRemove: number[] = [];

    for (let i = this.queue.length - 1; i >= 0; i--) {
      const item = this.queue[i];
      if (item.status !== 'queued') continue;
      // Only drop informational types, never human messages / A2A / execution triggers
      if (!staleTypes.has(item.sourceType)) continue;
      if (item.payload.extra?.triggerExecution) continue;

      const age = now - new Date(item.queuedAt).getTime();
      if (age > TRIAGE_STALE_INFO_TTL_MS) {
        toRemove.push(i);
      }
    }

    for (const idx of toRemove) {
      const [item] = this.queue.splice(idx, 1);
      item.status = 'dropped';
      this.persistence?.updateStatus(item.id, 'dropped');
    }

    if (toRemove.length > 0) {
      log.info('Purged stale informational items', {
        agentId: this.agentId,
        count: toRemove.length,
      });
    }
    return toRemove.length;
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
   */
  private tryMergeIntoExisting(
    sourceType: MailboxItemType,
    payload: MailboxPayload,
  ): MailboxItem | undefined {
    // Never merge execution-trigger items — they must remain standalone.
    if (payload.extra?.triggerExecution) return undefined;

    let existing: MailboxItem | undefined;

    if (AgentMailbox.TASK_COMMENT_DEDUP_TYPES.has(sourceType)) {
      const taskId = payload.taskId;
      if (taskId) {
        existing = this.queue.find(
          i => i.status === 'queued'
            && AgentMailbox.TASK_COMMENT_DEDUP_TYPES.has(i.sourceType)
            && !i.payload.extra?.triggerExecution
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
      if (channelKey) {
        existing = this.queue.find(
          i => i.status === 'queued'
            && AgentMailbox.CHANNEL_DEDUP_TYPES.has(i.sourceType)
            && (i.payload.extra?.channelKey as string | undefined) === channelKey,
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
    existing.payload.summary += ` (+1)`;
    this.persistence?.updateStatus(existing.id, 'queued', existing);
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
