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
  | 'heartbeat_pong';

export interface A2AEnvelope {
  id: string;
  type: A2AMessageType;
  from: string;
  to: string;
  timestamp: string;
  correlationId?: string;
  payload: unknown;
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
