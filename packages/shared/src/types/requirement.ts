import type { TaskPriority, ItemStatus } from './task.js';

export type RequirementStatus = ItemStatus;

/** @deprecated Use ItemStatus. Kept for backward compat during migration. */
export type LegacyRequirementStatus = 'pending_review' | 'approved' | RequirementStatus;

export type RequirementSource = 'user' | 'agent';

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
  /** IDs of tasks created to fulfill this requirement */
  taskIds: string[];
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}
