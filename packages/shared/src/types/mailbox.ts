// ─── Mailbox Types ──────────────────────────────────────────────────────────

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

export interface MailboxTypeDescriptor {
  label: string;
  defaultPriority: MailboxPriority;
  category: MailboxCategory;
  icon: string;
  activityType: string | null;
  createsActivity: boolean;
  invokesLLM: boolean;
  /**
   * 该类型参与实体亲和的维度，**按优先级降序**，最后一项必须是 `'system'`。
   * 运行时取第一个能解析出值的维度作为实体锁键（见 `resolveEntityKey`）。
   */
  entityScopes: readonly MailboxEntityScope[];
}

export const MAILBOX_TYPE_REGISTRY: Record<MailboxItemType, MailboxTypeDescriptor> = {
  //                                                                                                        ── entity affinity scopes (precedence order; MUST end with 'system')
  system_event:         { label: 'System Event',         defaultPriority: 1, category: 'system',       icon: '⚙',  activityType: 'internal',           createsActivity: true,  invokesLLM: true,  entityScopes: ['system'] },
  human_chat:           { label: 'Chat',                 defaultPriority: 0, category: 'interaction',   icon: '💬', activityType: 'chat',               createsActivity: true,  invokesLLM: true,  entityScopes: ['task', 'requirement', 'conversation', 'system'] },
  task_comment:         { label: 'Task Comment',         defaultPriority: 2, category: 'task',          icon: '💬', activityType: null,                 createsActivity: false, invokesLLM: false, entityScopes: ['task', 'requirement', 'system'] },
  mention:              { label: 'Mention',              defaultPriority: 1, category: 'interaction',   icon: '@',  activityType: 'chat',               createsActivity: true,  invokesLLM: true,  entityScopes: ['task', 'requirement', 'user', 'conversation', 'system'] },
  session_reply:        { label: 'Session Reply',        defaultPriority: 1, category: 'task',          icon: '↩',  activityType: 'respond_in_session', createsActivity: true,  invokesLLM: true,  entityScopes: ['task', 'requirement', 'conversation', 'system'] },
  task_status_update:   { label: 'Task Status',          defaultPriority: 1, category: 'task',          icon: '📋', activityType: null,                 createsActivity: true,  invokesLLM: false, entityScopes: ['task', 'requirement', 'system'] },
  a2a_message:          { label: 'Agent Message',        defaultPriority: 2, category: 'interaction',   icon: '🔗', activityType: 'a2a',                createsActivity: true,  invokesLLM: true,  entityScopes: ['task', 'requirement', 'channel', 'system'] },
  review_request:       { label: 'Review Request',       defaultPriority: 1, category: 'task',          icon: '👀', activityType: 'chat',               createsActivity: true,  invokesLLM: true,  entityScopes: ['task', 'requirement', 'system'] },
  requirement_comment:  { label: 'Requirement Comment',  defaultPriority: 2, category: 'task',          icon: '💬', activityType: null,                 createsActivity: false, invokesLLM: false, entityScopes: ['task', 'requirement', 'system'] },
  requirement_update:   { label: 'Requirement Update',   defaultPriority: 1, category: 'notification',  icon: '📝', activityType: 'internal',           createsActivity: true,  invokesLLM: false, entityScopes: ['requirement', 'system'] },
  daily_report:         { label: 'Daily Report',         defaultPriority: 2, category: 'system',        icon: '📊', activityType: 'internal',           createsActivity: true,  invokesLLM: true,  entityScopes: ['system'] },
  heartbeat:            { label: 'Heartbeat',            defaultPriority: 3, category: 'system',        icon: '♡',  activityType: 'heartbeat',          createsActivity: true,  invokesLLM: true,  entityScopes: ['system'] },
  memory_consolidation: { label: 'Memory Consolidation', defaultPriority: 4, category: 'system',        icon: '🧠', activityType: 'internal',           createsActivity: true,  invokesLLM: true,  entityScopes: ['system'] },
  workflow_update:      { label: 'Workflow Update',      defaultPriority: 2, category: 'task',          icon: '🔄', activityType: 'internal',           createsActivity: true,  invokesLLM: true,  entityScopes: ['task', 'requirement', 'system'] },
  callback_result:      { label: 'Callback Result',      defaultPriority: 1, category: 'system',        icon: '↩',  activityType: 'internal',           createsActivity: true,  invokesLLM: true,  entityScopes: ['conversation', 'system'] },
};

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
  const scopes = MAILBOX_TYPE_REGISTRY[item.sourceType]?.entityScopes ?? ENTITY_SCOPE_ORDER;
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
  | 'dropped';

export interface MailboxItem {
  id: string;
  agentId: string;
  sourceType: MailboxItemType;
  priority: MailboxPriority;
  status: MailboxItemStatus;
  payload: MailboxPayload;
  metadata?: MailboxItemMetadata;
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
  if (item.payload.extra?.triggerExecution) return true;
  if (item.sourceType === 'review_request') return true;
  if (item.sourceType === 'requirement_update' && item.payload.extra?.actionRequired) return true;
  if (item.sourceType === 'workflow_update' && item.payload.extra?.actionRequired) return true;
  return false;
}

/** 是否为「正式任务执行」item（triggerExecution）。是 isStrictStateItem 的特例。 */
export function isTaskExecutionItem(item: {
  sourceType: MailboxItemType;
  payload: MailboxPayload;
}): boolean {
  return item.payload.extra?.triggerExecution === true;
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
  /** When true, this item is a continuation of a previous conversation — not a new request. */
  isResume?: boolean;
  /** For streaming: a promise resolver the caller can await */
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
