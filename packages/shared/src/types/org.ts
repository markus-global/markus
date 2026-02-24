export type HumanRole = 'owner' | 'admin' | 'member' | 'guest';
export type AgentRole = 'manager' | 'worker';

export interface HumanUser {
  id: string;
  name: string;
  email?: string;
  role: HumanRole;
  orgId: string;
  avatar?: string;
  preferences?: Record<string, unknown>;
  createdAt: string;
}

export interface Organization {
  id: string;
  name: string;
  ownerId: string;
  managerAgentId?: string;
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

export interface ColleagueInfo {
  id: string;
  name: string;
  role: string;
  type: 'human' | 'agent';
  skills?: string[];
  status?: string;
}

export interface IdentityContext {
  self: {
    id: string;
    name: string;
    role: string;
    agentRole: AgentRole;
    skills: string[];
  };
  organization: {
    id: string;
    name: string;
  };
  colleagues: ColleagueInfo[];
  humans: Array<{
    id: string;
    name: string;
    role: HumanRole;
  }>;
  manager?: {
    id: string;
    name: string;
  };
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
