/**
 * Agent-to-Agent (A2A) Protocol types.
 * Based on Google's A2A specification adapted for Markus.
 */

export type A2AMessageType =
  | 'task_delegate'
  | 'task_update'
  | 'task_complete'
  | 'task_failed'
  | 'info_request'
  | 'info_response'
  | 'collaboration_invite'
  | 'collaboration_accept'
  | 'collaboration_decline'
  | 'heartbeat_ping'
  | 'heartbeat_pong'
  // 新增结构化消息类型
  | 'resource_request'
  | 'resource_response'
  | 'progress_sync'
  | 'capability_discovery'
  | 'status_broadcast';

export interface A2AEnvelope {
  id: string;
  type: A2AMessageType;
  from: string;
  to: string;
  timestamp: string;
  correlationId?: string;
  payload: unknown;
  version?: string; // 协议版本，默认为"1.0"
}

export interface TaskDelegation {
  taskId: string;
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  deadline?: string;
  context?: string;
  expectedOutput?: string;
}

export interface TaskUpdate {
  taskId: string;
  status: string;
  progress?: number;
  message?: string;
  artifacts?: Array<{ name: string; type: string; content: string }>;
}

export interface InfoRequest {
  question: string;
  context?: string;
  urgency?: 'low' | 'normal' | 'high';
}

export interface InfoResponse {
  answer: string;
  confidence?: number;
  sources?: string[];
}

export interface CollaborationInvite {
  sessionId: string;
  topic: string;
  description: string;
  participants: string[];
}

export interface AgentCard {
  agentId: string;
  name: string;
  role: string;
  capabilities: string[];
  skills: string[];
  status: string;
  endpoint?: string;
}

// ======================
// 新增结构化消息接口
// ======================

/**
 * 资源请求消息
 * 用于Agent向其他Agent请求资源（如计算资源、数据、工具访问权限等）
 */
export interface ResourceRequest {
  requestId: string;
  resourceType: 'compute' | 'storage' | 'tool' | 'data' | 'network' | 'other';
  resourceName: string;
  description: string;
  requirements?: {
    cpu?: number;  // CPU核心数
    memory?: number; // 内存大小（MB）
    timeout?: number; // 超时时间（毫秒）
    [key: string]: unknown;
  };
  urgency?: 'low' | 'normal' | 'high' | 'critical';
  deadline?: string; // ISO时间戳
}

/**
 * 资源响应消息
 * 用于响应资源请求
 */
export interface ResourceResponse {
  requestId: string;
  granted: boolean;
  reason?: string;
  resourceInfo?: {
    endpoint?: string;
    credentials?: Record<string, string>;
    quota?: Record<string, number>;
    expiresAt?: string; // ISO时间戳
  };
  alternatives?: Array<{
    agentId: string;
    capability: string;
    contactInfo?: string;
  }>;
}

/**
 * 进度同步消息
 * 用于Agent间同步任务进度，支持复杂任务的协作
 */
export interface ProgressSync {
  taskId: string;
  phase: string;
  progress: number; // 0-100
  status: 'pending' | 'in_progress' | 'blocked' | 'completed' | 'failed';
  message?: string;
  artifacts?: Array<{
    name: string;
    type: string;
    url?: string;
    content?: string;
    size?: number;
  }>;
  dependencies?: Array<{
    taskId: string;
    status: string;
    required: boolean;
  }>;
  estimatedCompletion?: string; // ISO时间戳
}

/**
 * 能力发现消息
 * 用于Agent发现其他Agent的能力和技能
 */
export interface CapabilityDiscovery {
  discoveryId: string;
  query?: {
    skills?: string[];
    capabilities?: string[];
    status?: string[];
    minAvailability?: number; // 0-100
  };
  response?: {
    agentId: string;
    name: string;
    role: string;
    skills: string[];
    capabilities: string[];
    currentLoad: number; // 0-100
    availability: 'idle' | 'working' | 'busy' | 'offline';
    endpoint?: string;
  };
}

/**
 * 状态广播消息
 * 用于Agent向组织广播状态变化
 */
export interface StatusBroadcast {
  agentId: string;
  status: 'idle' | 'working' | 'busy' | 'blocked' | 'offline';
  currentTask?: {
    taskId: string;
    title: string;
    progress: number;
  };
  load: number; // 0-100
  capabilities: string[];
  availableForWork: boolean;
  nextAvailable?: string; // ISO时间戳
  health?: {
    cpu: number;
    memory: number;
    uptime: number;
    errors: number;
  };
}
