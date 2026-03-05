import type { TaskDeliverable } from './governance.js';

export type TaskStatus =
  | 'pending'
  | 'pending_approval'
  | 'assigned'
  | 'in_progress'
  | 'blocked'
  | 'review'
  | 'revision'
  | 'accepted'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'archived';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';
export type TaskExecutionMode = 'cli' | 'api' | 'mcp' | 'gui' | 'hybrid';

export interface Task {
  id: string;
  orgId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  executionMode?: TaskExecutionMode;
  assignedAgentId?: string;
  parentTaskId?: string;
  subtaskIds: string[];
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
  iterationId?: string;
  repositoryPath?: string;
  /** Agent or user who created this task */
  createdBy?: string;
  /** Agent or user who last updated this task */
  updatedBy?: string;
  /** How this task was approved ('auto', 'manager', 'human', 'plan_approval') */
  approvedVia?: string;
  /** Report ID if created from an approved plan */
  planReportId?: string;
  /** Agent assigned to review deliverables */
  reviewerAgentId?: string;
  deliverables?: TaskDeliverable[];
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
