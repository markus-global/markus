import type { TaskPriority, ItemStatus, BlockedReason } from './task.js';

export type RequirementStatus = ItemStatus;

/**
 * Declarative requirement state-transition matrix — single source of truth.
 *
 * Requirements share `ItemStatus` with tasks but have their own flow: they do not
 * go through a task `review` hand-off in normal operation, but (like a task) they
 * MAY be `blocked` — with a reason (`deps` | `hold` | `workflow`) — and they may be
 * reopened. Before this matrix existed, `requirement-service` only checked enum
 * membership and then did `req.status = newStatus`, so ANY status could become ANY
 * other (e.g. `completed → pending`), i.e. it was a loop wearing enum names.
 *
 * Maps each status to the statuses it may legally transition TO.
 */
export const REQ_TRANSITIONS: Readonly<Record<RequirementStatus, ReadonlySet<RequirementStatus>>> = {
  pending:     new Set<RequirementStatus>(['in_progress', 'blocked', 'rejected', 'cancelled']),
  in_progress: new Set<RequirementStatus>(['completed', 'blocked', 'rejected', 'cancelled']),
  blocked:     new Set<RequirementStatus>(['in_progress', 'rejected', 'cancelled']),
  review:      new Set<RequirementStatus>(['completed', 'in_progress', 'cancelled']),
  completed:   new Set<RequirementStatus>(['archived', 'in_progress']),
  failed:      new Set<RequirementStatus>(['in_progress', 'archived', 'pending']),
  rejected:    new Set<RequirementStatus>(['in_progress', 'archived', 'pending']),
  cancelled:   new Set<RequirementStatus>(['in_progress', 'archived', 'pending']),
  archived:    new Set<RequirementStatus>([]),
};

/** Check whether a requirement status transition is structurally valid per the FSM. */
export function isValidRequirementTransition(from: RequirementStatus, to: RequirementStatus): boolean {
  return REQ_TRANSITIONS[from]?.has(to) ?? false;
}

/** @deprecated Use ItemStatus. Kept for backward compat during migration. */
export type LegacyRequirementStatus = 'pending_review' | 'approved' | RequirementStatus;

export type RequirementSource = 'user' | 'agent' | 'workflow';

export interface GoalConfig {
  loopEnabled: boolean;
  completionCriteria: string;
  maxIterations: number;
  currentIteration: number;
  lastCheckedAt: string;
  autoResume: boolean;
}

export interface Requirement {
  id: string;
  orgId: string;
  projectId?: string;
  title: string;
  description: string;
  status: RequirementStatus;
  /** Why this requirement is `blocked` — same discriminant as a task's. */
  blockedReason?: BlockedReason | null;
  priority: TaskPriority;
  source: RequirementSource;
  /** User ID or agent ID who created this requirement */
  createdBy: string;
  /** User who approved this requirement */
  approvedBy?: string;
  approvedAt?: string;
  rejectedReason?: string;
  /** User or actor who rejected this requirement */
  rejectedBy?: string;
  /** IDs of tasks created to fulfill this requirement */
  taskIds: string[];
  tags?: string[];
  /** Goal loop configuration — when set, the requirement acts as a persistent goal */
  goalConfig?: GoalConfig;
  createdAt: string;
  updatedAt: string;
}
