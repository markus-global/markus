/**
 * Cross-Org Federation types.
 *
 * Federation enables agents from different organizations to discover each other,
 * establish trust relationships, and collaborate across org boundaries with
 * sandboxed security controls.
 */

export type FederationStatus = 'pending' | 'active' | 'suspended' | 'revoked';
export type TrustLevel = 'none' | 'discovery' | 'messaging' | 'task_delegation' | 'full';

export interface FederationLink {
  id: string;
  sourceOrgId: string;
  targetOrgId: string;
  status: FederationStatus;
  trustLevel: TrustLevel;
  /** Which agent capabilities are shared (empty = all) */
  sharedCapabilities: string[];
  /** Maximum concurrent cross-org tasks */
  maxConcurrentTasks: number;
  /** Rate limit: messages per minute */
  rateLimitPerMinute: number;
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date;
}

export interface FederatedAgent {
  agentId: string;
  agentName: string;
  orgId: string;
  orgName: string;
  capabilities: string[];
  agentRole: 'manager' | 'worker';
  availableForDelegation: boolean;
}

export interface CrossOrgMessage {
  id: string;
  sourceOrgId: string;
  sourceAgentId: string;
  targetOrgId: string;
  targetAgentId: string;
  type: 'request' | 'response' | 'notification' | 'task_delegation';
  content: string;
  metadata?: Record<string, unknown>;
  correlationId?: string;
  timestamp: Date;
  /** Sandbox restrictions applied to this message */
  sandbox: SandboxPolicy;
}

export interface SandboxPolicy {
  /** Allow file system access in target org */
  allowFileAccess: boolean;
  /** Allow shell commands in target org */
  allowShellAccess: boolean;
  /** Allow network access from target org */
  allowNetworkAccess: boolean;
  /** Maximum token budget for this cross-org interaction */
  maxTokenBudget: number;
  /** Timeout for cross-org task execution */
  timeoutMs: number;
  /** Restrict to specific tools only */
  allowedTools: string[];
}

export interface FederationPolicy {
  orgId: string;
  /** Allow incoming federation requests */
  acceptIncoming: boolean;
  /** Auto-approve requests from these orgs */
  autoApproveOrgs: string[];
  /** Default trust level for new links */
  defaultTrustLevel: TrustLevel;
  /** Default sandbox policy for cross-org interactions */
  defaultSandbox: SandboxPolicy;
  /** Agent IDs that can be discovered by federated orgs */
  discoverableAgentIds: string[];
}

export interface FederationEvent {
  type: 'link_created' | 'link_updated' | 'link_revoked'
    | 'agent_discovered' | 'message_sent' | 'message_received'
    | 'task_delegated' | 'task_completed' | 'policy_violation';
  sourceOrgId: string;
  targetOrgId?: string;
  agentId?: string;
  data?: Record<string, unknown>;
  timestamp: Date;
}

export const DEFAULT_SANDBOX: SandboxPolicy = {
  allowFileAccess: false,
  allowShellAccess: false,
  allowNetworkAccess: false,
  maxTokenBudget: 10000,
  timeoutMs: 60000,
  allowedTools: [],
};
