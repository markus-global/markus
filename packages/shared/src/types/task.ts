export type TaskStatus = 'pending' | 'assigned' | 'in_progress' | 'blocked' | 'completed' | 'failed' | 'cancelled';
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
  result?: TaskResult;
  /** Timestamped progress notes added by agents or users */
  notes?: string[];
  createdAt: string;
  updatedAt: string;
  dueAt?: string;
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
