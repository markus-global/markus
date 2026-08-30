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

export interface MailboxTypeDescriptor {
  label: string;
  defaultPriority: MailboxPriority;
  category: MailboxCategory;
  icon: string;
  activityType: string | null;
  createsActivity: boolean;
  invokesLLM: boolean;
}

export const MAILBOX_TYPE_REGISTRY: Record<MailboxItemType, MailboxTypeDescriptor> = {
  system_event:         { label: 'System Event',         defaultPriority: 1, category: 'system',       icon: '⚙',  activityType: 'internal',           createsActivity: true,  invokesLLM: true  },
  human_chat:           { label: 'Chat',                 defaultPriority: 0, category: 'interaction',   icon: '💬', activityType: 'chat',               createsActivity: true,  invokesLLM: true  },
  task_comment:         { label: 'Task Comment',         defaultPriority: 2, category: 'task',          icon: '💬', activityType: null,                 createsActivity: false, invokesLLM: false },
  mention:              { label: 'Mention',              defaultPriority: 1, category: 'interaction',   icon: '@',  activityType: 'chat',               createsActivity: true,  invokesLLM: true  },
  session_reply:        { label: 'Session Reply',        defaultPriority: 1, category: 'task',          icon: '↩',  activityType: 'respond_in_session', createsActivity: true,  invokesLLM: true  },
  task_status_update:   { label: 'Task Status',          defaultPriority: 1, category: 'task',          icon: '📋', activityType: null,                 createsActivity: true,  invokesLLM: false },
  a2a_message:          { label: 'Agent Message',        defaultPriority: 2, category: 'interaction',   icon: '🔗', activityType: 'a2a',                createsActivity: true,  invokesLLM: true  },
  review_request:       { label: 'Review Request',       defaultPriority: 1, category: 'task',          icon: '👀', activityType: 'chat',               createsActivity: true,  invokesLLM: true  },
  requirement_comment:  { label: 'Requirement Comment',  defaultPriority: 2, category: 'task',          icon: '💬', activityType: null,                 createsActivity: false, invokesLLM: false },
  requirement_update:   { label: 'Requirement Update',   defaultPriority: 1, category: 'notification',  icon: '📝', activityType: 'internal',           createsActivity: true,  invokesLLM: false },
  daily_report:         { label: 'Daily Report',         defaultPriority: 2, category: 'system',        icon: '📊', activityType: 'internal',           createsActivity: true,  invokesLLM: true  },
  heartbeat:            { label: 'Heartbeat',            defaultPriority: 3, category: 'system',        icon: '♡',  activityType: 'heartbeat',          createsActivity: true,  invokesLLM: true  },
  memory_consolidation: { label: 'Memory Consolidation', defaultPriority: 4, category: 'system',        icon: '🧠', activityType: 'internal',           createsActivity: true,  invokesLLM: true  },
  workflow_update:      { label: 'Workflow Update',      defaultPriority: 2, category: 'task',          icon: '🔄', activityType: 'internal',           createsActivity: true,  invokesLLM: true  },
  callback_result:     { label: 'Callback Result',     defaultPriority: 1, category: 'system',        icon: '↩',  activityType: 'internal',           createsActivity: true,  invokesLLM: true  },
};

export const MAILBOX_CATEGORIES: Record<MailboxCategory, { label: string; types: MailboxItemType[] }> = {
  interaction:  { label: 'Interaction',  types: ['human_chat', 'a2a_message', 'mention'] },
  task:         { label: 'Task',         types: ['task_status_update', 'task_comment', 'requirement_comment', 'review_request', 'session_reply', 'workflow_update'] },
  notification: { label: 'Notification', types: ['requirement_update'] },
  system:       { label: 'System',       types: ['system_event', 'heartbeat', 'daily_report', 'memory_consolidation', 'callback_result'] },
};

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
