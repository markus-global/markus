import type { TaskGovernancePolicy, ArchivePolicy } from './governance.js';

// ─── Project ─────────────────────────────────────────────────────────────────

export type ProjectStatus = 'active' | 'paused' | 'archived';
export type IterationModel = 'sprint' | 'kanban';

export interface Project {
  id: string;
  orgId: string;
  name: string;
  description: string;
  status: ProjectStatus;
  iterationModel: IterationModel;
  repositories: ProjectRepository[];
  teamIds: string[];
  governancePolicy?: TaskGovernancePolicy;
  archivePolicy?: ArchivePolicy;
  reportSchedule?: ReportSchedule;
  onboardingConfig?: ProjectOnboardingConfig;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRepository {
  url?: string;
  localPath: string;
  defaultBranch: string;
  role: 'primary' | 'secondary';
}

export interface ProjectOnboardingConfig {
  contextFiles: string[];
  architectureDoc?: string;
  conventionsDoc?: string;
  keyDirectories?: string[];
}

// ─── Iteration ───────────────────────────────────────────────────────────────

export type IterationStatus = 'planning' | 'active' | 'review' | 'completed';

export interface Iteration {
  id: string;
  projectId: string;
  name: string;
  status: IterationStatus;
  goal?: string;
  startDate?: string;
  endDate?: string;
  metrics?: IterationMetrics;
  reviewReport?: IterationReviewReport;
  createdAt: string;
  updatedAt: string;
}

export interface IterationMetrics {
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  velocity?: number;
  burndownData?: Array<{ date: string; remaining: number }>;
}

export interface IterationReviewReport {
  summary: string;
  completedItems: string[];
  carriedOver: string[];
  blockers: string[];
  generatedAt: string;
  generatedBy: string;
}

// ─── Report ──────────────────────────────────────────────────────────────────

export type ReportPeriod = 'daily' | 'weekly' | 'monthly';
export type ReportScope = 'agent' | 'team' | 'project' | 'iteration' | 'org';
export type ReportStatus = 'generating' | 'ready' | 'reviewed' | 'archived';

export interface Report {
  id: string;
  type: ReportPeriod;
  scope: ReportScope;
  scopeId: string;
  periodStart: string;
  periodEnd: string;
  status: ReportStatus;
  metrics: ReportMetrics;
  taskSummary: ReportTaskSummary;
  costSummary: ReportCostSummary;
  highlights?: string;
  blockers?: string;
  learnings?: string;
  upcomingPlan?: ReportPlan;
  generatedAt: string;
  generatedBy: string;
  reviewedBy?: string;
  reviewedAt?: string;
}

export interface ReportMetrics {
  tasksCompleted: number;
  tasksFailed: number;
  tasksCreated: number;
  tasksInProgress: number;
  tasksBlocked: number;
  avgCompletionTimeMs: number;
  totalTokensUsed: number;
  estimatedCost: number;
  knowledgeContributions: number;
  reviewAcceptanceRate?: number;
}

export interface ReportTaskSummary {
  completed: Array<{ id: string; title: string; agent: string; durationMs: number }>;
  inProgress: Array<{ id: string; title: string; agent: string; startedAt: string }>;
  blocked: Array<{ id: string; title: string; agent: string; reason: string }>;
  carriedOver: Array<{ id: string; title: string; reason: string }>;
}

export interface ReportCostSummary {
  totalTokens: number;
  totalEstimatedCost: number;
  byAgent: Array<{ agentId: string; agentName: string; tokens: number; cost: number }>;
  byCategory: Array<{ category: string; tokens: number; cost: number }>;
  trend: 'increasing' | 'stable' | 'decreasing';
}

export type PlanStatus = 'draft' | 'pending_approval' | 'approved' | 'rejected';

export interface ReportPlan {
  status: PlanStatus;
  goals: string[];
  plannedTasks: Array<{
    title: string;
    description: string;
    assignedAgent?: string;
    priority: string;
    estimatedEffort?: string;
  }>;
  approvedBy?: string;
  approvedAt?: string;
  rejectionReason?: string;
}

export interface ReportSchedule {
  daily?: ReportScheduleEntry & { includePlan?: false };
  weekly?: ReportScheduleEntry & { includePlan: boolean; requirePlanApproval: boolean };
  monthly?: ReportScheduleEntry & { includePlan: boolean; requirePlanApproval: boolean };
  iterationEnd?: {
    enabled: boolean;
    scope: 'iteration';
    agentEnriched: boolean;
    includePlan: boolean;
    requirePlanApproval: boolean;
  };
}

export interface ReportScheduleEntry {
  enabled: boolean;
  cronExpression: string;
  scope: ReportScope;
  agentEnriched: boolean;
}

// ─── Knowledge ───────────────────────────────────────────────────────────────

export type KnowledgeScope = 'personal' | 'project' | 'org';
export type KnowledgeStatus = 'draft' | 'verified' | 'outdated' | 'disputed';

export type KnowledgeCategory =
  | 'architecture'
  | 'convention'
  | 'api'
  | 'decision'
  | 'gotcha'
  | 'troubleshooting'
  | 'dependency'
  | 'process'
  | 'reference';

export interface KnowledgeEntry {
  id: string;
  scope: KnowledgeScope;
  scopeId: string;
  category: KnowledgeCategory;
  title: string;
  content: string;
  tags: string[];
  source: string;
  importance: number;
  status: KnowledgeStatus;
  verifiedBy?: string;
  supersedes?: string;
  accessCount: number;
  lastAccessedAt?: string;
  createdAt: string;
  updatedAt: string;
}
