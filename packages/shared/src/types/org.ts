export type HumanRole = 'owner' | 'admin' | 'member' | 'guest';
export type AgentRole = 'manager' | 'worker';

export interface HumanUser {
  id: string;
  name: string;
  email?: string;
  role: HumanRole;
  orgId: string;
  teamId?: string;
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
  memberAgentIds: string[];
  managerId?: string;
  managerType?: 'human' | 'agent';
  humanMemberIds?: string[];
}

export interface TeamMemberInfo {
  id: string;
  name: string;
  type: 'human' | 'agent';
  role: string;
  agentRole?: 'manager' | 'worker';
  status?: string;
  teamId?: string;
  currentTaskId?: string;
}

export interface TeamInfo {
  id: string;
  orgId: string;
  name: string;
  description?: string;
  managerId?: string;
  managerType?: 'human' | 'agent';
  managerName?: string;
  members: TeamMemberInfo[];
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
  /** Team this agent belongs to (if any) */
  team?: {
    id: string;
    name: string;
    description?: string;
  };
  /** Same-team colleagues (primary working group) */
  colleagues: ColleagueInfo[];
  /** Other teams in the org, for cross-team awareness */
  otherTeams?: Array<{
    id: string;
    name: string;
    members: Array<{ id: string; name: string; role: string }>;
  }>;
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
  /** Raw HEARTBEAT.md content — passed to the LLM as a single checklist */
  heartbeatChecklist: string;
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

export interface Policy {
  name: string;
  description: string;
  rules: string[];
}
