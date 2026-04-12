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

export interface ChannelBinding {
  platform: 'feishu' | 'whatsapp' | 'slack' | 'telegram' | 'webui';
  channelId: string;
  role: 'member' | 'observer';
}

export type AgentActivityType = 'task' | 'heartbeat' | 'chat' | 'a2a' | 'internal' | 'respond_in_session';

export interface AgentActivity {
  /** Unique ID for this activity session */
  id: string;
  type: AgentActivityType;
  label: string;
  /** For task type, the task ID */
  taskId?: string;
  /** Links this activity back to the mailbox item that triggered it */
  mailboxItemId?: string;
  /** For heartbeat type, the heartbeat task name */
  heartbeatName?: string;
  startedAt: string;
}

export interface AgentActivityLogEntry {
  seq: number;
  type: 'status' | 'text' | 'tool_start' | 'tool_end' | 'error' | 'llm_request';
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

// ─── Unified Execution Stream ────────────────────────────────────────────────

export type ExecutionStreamSourceType = 'task' | 'activity' | 'chat';

export interface ExecutionStreamEntry {
  id: string;
  sourceType: ExecutionStreamSourceType;
  sourceId: string;
  agentId: string;
  seq: number;
  type: 'status' | 'text' | 'tool_start' | 'tool_end' | 'error';
  content: string;
  metadata?: Record<string, unknown>;
  executionRound?: number;
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

/**
 * File access policy for agent tools.
 *
 * Philosophy: the platform provides the environment, not rigid constraints.
 * Agents can write anywhere except other agents' directories.
 * The `primaryWorkspace` is the default working directory and prompt context,
 * not a hard write boundary.
 */
export interface PathAccessPolicy {
  /** Agent's own workspace — used as default cwd for shell and path resolution */
  primaryWorkspace: string;
  /** Shared deliverables area — used in prompt context */
  sharedWorkspace?: string;
  /** Agent's own role files directory */
  roleDir?: string;
  /** Team shared data directory */
  teamDataDir?: string;
  /** Builder artifacts directory */
  builderArtifactsDir?: string;
  /** Paths where writes are hard-blocked (other agents' directories) */
  denyWritePaths?: string[];
}
