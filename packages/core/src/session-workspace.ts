import { AsyncLocalStorage } from 'node:async_hooks';
import type { DeliberationResult, AgentActivity, AgentActivityType } from '@markus/shared';

/**
 * AgentScenario：一次 handleMessage / stream turn 的场景标签。
 * 单独放这里是为了让 session-workspace.ts 不反向依赖 agent.ts
 * （attention.ts 需要同时 import 两者，避免循环依赖）。
 */
export type AgentScenario =
  | 'chat'
  | 'task_execution'
  | 'heartbeat'
  | 'a2a'
  | 'group_chat'
  | 'comment_response'
  | 'memory_consolidation'
  | 'distillation'
  | 'review'
  | 'requirement_action'
  | 'workflow_action'
  | 'deliberation'
  /** Answering another agent's blocking question (`agent_ask_agent`). */
  | 'peer_query';

/** Runtime mirror of {@link AgentScenario} — the single authoritative list.
 *  Used to validate scenario strings that cross a serialization boundary
 *  (mailbox `extra.scenario`, persisted callbacks) instead of casting blindly. */
export const AGENT_SCENARIOS: readonly AgentScenario[] = [
  'chat',
  'task_execution',
  'heartbeat',
  'a2a',
  'group_chat',
  'comment_response',
  'memory_consolidation',
  'distillation',
  'review',
  'requirement_action',
  'workflow_action',
  'deliberation',
  'peer_query',
];

/**
 * Which activity type a turn produces — the **single** mapping.
 *
 * Why it lives here and is keyed by scenario, not by mailbox type: the activity
 * row describes *what the agent was doing*, and "what it was doing" is the turn's
 * scenario. Mailbox type is a proxy for it and a lossy one — `review_request`
 * arrives as scenario `review` (internal work), while the same type listed under
 * the mailbox registry used to claim `chat`. Two tables saying different things
 * about one fact is how a report ends up disagreeing with itself.
 *
 * `Record<AgentScenario, …>` is deliberate: adding a scenario to the union fails
 * the build until someone decides what activity it produces. Silence is not an
 * option, and there is no `default` bucket to fall into by accident.
 */
export const SCENARIO_ACTIVITY_TYPE: Record<AgentScenario, AgentActivityType> = {
  chat: 'chat',
  // Task executions create their own `task` activity before entering
  // handleMessage, so this entry only matters for the rare path where they
  // arrive without one. It preserves the pre-refactor behaviour exactly.
  task_execution: 'chat',
  heartbeat: 'internal',
  a2a: 'a2a',
  group_chat: 'chat',
  comment_response: 'chat',
  memory_consolidation: 'internal',
  distillation: 'internal',
  review: 'internal',
  requirement_action: 'internal',
  workflow_action: 'internal',
  deliberation: 'chat',
  peer_query: 'chat',
};

/** Narrow an untrusted value to an `AgentScenario`, or `undefined`.
 *  Unknown/legacy values must never silently become a scenario. */
export function asAgentScenario(v: unknown): AgentScenario | undefined {
  return typeof v === 'string' && (AGENT_SCENARIOS as readonly string[]).includes(v)
    ? (v as AgentScenario)
    : undefined;
}

/**
 * SessionWorkspace：单个分身（worker）处理一个会话/任务时独占的可变状态。
 *
 * 并发设计的核心抽象：把原先 Agent 实例级的单值字段（currentSessionId、
 * activeStreamToken、pendingInjections……）下放到 workspace，通过
 * AsyncLocalStorage 绑定到处理链路的异步上下文。
 * - worker=1（未开并发）：所有处理共享 rootWorkspace，行为与旧版完全一致。
 * - worker=N（并发模式）：每个 worker 用独立的 workspace 挂载处理，
 *   await 后的异步代码仍能读到属于自己的 workspace，互不污染。
 */
export interface SessionWorkspace {
  /** 分身编号（并发模式有效；串行模式恒为 1）。 */
  workerId: number;
  currentTaskId?: string;
  currentSessionId?: string;
  currentInteractingUserId?: string;
  /** Scenario of the in-flight handleMessage / stream turn (for chat-only tools). */
  activeScenario?: AgentScenario;
  /**
   * Correlation id of the exchange this turn belongs to (A2A chain).
   *
   * Set from the inbound item's `extra.chainId` when processing starts, cleared
   * when it ends. Anything this turn sends inherits it — the standard trace-id
   * rule (an outbound span's parent is the current span). Per-workspace, so two
   * concurrent workers never share a chain.
   */
  chainId?: string;
  /** Hops already taken in that chain (0/undefined = this turn is the initiator). */
  chainDepth?: number;
  /** Scheme A: per-turn volatile state (time, mailbox, status, memories…) */
  volatileState?: string;
  pendingDeliberationResult?: DeliberationResult;
  /** Buffered user messages injected while tool calls are in-flight. */
  pendingInjections: Map<string, string[]>;
  activeStreamToken?: { cancelled: boolean; userStopped?: boolean };
  /** One chat turn / session model pick from the Chat UI (provider must be enabled). */
  turnModelOverride?: { provider: string; model: string };
  /** The mailbox item ID currently being processed – threaded into activity records. */
  processingMailboxItemId?: string;
  /** Last activity type injected into main session — used to collapse consecutive duplicates like heartbeats. */
  lastInjectedActivityType?: string;
  /**
   * 当前活动（对该 worker 而言）。并发模式下每个 worker 独立持有自己的
   * currentActivity——两个 worker 并行处理 A/B 时互不覆盖，聚合视图由
   * Agent.getLiveActivities() 提供。串行模式（workspace=rootWorkspace）行为与
   * 旧版 this.state.currentActivity 完全一致。
   */
  currentActivity?: AgentActivity;
  /** Session-keyed sticky tool schema state — per worker (see Agent.stickyTools). */
  toolSticky?: StickyToolState;
  /** Session-keyed activated-skill instruction bodies — per worker. */
  activatedSkills?: ActivatedSkillState;
}

/**
 * Session-keyed sticky-tool state (RC5/O1).
 *
 * Lives inside the WORKER's workspace, not on the Agent instance. With N
 * concurrent workers handling N sessions, an instance-level object meant each
 * worker wiped the others' state on every session switch (keyed by session, but
 * stored once per Agent), so `discover_tools` activations vanished and the
 * emitted `tools` schema drifted call-to-call — a cache-prefix break, and the
 * documented "discover_tools → think → discover_tools" spiral.
 * The session key is retained so that in serial mode (one root workspace)
 * switching sessions still drops the previous session's state instead of
 * leaking it.
 */
export interface StickyToolState {
  sessionId: string | null;
  recent: string[];
  activated: Set<string>;
}

/**
 * Session-keyed activated-skill instruction bodies.
 *
 * Same reasoning as {@link StickyToolState}: an instance-level Map leaked a
 * skill's full instruction body activated in session A into the system prompt
 * of session B — in SERIAL mode too (the map was never keyed nor reset).
 */
export interface ActivatedSkillState {
  sessionId: string | null;
  instructions: Map<string, string>;
}

/** 创建一个全新的会话工作区（pendingInjections 为空 Map）。 */
export function createSessionWorkspace(workerId = 1): SessionWorkspace {
  return { workerId, pendingInjections: new Map() };
}

/** 进程级 AsyncLocalStorage：承载「当前分身工作区」。 */
export const sessionWorkspaceStore = new AsyncLocalStorage<SessionWorkspace>();