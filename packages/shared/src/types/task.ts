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
 * Must match docs/architecture/state-machines.md §2.
 *
 * Maps each status to the set of statuses it may legally transition TO.
 * `updateTaskStatus()` rejects any transition not present here.
 */
export const TASK_TRANSITIONS: Readonly<Record<ItemStatus, ReadonlySet<ItemStatus>>> = {
  pending:     new Set<ItemStatus>(['in_progress', 'blocked', 'rejected', 'cancelled', 'completed']),
  in_progress: new Set<ItemStatus>(['review', 'blocked', 'failed', 'cancelled']),
  blocked:     new Set<ItemStatus>(['in_progress', 'cancelled', 'failed']),
  review:      new Set<ItemStatus>(['completed', 'in_progress', 'cancelled']),
  completed:   new Set<ItemStatus>(['archived', 'in_progress']),
  failed:      new Set<ItemStatus>(['in_progress', 'archived']),
  rejected:    new Set<ItemStatus>(['archived']),
  cancelled:   new Set<ItemStatus>(['archived', 'in_progress']),
  archived:    new Set<ItemStatus>([]),
};

export const TERMINAL_STATUSES: ReadonlySet<ItemStatus> =
  new Set<ItemStatus>(['completed', 'failed', 'rejected', 'cancelled', 'archived']);

/**
 * The one terminal predicate for task/requirement statuses.
 *
 * Everything that needs to answer "is this work over?" calls this — not a local
 * array, not a local `Set`, not `['completed', ...].includes(status)`. The audit
 * (`docs/architecture/hardcoded-string-audit.md` §2) found eight answers to this
 * question, two of them wrong, and every one of them passed its own tests.
 *
 * `blocked` and `review` are deliberately NOT terminal. The FSM is the authority:
 *   - `blocked → in_progress` — the dependency engine releases it by itself, so it
 *     is a live waiting state, not an ending.
 *   - `review → completed | in_progress` — it waits for a human decision.
 * A status with an outgoing edge into active work is alive.
 *
 * Unknown strings answer `false`: a status we do not recognise is not evidence
 * that the work finished.
 *
 * Note: `TERMINAL_REQUIREMENT_STATUSES` (`./requirement.js`) is a *different*
 * question over the same enum — a requirement cannot `fail`. Do not merge them.
 */
export function isTerminal(status: string | null | undefined): boolean {
  return !!status && TERMINAL_STATUSES.has(status as ItemStatus);
}

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

/**
 * 进入 `blocked` 的**原因**（判别位，落库）。
 *
 * 为什么必须有：`blocked` 原本同时表示两件性质完全不同的事——
 *   (a) `deps`：上游依赖没满足。这是**可计算的派生事实**，没有人"决定"过它；
 *   (b) `hold`：人/agent **声明的挂起**（点暂停、agent 声明「停在这里等重启」）。这是意图。
 *
 * 两者共用一个状态值又没有判别位时，依赖引擎只能靠"谁写的/有没有 pausedAt"去猜，
 * 于是把挂起当成等依赖，每轮扫描以「Dependency satisfied」翻回 in_progress
 * （2026-11-03 生产事故，实测多轮拉锯）。判据一旦落进**记录**，读者（引擎）就不需要推断。
 *
 * 兼容：该字段出现之前的旧行是 NULL → 按 `deps` 处理，与旧版本行为完全一致；
 * 旧版本代码不认识本列，直接忽略。见 docs/architecture/state-machines.md §2.1。
 */
export type BlockedReason = 'deps' | 'hold';

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
  /** 进入 blocked 的原因（判别位）。判定只读它，不再从 pausedAt / 写入者身份推断。 */
  blockedReason?: BlockedReason;
  /**
   * 挂起的时间与发起者——**审计信息，不是判定依据**（判定只看 `blockedReason`）。
   * 进入 `hold` 时由 `updateTaskStatus()` 自动填写，`resumeTask()` 清空。
   */
  pausedAt?: string;
  pausedBy?: string;
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
  /**
   * Workflow identity — structural, not derived.
   *
   * A task created by a workflow run belongs to exactly one `(run, step)`. These
   * two columns are that identity. Before them the relationship was reconstructed
   * from a `step: <id>` marker inside `notes` and, failing that, from a title
   * suffix — i.e. structure inferred from payload, which breaks the moment a
   * human edits a title.
   */
  workflowRunId?: string;
  workflowStepId?: string;
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
  /** Agent or human assigned to review deliverables (required at creation) */
  reviewerId: string;
  /** Whether the reviewer is an agent or a human user (default: 'agent') */
  reviewerType?: 'agent' | 'human';
  deliverables?: TaskDeliverable[];
  /** Agent's completion summary (set on task_submit_review) */
  completionSummary?: string;

  // ── Scheduling fields ──
  /** 'standard' (default) or 'scheduled' for cron/recurring tasks */
  taskType?: TaskType;
  /** Schedule configuration for scheduled tasks */
  scheduleConfig?: ScheduleConfig;
}

// ─── Status Transition History ─────────────────────────────────────────────

export type StatusActorType = 'human' | 'agent' | 'system';

export interface StatusTransition {
  id: number;
  entityType: 'task' | 'requirement';
  entityId: string;
  fromStatus: string;
  toStatus: string;
  changedById: string | null;
  changedByType: StatusActorType;
  changedByName: string | null;
  reason: string | null;
  createdAt: string;
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
