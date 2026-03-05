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
  type: 'branch' | 'file' | 'document' | 'report';
  reference: string;
  summary: string;
  diffStats?: { filesChanged: number; additions: number; deletions: number };
  testResults?: { passed: number; failed: number; skipped: number };
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
  deleteWorktreeOnAcceptance: boolean;
  deleteBranchOnArchive: boolean;
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
