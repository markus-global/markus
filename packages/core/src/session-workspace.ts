import { AsyncLocalStorage } from 'node:async_hooks';
import type { DeliberationResult, AgentActivity } from '@markus/shared';

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
  | 'deliberation';

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