export interface Organization {
  id: string;
  name: string;
  ownerId: string;
  plan: 'free' | 'pro' | 'enterprise';
  maxAgents: number;
  createdAt: string;
}

export interface Team {
  id: string;
  orgId: string;
  name: string;
  description?: string;
  leadAgentId?: string;
  memberAgentIds: string[];
}

export interface RoleTemplate {
  id: string;
  name: string;
  description: string;
  category: RoleCategory;
  systemPrompt: string;
  defaultSkills: string[];
  defaultHeartbeatTasks: HeartbeatTask[];
  defaultPolicies: Policy[];
  builtIn: boolean;
}

export type RoleCategory =
  | 'engineering'
  | 'product'
  | 'operations'
  | 'marketing'
  | 'customer_service'
  | 'finance'
  | 'legal'
  | 'custom';

export interface HeartbeatTask {
  name: string;
  description: string;
  cronExpression?: string;
  intervalMs?: number;
  enabled: boolean;
}

export interface Policy {
  name: string;
  description: string;
  rules: string[];
}
