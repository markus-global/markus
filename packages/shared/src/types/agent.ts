export type AgentStatus = 'idle' | 'working' | 'offline' | 'error';

/**
 * C10-C — the autonomy axis (REBUILD of the #462 axis that #464 physically
 * deleted; plan §0.1 fact 2). Binary by Owner ruling: 'observe' = the agent may
 * read and propose but never self-initiate action; 'act' = full self-initiation.
 * The agents table defaults to 'act', so every historical row keeps its
 * pre-column behavior — compatible read, no data migration.
 */
export type AgentAutonomy = 'observe' | 'act';

/**
 * C10-C — cross-org trust policy. 'observe' (default): unverified cross-org
 * input may be delivered and read, but cannot drive self-initiated action.
 * Elevation to 'auto' requires ONE human approval + an audit row; the only
 * writer is OrganizationService.setCrossOrgPolicy (the storage repo method is
 * its instrument, not a public path).
 */
export type CrossOrgPolicy = 'observe' | 'auto';

/**
 * C10-C — the ONE predicate deciding whether an agent may self-initiate.
 *
 * Exactly one consumer: the patrol admission at the top of `handleHeartbeat`
 * (core/agent.ts) — every self-initiation path (clock tick, api trigger,
 * heartbeat mailbox item) converges there. A second call site turns
 * packages/shared/test/autonomy-single-consumer.test.ts red on purpose.
 *
 * `ceiling` is the trust cap (verified=false cross-org input under
 * cross_org_policy='observe'). It is an INPUT to this same predicate — never a
 * second permissibility function — and it can only TIGHTEN: a ceiling of 'act'
 * does not lift an 'observe' agent.
 *
 * Fail-open to old behavior by design: only 'observe' blocks; undefined and
 * historical dirty values pass, so a new field never stalls existing agents.
 */
export function maySelfInitiate(
  autonomy: AgentAutonomy | string | undefined,
  ceiling?: AgentAutonomy,
): boolean {
  const effective = ceiling === 'observe' ? 'observe' : autonomy;
  return effective !== 'observe';
}

/**
 * C10-C — Agent-level trust-boundary port. The Agent asks for the ceiling
 * INPUT; the org/policy lookup lives on the other side (org-manager assembly),
 * so core never depends on storage. Absent port ⇒ no ceiling: single-org and
 * embedded deployments have no cross-org knowledge (documented fail-open —
 * the autonomy axis itself still bites).
 */
export interface TrustBoundaryPort {
  selfInitiationCeiling(senderAgentIds: string[]): AgentAutonomy | undefined;
}

/**
 * C10-C — org-aware variant implemented by org-manager (api-server assembly).
 * AgentManager binds the receiver org per agent, so the Agent-level contract
 * stays (senderAgentIds) => ceiling.
 */
export interface OrgTrustBoundaryPort {
  selfInitiationCeiling(receiverOrgId: string, senderAgentIds: string[]): AgentAutonomy | undefined;
}

export interface AgentConfig {
  id: string;
  name: string;
  roleId: string;
  orgId: string;
  teamId?: string;
  agentRole: 'manager' | 'worker';
  skills: string[];
  profile?: AgentProfile;
  /** 并发处理配置（智能体设置 → 并发处理）。 */
  concurrent?: AgentConcurrentConfig;
  llmConfig: LLMAssignment;
  channels: ChannelBinding[];
  heartbeatIntervalMs: number;
  /**
   * C10-C: autonomy axis. The ONLY consumer is the patrol admission in
   * core/agent.ts via maySelfInitiate() — do not read this field to make
   * permissibility decisions anywhere else (the single-consumer guard bites).
   * Absent ⇒ 'act' (historical behavior).
   */
  autonomy?: AgentAutonomy;
  createdAt: string;
  updatedAt: string;
}

export interface LLMAssignment {
  /** 'default' follows system default provider; 'custom' uses a fixed provider */
  modelMode: 'default' | 'custom';
  primary: string;
  fallback?: string;
  /**
   * Per-agent default model ID (used together with `primary` as the provider).
   * When set (with modelMode === 'custom'), this agent resolves to
   * { provider: primary, model: defaultModel } unless overridden by a
   * session/turn override. Priority: session/turn override > per-agent
   * defaultModel > global routing. Omit / reset to have the agent follow the
   * global default.
   */
  defaultModel?: string;
  maxTokensPerRequest?: number;
  maxTokensPerDay?: number;
}

export interface ChannelBinding {
  platform: 'feishu' | 'whatsapp' | 'slack' | 'telegram' | 'webui';
  channelId: string;
  role: 'member' | 'observer';
}

export type AgentActivityType = 'task' | 'heartbeat' | 'chat' | 'a2a' | 'internal' | 'respond_in_session' | 'inline_deliberation';

export interface AgentActivity {
  /** Unique ID for this activity session */
  id: string;
  type: AgentActivityType;
  label: string;
  /** For task type, the task ID */
  taskId?: string;
  /** Links this activity back to the mailbox item that triggered it */
  mailboxItemId?: string;
  /**
   * C9-B: which WorkUnit (execution epoch) this activity belongs to. Nullable — a
   * row without an identity is legal (old chain / no WorkUnit), and "still running"
   * is never derived from this activity (see docs/architecture/derived-views.md).
   */
  workUnitRef?: string | null;
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
  /** 最近一次实质进展（工具调用 / LLM 请求等）时间 —— 区分「长任务进行中」与「疑似卡死」 */
  lastProgressAt?: string;
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
  /**
   * 显示用头衔覆盖 —— 用户在 Team Chat 头部点改的那一行。
   *
   * 留空时用角色模板自带的 `role.name`。**不写回角色模板**：模板是多个 Agent
   * 共享的，改模板会串到其它 Agent，所以只在本 Agent 的 `agents.profile` JSON 里存。
   */
  displayTitle?: string;
}

/** 并发处理配置（智能体设置 → 并发处理）。默认开启 = 智能体并发处理消息。 */
export interface AgentConcurrentConfig {
  /** 总开关。缺省 = 开启（maxWorkers=3）；显式 enabled:false 才关闭（串行）。 */
  enabled?: boolean;
  /** 并发 worker 数上限（1-10）。1 = 串行。默认开启时为 3。 */
  maxWorkers?: number;
  /** 冲突处理策略：auto=实体亲和自动错开（默认）；report=冲突时停下报告。 */
  conflictPolicy?: 'auto' | 'report';
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
