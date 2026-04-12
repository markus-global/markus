import type { TaskDeliverable } from './governance.js';

export type ItemStatus =
  | 'pending'
  | 'in_progress'
  | 'blocked'
  | 'review'
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'cancelled'
  | 'archived';

export type TaskStatus = ItemStatus;

/**
 * Declarative task state transition matrix — single source of truth.
 * Must match docs/STATE-MACHINES.md §2.
 *
 * Maps each status to the set of statuses it may legally transition TO.
 * `updateTaskStatus()` rejects any transition not present here.
 */
export const TASK_TRANSITIONS: Readonly<Record<ItemStatus, ReadonlySet<ItemStatus>>> = {
  pending:     new Set<ItemStatus>(['in_progress', 'blocked', 'rejected', 'cancelled']),
  in_progress: new Set<ItemStatus>(['review', 'blocked', 'failed', 'cancelled']),
  blocked:     new Set<ItemStatus>(['in_progress', 'cancelled']),
  review:      new Set<ItemStatus>(['completed', 'in_progress', 'cancelled']),
  completed:   new Set<ItemStatus>(['archived', 'in_progress']),
  failed:      new Set<ItemStatus>(['in_progress', 'archived']),
  rejected:    new Set<ItemStatus>(['archived']),
  cancelled:   new Set<ItemStatus>(['archived']),
  archived:    new Set<ItemStatus>([]),
};

export const TERMINAL_STATUSES: ReadonlySet<ItemStatus> =
  new Set<ItemStatus>(['completed', 'failed', 'rejected', 'cancelled', 'archived']);

/** Check whether a task status transition is structurally valid per the FSM. */
export function isValidTaskTransition(from: ItemStatus, to: ItemStatus): boolean {
  return TASK_TRANSITIONS[from]?.has(to) ?? false;
}

/** @deprecated Use ItemStatus. Kept for backward compat during migration. */
export type LegacyTaskStatus = 'pending_approval' | TaskStatus;
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';
export type TaskExecutionMode = 'cli' | 'api' | 'mcp' | 'gui' | 'hybrid';
export type TaskType = 'standard' | 'scheduled';

export interface ScheduleConfig {
  /** Cron expression, e.g. "0 9 * * 1-5" */
  cron?: string;
  /** Interval shorthand, e.g. "4h", "30m", "1d" */
  every?: string;
  /** IANA timezone, default UTC */
  timezone?: string;
  /** ISO timestamp for one-shot execution */
  runAt?: string;
  /** Max number of runs (undefined = unlimited) */
  maxRuns?: number;
  /** How many times the schedule has fired */
  currentRuns?: number;
  /** ISO timestamp of last execution */
  lastRunAt?: string;
  /** ISO timestamp of next planned execution */
  nextRunAt?: string;
  /** Whether the schedule is paused (task won't be auto-fired) */
  paused?: boolean;
}

export type SubTaskStatus = 'pending' | 'completed' | 'cancelled';

export interface SubTask {
  id: string;
  title: string;
  status: SubTaskStatus;
  createdAt: string;
  completedAt?: string;
}

export interface Task {
  id: string;
  orgId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  executionMode?: TaskExecutionMode;
  assignedAgentId: string;
  subtasks: SubTask[];
  /** Current execution round (increments on revision rejection, reopen, scheduled rerun) */
  executionRound: number;
  /** Task IDs that must be completed before this task can start */
  blockedBy?: string[];
  result?: TaskResult;
  /** Timestamped progress notes added by agents or users */
  notes?: string[];
  createdAt: string;
  updatedAt: string;
  dueAt?: string;
  /** Timeout in ms from when the task starts (transitions to in_progress) */
  timeoutMs?: number;
  /** Timestamp when the task started executing */
  startedAt?: string;
  /** Timestamp when the task was completed/failed/cancelled */
  completedAt?: string;

  // ── Governance fields ──
  /** Requirement that authorized this task */
  requirementId?: string;
  projectId?: string;
  repositoryPath?: string;
  /** Agent or user who created this task */
  createdBy?: string;
  /** Agent or user who last updated this task */
  updatedBy?: string;
  /** How this task was approved ('auto', 'manager', 'human', 'plan_approval') */
  approvedVia?: string;
  /** Report ID if created from an approved plan */
  planReportId?: string;
  /** Agent assigned to review deliverables (required at creation) */
  reviewerAgentId: string;
  deliverables?: TaskDeliverable[];

  // ── Scheduling fields ──
  /** 'standard' (default) or 'scheduled' for cron/recurring tasks */
  taskType?: TaskType;
  /** Schedule configuration for scheduled tasks */
  scheduleConfig?: ScheduleConfig;
}

export type TaskSortField = 'createdAt' | 'updatedAt' | 'priority' | 'status' | 'title';
export type SortOrder = 'asc' | 'desc';

export interface TaskQueryOptions {
  orgId?: string;
  status?: TaskStatus;
  assignedAgentId?: string;
  priority?: TaskPriority;
  projectId?: string;
  requirementId?: string;
  /** Full-text search across title and description */
  search?: string;
  sortBy?: TaskSortField;
  sortOrder?: SortOrder;
  /** 1-based page number (default: 1) */
  page?: number;
  /** Items per page (default: 20, max: 100) */
  pageSize?: number;
}

export interface TaskQueryResult {
  tasks: Task[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface TaskResult {
  success: boolean;
  summary: string;
  artifacts?: TaskArtifact[];
  error?: string;
  durationMs: number;
  tokensUsed: number;
}

export interface TaskArtifact {
  type: 'file' | 'url' | 'text' | 'image';
  name: string;
  content: string;
}
