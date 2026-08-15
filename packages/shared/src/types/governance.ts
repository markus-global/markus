// ─── Task Governance ─────────────────────────────────────────────────────────

export interface TaskGovernancePolicy {
  enabled: boolean;
  rules: TaskApprovalRule[];
  defaultTier: ApprovalTier;
  maxPendingTasksPerAgent: number;
  maxTotalActiveTasks: number;
  requireApprovalForPriority: string[];
  /** When true, top-level tasks must reference an approved requirement */
  requireRequirement: boolean;
}

export type ApprovalTier = 'auto' | 'manager' | 'human';

export interface TaskApprovalRule {
  condition: {
    creatorRole?: 'worker' | 'manager';
    priority?: string[];
    titlePattern?: string;
    affectsSharedResource?: boolean;
  };
  tier: ApprovalTier;
}

// ─── System Announcements ────────────────────────────────────────────────────

export type AnnouncementType = 'info' | 'warning' | 'directive' | 'policy_change';
export type AnnouncementPriority = 'normal' | 'high' | 'urgent';
export type AnnouncementScope = 'all' | 'team' | 'role' | 'project';

export interface SystemAnnouncement {
  id: string;
  type: AnnouncementType;
  title: string;
  content: string;
  priority: AnnouncementPriority;
  createdBy: string;
  createdAt: string;
  expiresAt?: string;
  targetScope: AnnouncementScope;
  targetIds?: string[];
  acknowledged: string[];
}

// ─── Task Delivery ───────────────────────────────────────────────────────────

export interface TaskDeliverable {
  /** @deprecated 'branch' type is no longer produced — kept temporarily for backward compat during migration */
  type: 'branch' | DeliverableType;
  reference: string;
  summary: string;
  format?: string;
  diffStats?: { filesChanged: number; additions: number; deletions: number };
  testResults?: { passed: number; failed: number; skipped: number };
}

// ─── Unified Deliverable (产出物) ────────────────────────────────────────────

export type DeliverableType = 'file' | 'directory';
export type DeliverableStatus = 'active' | 'verified' | 'outdated';
export type BuilderArtifactType = 'agent' | 'team' | 'skill';

export interface Deliverable {
  id: string;
  type: DeliverableType;
  title: string;
  summary: string;
  reference: string;
  format?: string;
  tags: string[];
  status: DeliverableStatus;
  taskId?: string;
  agentId?: string;
  projectId?: string;
  requirementId?: string;
  artifactType?: BuilderArtifactType;
  artifactData?: Record<string, unknown>;
  diffStats?: { filesChanged: number; additions: number; deletions: number };
  testResults?: { passed: number; failed: number; skipped: number };
  accessCount: number;
  createdAt: string;
  updatedAt: string;
  /** Monotonic content version (STATE-MACHINES Spec). */
  version?: number;
  /** Short changelog entries for version bumps. */
  changelog?: string[];
  // ─── 产出物分享到 Hub（可空，后端 DTO 必须带出以支撑前端分享状态回显） ────
  /** 最近一次分享在 Hub 上的记录 id（dlv_share_…） */
  hubShareId?: string | null;
  /** none | pending_review | published | rejected | revoked */
  shareStatus?: string | null;
  /** 分享链接（published 后回填） */
  shareUrl?: string | null;
  /** public | link（无 private；none=未分享） */
  shareVisibility?: string | null;
  /** 拒绝原因（Hub 拒绝时回填；客户端在「已拒绝」徽标展示） */
  shareReason?: string | null;
}

// ─── User Input Requests (request_user_input / HITL) ─────────────────────────

export interface UserInputOption {
  id: string;
  /** Markdown-supported label shown for the option. */
  label: string;
  /** Optional Markdown-supported extra detail. */
  description?: string;
}

export interface UserInputQuestion {
  id: string;
  /** The question text (Markdown supported). */
  prompt: string;
  /** choice = pick from options; text = freeform answer. */
  inputType: 'choice' | 'text';
  options?: UserInputOption[];
  allowMultiple?: boolean;
  allowFreeform?: boolean;
}

export interface UserInputAnswer {
  questionId: string;
  /** Selected option id(s) for a choice question. */
  selectedOptionIds?: string[];
  /** Freeform / text answer. */
  text?: string;
}

// ─── Agent Trust ─────────────────────────────────────────────────────────────

export type TrustLevel = 'probation' | 'standard' | 'trusted' | 'senior';

export interface AgentTrustLevel {
  agentId: string;
  level: TrustLevel;
  score: number;
  totalDeliveries: number;
  acceptedDeliveries: number;
  rejectedDeliveries: number;
  revisionRequests: number;
  consecutiveAcceptances: number;
  lastEvaluatedAt: string;
}

// ─── Archive Policy ──────────────────────────────────────────────────────────

export interface ArchivePolicy {
  autoArchiveAfterDays: number;
  retainTaskLogsForDays: number;
  retainAuditLogsForDays: number;
}

// ─── Report Feedback ─────────────────────────────────────────────────────────

export type FeedbackType = 'annotation' | 'comment' | 'directive';
export type FeedbackDisclosureScope = 'private' | 'targeted' | 'broadcast';

export interface ReportFeedback {
  id: string;
  reportId: string;
  authorId: string;
  authorName: string;
  type: FeedbackType;
  anchor?: {
    section: string;
    itemId?: string;
  };
  content: string;
  priority: 'normal' | 'important' | 'critical';
  disclosure: {
    scope: FeedbackDisclosureScope;
    targetAgentIds?: string[];
    targetTeamIds?: string[];
  };
  actions: FeedbackAction[];
  createdAt: string;
}

export type FeedbackAction =
  | { type: 'announcement'; announcementId: string }
  | { type: 'knowledge'; knowledgeId: string }
  | { type: 'task_created'; taskId: string }
  | { type: 'a2a_message'; targetAgentId: string };
