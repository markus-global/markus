export type AgentStatus = 'idle' | 'working' | 'offline' | 'error';

/**
 * A5: 这个 agent 能自主到什么程度。**二值**，不是四档——四档（只读/建议/受限执行…）
 * 属产品语义，Owner 明确留待单独拍板，不混进本轮。
 */
export type AgentAutonomy = 'observe' | 'act';

/**
 * A5 的**唯一判据**：「这个 agent 能不能自作主张开工」。
 *
 * 为什么做成具名纯函数而不是各处内联 `=== 'act'`：
 *   - 判据只有一个执行点，`declarations-witness` 的见证者才能是个真实符号；
 *   - 缺省/未知值统一落到 `act`（加这个字段之前的行为），历史行不需要迁移；
 *   - 新增第二个消费点会被 `autonomy-single-consumer.test.ts` 咬住。
 *
 * 只有 `'observe'` 会拦下；其余任何值（含 undefined、历史的脏值）都视为 `act` ——
 * 这是**故意 fail-open 到旧行为**：新字段不该让存量 agent 突然停摆。
 */
export function maySelfInitiate(autonomy: AgentAutonomy | string | undefined): boolean {
  return autonomy !== 'observe';
}

export interface AgentConfig {
  id: string;
  name: string;
  roleId: string;
  orgId: string;
  teamId?: string;
  agentRole: 'manager' | 'worker';
  /**
   * A5: 自主档位。**唯一消费点** = `agent.ts` 的心跳 tick 监听器
   * （`heartbeat:trigger`）：判定为 `observe` 时不自发巡逻，只记存活跳过。
   *
   * 缺省 / 未设置 = `act`。DB 列带 `DEFAULT 'act'`，历史行读出来就是 `act`，
   * 等价于加这个字段之前的行为 —— 所以「旧数据兼容读」靠的是默认值，不是迁移。
   */
  autonomy?: AgentAutonomy;
  skills: string[];
  profile?: AgentProfile;
  /** 并发处理配置（智能体设置 → 并发处理）。 */
  concurrent?: AgentConcurrentConfig;
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
