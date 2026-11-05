import type { TaskPriority, ItemStatus } from './task.js';

export type RequirementStatus = ItemStatus;

/**
 * 需求终态：不再发出任何行动型提醒，也不再接受新任务。
 * 单一事实源——需求服务与任务服务共用，不得各自内联一份字符串数组。
 */
export const TERMINAL_REQUIREMENT_STATUSES: ReadonlySet<RequirementStatus> = new Set<RequirementStatus>([
  'completed',
  'rejected',
  'cancelled',
  'archived',
]);

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
