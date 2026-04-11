// ─── Mailbox Types ──────────────────────────────────────────────────────────

export type MailboxItemType =
  | 'human_chat'
  | 'a2a_message'
  | 'task_assignment'
  | 'task_status_update'
  | 'task_comment'
  | 'heartbeat'
  | 'review_request'
  | 'requirement_update'
  | 'mention'
  | 'system_event'
  | 'session_reply'
  | 'daily_report'
  | 'memory_consolidation';

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
  system_event:         { label: 'System Event',         defaultPriority: 0, category: 'system',       icon: '⚙',  activityType: 'internal',           createsActivity: true,  invokesLLM: true  },
  human_chat:           { label: 'Chat',                 defaultPriority: 0, category: 'interaction',   icon: '💬', activityType: 'chat',               createsActivity: true,  invokesLLM: true  },
  task_assignment:      { label: 'Task',                 defaultPriority: 1, category: 'task',          icon: '☑',  activityType: 'task',               createsActivity: true,  invokesLLM: true  },
  task_comment:         { label: 'Task Comment',         defaultPriority: 0, category: 'task',          icon: '💬', activityType: null,                 createsActivity: false, invokesLLM: false },
  mention:              { label: 'Mention',              defaultPriority: 1, category: 'interaction',   icon: '@',  activityType: 'chat',               createsActivity: true,  invokesLLM: true  },
  session_reply:        { label: 'Session Reply',        defaultPriority: 1, category: 'task',          icon: '↩',  activityType: 'respond_in_session', createsActivity: true,  invokesLLM: true  },
  task_status_update:   { label: 'Task Status',          defaultPriority: 2, category: 'notification',  icon: '📋', activityType: 'internal',           createsActivity: true,  invokesLLM: true  },
  a2a_message:          { label: 'Agent Message',        defaultPriority: 2, category: 'interaction',   icon: '🔗', activityType: 'a2a',                createsActivity: true,  invokesLLM: true  },
  review_request:       { label: 'Review Request',       defaultPriority: 2, category: 'task',          icon: '👀', activityType: 'chat',               createsActivity: true,  invokesLLM: true  },
  requirement_update:   { label: 'Requirement Update',   defaultPriority: 2, category: 'notification',  icon: '📝', activityType: 'internal',           createsActivity: true,  invokesLLM: true  },
  daily_report:         { label: 'Daily Report',         defaultPriority: 2, category: 'system',        icon: '📊', activityType: 'internal',           createsActivity: true,  invokesLLM: true  },
  heartbeat:            { label: 'Heartbeat',            defaultPriority: 3, category: 'system',        icon: '♡',  activityType: 'heartbeat',          createsActivity: true,  invokesLLM: true  },
  memory_consolidation: { label: 'Memory Consolidation', defaultPriority: 4, category: 'system',        icon: '🧠', activityType: 'internal',           createsActivity: true,  invokesLLM: true  },
};

export const MAILBOX_CATEGORIES: Record<MailboxCategory, { label: string; types: MailboxItemType[] }> = {
  interaction:  { label: 'Interaction',  types: ['human_chat', 'a2a_message', 'mention'] },
  task:         { label: 'Task',         types: ['task_assignment', 'task_comment', 'review_request', 'session_reply'] },
  notification: { label: 'Notification', types: ['task_status_update', 'requirement_update'] },
  system:       { label: 'System',       types: ['system_event', 'heartbeat', 'daily_report', 'memory_consolidation'] },
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
}

export interface MailboxPayload {
  summary: string;
  content: string;
  /** For task_assignment / task_status_update */
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
  sessionId?: string;
  taskId?: string;
  channelContext?: string;
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
  | 'defer'
  | 'merge'
  | 'delegate'
  | 'drop';

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
  }>;
  deferredItems: Array<{
    id: string;
    sourceType: MailboxItemType;
    summary: string;
    deferredUntil?: string;
  }>;
  recentDecisions: AttentionDecision[];
}

// ─── User Notification Type Registry ─────────────────────────────────────────

export type UserNotificationType =
  | 'approval_request'
  | 'bounty_posted'
  | 'task_completed'
  | 'agent_alert'
  | 'system'
  | 'agent_report'
  | 'agent_chat_request'
  | 'task_status_changed'
  | 'requirement_decision'
  | 'agent_escalation'
  | 'mention'
  | 'task_created'
  | 'requirement_created';

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
  bounty_posted:       { label: 'Bounty Posted',         icon: '🎯', defaultPriority: 'normal', actionType: 'navigate',  category: 'task' },
  task_completed:      { label: 'Task Completed',        icon: '✅', defaultPriority: 'normal', actionType: 'navigate',  category: 'task' },
  task_created:        { label: 'Task Created',          icon: '📋', defaultPriority: 'normal', actionType: 'navigate',  category: 'task' },
  task_status_changed: { label: 'Task Status Changed',   icon: '🔄', defaultPriority: 'normal', actionType: 'navigate',  category: 'task' },
  requirement_created: { label: 'Requirement Proposed',  icon: '📝', defaultPriority: 'high',   actionType: 'navigate',  category: 'task' },
  requirement_decision:{ label: 'Requirement Decision',  icon: '⚖️', defaultPriority: 'normal', actionType: 'navigate',  category: 'task' },
  agent_alert:         { label: 'Agent Alert',           icon: '⚠️', defaultPriority: 'high',   actionType: 'none',      category: 'agent' },
  agent_report:        { label: 'Agent Report',          icon: '📊', defaultPriority: 'normal', actionType: 'none',      category: 'agent' },
  agent_chat_request:  { label: 'Chat Request',          icon: '💬', defaultPriority: 'normal', actionType: 'open_chat', category: 'agent' },
  agent_escalation:    { label: 'Agent Escalation',      icon: '🚨', defaultPriority: 'high',   actionType: 'open_chat', category: 'agent' },
  mention:             { label: 'Mention',               icon: '@',  defaultPriority: 'normal', actionType: 'navigate',  category: 'system' },
  system:              { label: 'System',                icon: '⚙️', defaultPriority: 'normal', actionType: 'none',      category: 'system' },
};
