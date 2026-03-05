import type { TaskPriority } from './task.js';

export type RequirementStatus =
  | 'draft'
  | 'pending_review'
  | 'approved'
  | 'in_progress'
  | 'completed'
  | 'rejected'
  | 'cancelled';

export type RequirementSource = 'user' | 'agent';

export interface Requirement {
  id: string;
  orgId: string;
  projectId?: string;
  iterationId?: string;
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
