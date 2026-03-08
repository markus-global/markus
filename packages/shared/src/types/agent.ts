export type AgentStatus = 'idle' | 'working' | 'paused' | 'offline' | 'error';

export interface AgentConfig {
  id: string;
  name: string;
  roleId: string;
  orgId: string;
  teamId?: string;
  agentRole: 'manager' | 'worker';
  skills: string[];
  profile?: AgentProfile;
  llmConfig: LLMAssignment;
  computeConfig: ComputeAssignment;
  channels: ChannelBinding[];
  heartbeatIntervalMs: number;
  createdAt: string;
  updatedAt: string;
}

export interface LLMAssignment {
  /** 'default' follows system default provider; 'custom' uses a fixed provider */
  modelMode: 'default' | 'custom';
  primary: string;
  fallback?: string;
  maxTokensPerRequest?: number;
  maxTokensPerDay?: number;
}

export interface ComputeAssignment {
  type: 'docker' | 'vm';
  image?: string;
  cpu?: number;
  memoryMb?: number;
  diskMb?: number;
  gpuEnabled?: boolean;
}

export interface ChannelBinding {
  platform: 'feishu' | 'whatsapp' | 'slack' | 'telegram' | 'webui';
  channelId: string;
  role: 'member' | 'observer';
}

export interface AgentActivity {
  /** Unique ID for this activity session */
  id: string;
  type: 'task' | 'heartbeat' | 'chat';
  label: string;
  /** For task type, the task ID */
  taskId?: string;
  /** For heartbeat type, the heartbeat task name */
  heartbeatName?: string;
  startedAt: string;
}

export interface AgentActivityLogEntry {
  seq: number;
  type: 'status' | 'text' | 'tool_start' | 'tool_end' | 'error';
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface AgentState {
  agentId: string;
  status: AgentStatus;
  /** Number of tasks currently being executed concurrently */
  activeTaskCount: number;
  /** IDs of tasks currently being executed */
  activeTaskIds: string[];
  currentTaskId?: string;
  /** Describes what the agent is currently doing (task, heartbeat, chat) */
  currentActivity?: AgentActivity;
  lastHeartbeat?: string;
  containerId?: string;
  memoryUsageMb?: number;
  tokensUsedToday: number;
  /** Most recent error message (set when status transitions to 'error') */
  lastError?: string;
  lastErrorAt?: string;
}

export interface AgentProfile {
  /** Allowed tool names — if set, agent can ONLY use these tools */
  toolWhitelist?: string[];
  /** Denied tool names — if set, these tools are blocked even if otherwise available */
  toolBlacklist?: string[];
  /** Maximum tokens this agent can consume per single task */
  maxTokensPerTask?: number;
  /** Maximum tokens per day across all interactions */
  maxTokensPerDay?: number;
  /** Maximum concurrent tasks */
  maxConcurrentTasks?: number;
  /** Operations that require human approval before execution */
  requireApprovalFor?: string[];
  /** Working directory constraint — agent tools restricted to this path */
  workspacePath?: string;
}
