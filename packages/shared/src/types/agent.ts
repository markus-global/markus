export type AgentStatus = 'idle' | 'working' | 'paused' | 'offline' | 'error';

export interface AgentConfig {
  id: string;
  name: string;
  roleId: string;
  orgId: string;
  teamId?: string;
  agentRole: 'manager' | 'worker';
  skills: string[];
  llmConfig: LLMAssignment;
  computeConfig: ComputeAssignment;
  channels: ChannelBinding[];
  heartbeatIntervalMs: number;
  createdAt: string;
  updatedAt: string;
}

export interface LLMAssignment {
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

export interface AgentState {
  agentId: string;
  status: AgentStatus;
  /** Number of tasks currently being executed concurrently */
  activeTaskCount: number;
  /** IDs of tasks currently being executed */
  activeTaskIds: string[];
  currentTaskId?: string;
  lastHeartbeat?: string;
  containerId?: string;
  memoryUsageMb?: number;
  tokensUsedToday: number;
}
