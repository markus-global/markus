import {
  createLogger,
  agentId as genAgentId,
  type AgentConfig,
  type AgentState,
  type AgentActivity,
  type AgentActivityLogEntry,
  type RoleTemplate,
  type LLMMessage,
  type LLMContentPart,
  type LLMTool,
  type LLMToolCall,
  type LLMStreamEvent,
  type IdentityContext,
  type PathAccessPolicy,
  type MailboxItem,
  type MailboxItemType,
  type MailboxPayload,
  type MailboxPriority,
  type AttentionDecision,
  type DecisionType,
  type AgentMindState,
  type TriageResult,
  MailboxPriorityLevel,
  MAILBOX_TYPE_REGISTRY,
  HEARTBEAT_DAILY_LOG_CHARS,
  COMPLETION_MARKER_INSTRUCTION,
  COMPLETION_MARKER,
  TRIAGE_CONTEXT_MESSAGES_MAX,
  TRIAGE_CONTEXT_MSG_CHARS,
} from '@markus/shared';
import { startSpan } from './tracing.js';
import { EventBus } from './events.js';
import { GuardrailPipeline } from './guardrails.js';
import { ToolHookRegistry, generateIdempotencyKey, type ToolHook } from './tool-hooks.js';
import { HeartbeatScheduler } from './heartbeat.js';
import type { LLMRouter } from './llm/router.js';
import { MemoryStore } from './memory/store.js';
import type { IMemoryStore, MemoryEntry } from './memory/types.js';
import type { SemanticMemorySearch } from './memory/semantic-search.js';
import { EnhancedMemorySystem } from './enhanced-memory-system.js';
import { AgentMetricsCollector, type AgentMetricsSnapshot } from './agent-metrics.js';
import { ContextEngine, type OrgContext, type LLMSummarizer } from './context-engine.js';
import { detectEnvironment, type EnvironmentProfile } from './environment-profile.js';
import { ToolSelector } from './tool-selector.js';
import type { SkillRegistry } from './skills/types.js';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createBuiltinTools } from './tools/builtin.js';
import { createSubagentTool, createParallelSubagentTool, type SubagentContext, type SubagentProgressCallback } from './tools/subagent.js';
import { onBackgroundCompletion, drainCompletedNotifications } from './tools/process-manager.js';
import { AgentMailbox, type EnqueueOptions } from './mailbox.js';
import { AttentionController, type AttentionDelegate } from './attention.js';

/**
 * Per-task async context — propagates the executing taskId and task-local
 * tool overrides through the async call chain of _executeTaskInternal,
 * so concurrent tasks each resolve their own taskId and use their own
 * tool bindings (e.g. task-workspace-scoped tools) without cross-contamination.
 */
interface TaskAsyncContext {
  taskId: string;
  requirementId?: string;
  /** When set, executeTool/buildToolDefinitions use this instead of this.tools */
  tools?: Map<string, AgentToolHandler>;
  /** When set, subagent tools emit progress events through this callback */
  subagentProgress?: SubagentProgressCallback;
}
const taskAsyncContext = new AsyncLocalStorage<TaskAsyncContext>();

interface ChatSubagentContext {
  subagentProgress: SubagentProgressCallback;
}
const chatSubagentContext = new AsyncLocalStorage<ChatSubagentContext>();

import { TaskExecutor, AgentStateManager } from './concurrent/index.js';
import { TaskPriority, TaskStatus } from './concurrent/task-queue.js';
import { ToolLoopDetector } from './tool-loop-detector.js';

const log = createLogger('agent');

/**
 * Strip raw XML tool-call markup from LLM replies.  The completion marker
 * is NOT removed here — it must survive until `detectAbnormalCompletion`
 * inspects the reply; stripping happens later in `stripCompletionMarker`.
 */
const RAW_TOOL_XML_RE =
  /(?:minimax:tool_call\s*)?<invoke\s+name="[^"]*">\s*(?:<parameter\s+name="[^"]*">[^<]*<\/parameter>\s*)*<\/invoke>\s*(?:<\/minimax:tool_call>)?/gi;

function sanitizeLLMReply(reply: string): string {
  const cleaned = reply.replace(RAW_TOOL_XML_RE, '').trim();
  return cleaned || reply;
}

/**
 * Remove the completion marker from a reply so it is never stored in
 * memory or shown to users.  Called after abnormal-completion detection.
 */
function stripCompletionMarker(reply: string): string {
  return reply.replaceAll(COMPLETION_MARKER, '').trim();
}

/**
 * Create a streaming delta emitter that buffers the tail to strip
 * the completion marker from real-time output. The marker may arrive
 * split across multiple chunks, so we hold back enough characters.
 */
function createMarkerStrippingDelta(rawEmit: (text: string) => void) {
  const markerLen = COMPLETION_MARKER.length;
  let tail = '';

  const emit = (chunk: string) => {
    tail += chunk;
    if (tail.length <= markerLen) return;
    const safe = tail.slice(0, tail.length - markerLen);
    tail = tail.slice(safe.length);
    if (safe) rawEmit(safe);
  };

  const flush = () => {
    const cleaned = tail.replaceAll(COMPLETION_MARKER, '');
    tail = '';
    if (cleaned) rawEmit(cleaned);
  };

  return { emit, flush };
}

/** Returns true when a tool returned a structured error (status: 'error' | 'denied'). */
function isErrorResult(result: string): boolean {
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    return parsed.status === 'error' || parsed.status === 'denied';
  } catch {
    return false;
  }
}

export type ToolOutputCallback = (chunk: string) => void;

export interface AgentToolHandler {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(args: Record<string, unknown>, onOutput?: ToolOutputCallback): Promise<string>;
}

export type ApprovalCallback = (request: {
  agentId: string;
  agentName: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  reason: string;
  taskId?: string;
}) => Promise<{ approved: boolean; comment?: string }>;

export interface TaskProjectContext {
  project: { id: string; name: string; description: string; status: string };
  repositories: Array<{ localPath: string; defaultBranch: string; role: string }>;
}

export interface AgentOptions {
  config: AgentConfig;
  role: RoleTemplate;
  llmRouter: LLMRouter;
  dataDir: string;
  tools?: AgentToolHandler[];
  orgContext?: OrgContext;
  contextMdPath?: string;
  /** Optional custom memory implementation. Defaults to MemoryStore. */
  memory?: IMemoryStore;
  /** Multi-tier path access policy for this agent */
  pathPolicy?: PathAccessPolicy;
  /** Restored state from DB (used during server restart recovery) */
  restoredState?: { tokensUsedToday?: number };
  /** Safety cap on tool iterations per agent turn (from system config) */
  maxToolIterations?: number;
  /** Skill registry for runtime skill discovery and activation */
  skillRegistry?: SkillRegistry;
}

export class Agent {
  readonly id: string;
  readonly config: AgentConfig;
  role: RoleTemplate;

  private state: AgentState;
  private eventBus: EventBus;
  private heartbeat: HeartbeatScheduler;
  private llmRouter: LLMRouter;
  private memory: IMemoryStore;
  private contextEngine: ContextEngine;
  private tools: Map<string, AgentToolHandler>;
  private currentTaskId?: string;
  private pathPolicy?: PathAccessPolicy;
  private skillRegistry?: SkillRegistry;
  private toolSelector: ToolSelector;
  private guardrails: GuardrailPipeline;
  private toolHooks: ToolHookRegistry;
  private recentToolNames: string[] = [];
  private activatedExtraTools = new Set<string>(); // tools activated via discover_tools
  private activatedSkillInstructions = new Map<string, string>(); // skill instructions injected into context
  private availableSkillCatalog: Array<{ name: string; description: string; category: string }> = [];
  private skillMcpActivator?: (
    skillName: string,
    mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>,
  ) => Promise<AgentToolHandler[]>;
  private skillSearcher?: (query: string) => Promise<Array<{ name: string; description: string; source: string; slug?: string; author?: string; githubRepo?: string; githubSkillPath?: string }>>;
  private skillInstaller?: (request: Record<string, unknown>) => Promise<{ installed: boolean; name: string; method: string }>;
  private userApprovalRequester?: (opts: {
    agentId: string; agentName: string; title: string; description: string;
    options?: Array<{ id: string; label: string; description?: string }>;
    allowFreeform?: boolean; priority?: string; relatedTaskId?: string;
  }) => Promise<{ approved: boolean; comment?: string; selectedOption?: string }>;
  private userNotifier?: (opts: { type: string; title: string; body: string; priority?: string; actionType?: string; actionTarget?: string; metadata?: Record<string, unknown> }) => void;
  private semanticSearch?: SemanticMemorySearch;
  private currentSessionId?: string;
  private currentInteractingUserId?: string;
  private dbSessionMap = new Map<string, string>();
  private orgContext?: OrgContext;
  private contextMdPath?: string;
  private teamDataDir?: string;
  private identityContext?: IdentityContext;
  private environmentProfile?: EnvironmentProfile;
  private auditCallback?: (event: {
    type: string;
    action: string;
    tokensUsed?: number;
    durationMs?: number;
    success: boolean;
    detail?: string;
  }) => void;
  private escalationCallback?: (agentId: string, reason: string) => void;
  private approvalCallback?: ApprovalCallback;
  private tasksFetcher?: () => Array<{
    id: string;
    title: string;
    description: string;
    status: string;
    priority: string;
    assignedAgentId?: string;
    assignedAgentName?: string;
  }>;
  private consecutiveFailures = 0;
  private metricsCollector: AgentMetricsCollector;
  /** Tracks concurrently executing task IDs */
  private activeTasks = new Set<string>();
  /** Generation counter per task — prevents stale finally blocks from clearing a newer execution */
  private activeTaskGen = new Map<string, number>();
  /**
   * Buffered user messages injected while tool calls are in-flight.
   * Draining happens after all tool results for the current LLM turn are
   * appended, right before the next LLM call — this avoids interleaving
   * user messages between tool results (which is invalid message ordering).
   */
  private pendingInjections = new Map<string, string[]>();
  private activeStreamToken?: { cancelled: boolean };
  /** The mailbox item ID currently being processed – threaded into activity records. */
  private processingMailboxItemId?: string;
  /** Last activity type injected into main session — used to collapse consecutive duplicates like heartbeats. */
  private lastInjectedActivityType?: string;
  /** Persistent situational awareness from the latest triage deliberation. */
  private currentCognition?: string;
  /** Ring buffer of recent activity summaries for triage context. */
  private recentActivityRing: string[] = [];
  private static readonly ACTIVITY_RING_SIZE = 8;
  /** Task executor for concurrent task management */
  private taskExecutor?: TaskExecutor;
  /** State manager for synchronizing task and agent states */
  private stateManager?: AgentStateManager;
  private stateChangeCallback?: (
    agentId: string,
    state: { status: string; tokensUsedToday: number; activeTaskIds: string[]; lastError?: string; lastErrorAt?: string; currentActivity?: AgentActivity }
  ) => void;
  private memoryConsolidationTimer?: ReturnType<typeof setInterval>;
  private loopDetector = new ToolLoopDetector();
  private dataDir: string;
  private pauseReason?: string;
  private toolResultCounter = 0;
  private lastEstimatedInputTokens = 0;
  /** In-memory activity log buffer (keyed by activity ID, write-through cache) */
  private activityLogs = new Map<string, AgentActivityLogEntry[]>();
  private activitySeqCounters = new Map<string, number>();
  private onActivityStartCb?: (activity: AgentActivity & { agentId: string }) => void;
  private onActivityLogCb?: (data: { activityId: string; agentId: string; seq: number; type: string; content: string; metadata?: Record<string, unknown> }) => void;
  private onActivityEndCb?: (activityId: string, summary: { endedAt: string; totalTokens: number; totalTools: number; success: boolean; summary?: string; keywords?: string }) => void;
  private dynamicContextProviders = new Map<string, () => string>();
  private static readonly MAX_ACTIVITY_LOG_ENTRIES = 200;
  private static readonly MAX_ACTIVITY_LOGS_KEPT = 10;
  private static readonly MAX_CONCURRENT_TASKS = 1;
  private static readonly MAX_CONSECUTIVE_FAILURES = 3;
  private static readonly TOOL_RETRY_MAX = 2;
  private static readonly TOOL_RETRY_BASE_MS = 500;
  private static readonly NETWORK_RETRY_MAX = 3;
  private static readonly NETWORK_RETRY_BASE_MS = 2000;
  private static readonly MEMORY_CONSOLIDATION_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
  private static readonly DEFAULT_MAX_TOOL_ITERATIONS = 200;
  private static readonly HEARTBEAT_MAX_TOOL_ITERATIONS = 30;
  /** Maps background_exec session IDs to the originating session that spawned them */
  private bgSessionOrigin = new Map<string, string>();
  private _maxToolIterations: number;
  private _bgCompletionUnsub?: () => void;

  /** Mailbox for single-threaded attention model */
  private mailbox: AgentMailbox;
  /** Attention controller for event-driven focus management */
  private attentionController: AttentionController;

  constructor(options: AgentOptions) {
    this.id = options.config.id || genAgentId();
    this.config = { ...options.config, id: this.id };
    this.role = options.role;
    this.llmRouter = options.llmRouter;
    this.orgContext = options.orgContext;
    this.contextMdPath = options.contextMdPath;

    this.state = {
      agentId: this.id,
      status: 'idle',
      activeTaskCount: 0,
      activeTaskIds: [],
      tokensUsedToday: options.restoredState?.tokensUsedToday ?? 0,
    };

    this.dataDir = options.dataDir;
    this.pathPolicy = options.pathPolicy;
    this.skillRegistry = options.skillRegistry;
    this._maxToolIterations = options.maxToolIterations ?? Agent.DEFAULT_MAX_TOOL_ITERATIONS;
    this.eventBus = new EventBus();
    this.mailbox = new AgentMailbox(this.id, this.eventBus);
    this.attentionController = new AttentionController(this.id, this.mailbox, this.eventBus);
    this.attentionController.setDelegate(this.createAttentionDelegate());
    this.memory = options.memory ?? new MemoryStore(options.dataDir);
    this.contextEngine = new ContextEngine();
    this.contextEngine.setLLMSummarizer(this.createLLMSummarizer());
    this.guardrails = new GuardrailPipeline();
    this.toolHooks = new ToolHookRegistry();
    this.metricsCollector = new AgentMetricsCollector(this.id, options.dataDir);
    this.heartbeat = new HeartbeatScheduler(this.id, this.eventBus, {
      intervalMs: this.config.heartbeatIntervalMs,
      enabled: true,
    });

    this.tools = new Map();
    this.toolSelector = new ToolSelector();
    if (options.tools) {
      for (const tool of options.tools) {
        this.tools.set(tool.name, tool);
      }
    }

    // Register the lightweight subagent spawning tool
    const subagentCtx: SubagentContext = {
      llmRouter: this.llmRouter,
      contextEngine: this.contextEngine,
      getTools: () => taskAsyncContext.getStore()?.tools ?? this.tools,
      getProvider: () => this.getEffectiveProvider(),
      agentId: this.id,
      offloadLargeResult: (toolName, result) => this.offloadLargeResult(toolName, result),
      maxToolIterations: this._maxToolIterations,
      dataDir: this.dataDir,
      getProgressCallback: () =>
        taskAsyncContext.getStore()?.subagentProgress
        ?? chatSubagentContext.getStore()?.subagentProgress,
    };
    this.tools.set('spawn_subagent', createSubagentTool(subagentCtx));
    this.tools.set('spawn_subagents', createParallelSubagentTool(subagentCtx));

    // Route background_exec completion to the originating session (not always main chat).
    this._bgCompletionUnsub = onBackgroundCompletion((notification) => {
      const targetSession = this.bgSessionOrigin.get(notification.sessionId)
        ?? this.currentSessionId;
      if (!targetSession) return;
      this.bgSessionOrigin.delete(notification.sessionId);

      const status = notification.exitCode === 0 ? 'succeeded' : `failed (exit ${notification.exitCode})`;
      const parts = [
        `[BACKGROUND PROCESS COMPLETED] Session ${notification.sessionId} ${status}.`,
        `Command: ${notification.command}`,
        `Duration: ${Math.round(notification.durationMs / 1000)}s`,
      ];
      if (notification.exitCode !== 0 && notification.stderrTail) {
        parts.push(`Stderr (last lines):\n${notification.stderrTail}`);
      }
      if (notification.exitCode === 0 && notification.stdoutTail) {
        parts.push(`Output (last lines):\n${notification.stdoutTail}`);
      }
      this.injectUserMessage(targetSession, parts.join('\n'));
    });

    // Initialize task executor
    this.taskExecutor = new TaskExecutor({
      agentId: this.id,
      maxConcurrentTasks: this.config.profile?.maxConcurrentTasks ?? Agent.MAX_CONCURRENT_TASKS,
      defaultPriority: TaskPriority.MEDIUM,
    });

    // Initialize state manager
    this.stateManager = new AgentStateManager(this.id, this.taskExecutor);

    this.eventBus.on('heartbeat:trigger', ctx => {
      const { triggeredAt } = ctx as { agentId: string; triggeredAt: string };
      this.mailbox.enqueue('heartbeat', {
        summary: 'Scheduled heartbeat check-in',
        content: `Heartbeat triggered at ${triggeredAt}`,
      });
    });

    // Auto-reload role / heartbeat when agent modifies its own files
    const roleFilePath = join(this.dataDir, 'role', 'ROLE.md');
    const heartbeatFilePath = join(this.dataDir, 'role', 'HEARTBEAT.md');
    this.toolHooks.register({
      name: 'role-auto-reload',
      after: async (ctx) => {
        if ((ctx.toolName === 'file_edit' || ctx.toolName === 'file_write') && ctx.success) {
          const targetPath = (ctx.arguments['path'] ?? ctx.arguments['filePath'] ?? '') as string;
          if (targetPath === roleFilePath || targetPath.endsWith('/role/ROLE.md')) {
            log.info('Agent modified its own ROLE.md — reloading role definition');
            this.reloadRole();
          }
          if (targetPath === heartbeatFilePath || targetPath.endsWith('/role/HEARTBEAT.md')) {
            log.info('Agent modified its own HEARTBEAT.md — reloading heartbeat checklist');
            this.reloadHeartbeat();
          }
        }
      },
    });

    log.info(`Agent created: ${this.id}`, { name: this.config.name, role: this.role.name });
  }

  /**
   * Resolve the LLM provider name for this agent.
   * In 'custom' mode returns the agent-specific provider; in 'default' mode
   * returns undefined so the router uses the current system default.
   */
  private getEffectiveProvider(): string | undefined {
    if (this.config.llmConfig.modelMode === 'custom') {
      return this.config.llmConfig.primary;
    }
    return undefined;
  }

  /**
   * Set agent status and emit status change event
   */
  private setStatus(status: AgentState['status'], errorMessage?: string): void {
    const oldStatus = this.state.status;
    if (oldStatus === status && status !== 'error') return;

    this.state.status = status;

    if (status === 'error') {
      this.state.lastError = errorMessage || this.state.lastError || 'Unknown error';
      this.state.lastErrorAt = new Date().toISOString();
    }
    // Keep lastError/lastErrorAt when recovering from error — they serve as
    // informational records of the most recent error.  The frontend uses
    // `status` as the authoritative current-state indicator and shows
    // lastError as a dismissible warning when the agent has recovered.

    if (this.stateManager) {
      this.stateManager.updateState({ status });
    }

    this.notifyStateChange();
  }

  async start(options?: { initialHeartbeatDelayMs?: number; startAsPaused?: boolean }): Promise<void> {
    const shouldPause = options?.startAsPaused || this.state.status === 'paused';

    this.setStatus('idle');

    // Detect runtime environment (cached for 5 minutes)
    try {
      this.environmentProfile = await detectEnvironment();
    } catch (e) {
      log.warn('Environment detection failed', { error: String(e) });
    }

    // Resume latest conversation session if available
    const latestSession = this.memory.getLatestSession(this.id);
    if (latestSession && latestSession.messages.length > 0) {
      this.currentSessionId = latestSession.id;
      log.info(
        `Resumed session ${latestSession.id} with ${latestSession.messages.length} messages`
      );
    }

    // Ensure currentSessionId is always set so activity injection works
    // even if the agent has never chatted with anyone.
    if (!this.currentSessionId) {
      const fallback = this.memory.createSession(this.id);
      this.currentSessionId = fallback.id;
      log.info(`Created fallback session for activity injection: ${fallback.id}`);
    }

    if (shouldPause) {
      this.setStatus('paused');
      this.pauseReason = this.pauseReason || 'Restored as paused from previous session';
      this.eventBus.emit('agent:paused', { agentId: this.id, reason: this.pauseReason });
      log.info(`Agent started as paused: ${this.config.name}`);
      return;
    }

    this.heartbeat.start(options?.initialHeartbeatDelayMs);
    this.attentionController.start();

    // Periodic memory consolidation: compact sessions and generate daily insights
    this.memoryConsolidationTimer = setInterval(() => {
      this.consolidateMemory().catch(e =>
        log.warn('Memory consolidation failed', { error: String(e) })
      );
    }, Agent.MEMORY_CONSOLIDATION_INTERVAL_MS);

    this.eventBus.emit('agent:started', { agentId: this.id });
    log.info(`Agent started: ${this.config.name}`);
  }

  async stop(): Promise<void> {
    this.cancelActiveStream();
    this.attentionController.stop();
    this.heartbeat.stop();
    this._bgCompletionUnsub?.();
    if (this.memoryConsolidationTimer) {
      clearInterval(this.memoryConsolidationTimer);
      this.memoryConsolidationTimer = undefined;
    }
    this.metricsCollector.flush();
    const wasPaused = this.state.status === 'paused';
    this.setStatus(wasPaused ? 'paused' : 'offline');
    this.eventBus.emit('agent:stopped', { agentId: this.id });
    log.info(`Agent stopped: ${this.config.name}${wasPaused ? ' (preserving paused state)' : ''}`);
  }

  // ─── Mailbox & Attention ──────────────────────────────────────────────────

  /**
   * Enqueue an item into this agent's mailbox.
   * This is the primary entry point for all external events reaching the agent.
   * The AttentionController will process items according to the agent's focus state.
   */
  enqueueToMailbox(
    sourceType: MailboxItemType,
    payload: MailboxPayload,
    options?: EnqueueOptions,
  ): MailboxItem {
    return this.mailbox.enqueue(sourceType, payload, options);
  }

  /**
   * Route a message through the mailbox and return a promise that resolves
   * when the agent finishes processing it.  This is the external replacement
   * for direct `handleMessage` calls — callers await the returned promise
   * exactly as they did before, but the work is now serialised through the
   * agent's attention loop.
   */
  sendMessage(
    userMessage: string,
    senderId?: string,
    senderInfo?: { name: string; role: string },
    options?: {
      sourceType?: MailboxItemType;
      priority?: MailboxPriority;
      sessionId?: string;
      channelContext?: Array<{ role: string; content: string }>;
      images?: string[];
      fileNames?: string[];
      allowedTools?: Set<string>;
      scenario?: 'chat' | 'task_execution' | 'heartbeat' | 'a2a' | 'comment_response' | 'memory_consolidation' | 'review';
      toolEventCollector?: Array<{
        tool: string;
        status: 'done' | 'error';
        arguments?: unknown;
        result?: string;
        durationMs?: number;
      }>;
      taskId?: string;
      requirementId?: string;
    },
  ): Promise<string> {
    const sourceType = options?.sourceType
      ?? (senderId ? 'human_chat' : 'system_event');

    const payload: MailboxPayload = {
      summary: userMessage.slice(0, 100),
      content: userMessage,
      taskId: options?.taskId,
      requirementId: options?.requirementId,
      extra: {
        sessionId: options?.sessionId,
        channelContext: options?.channelContext,
        images: options?.images,
        fileNames: options?.fileNames,
        allowedTools: options?.allowedTools
          ? [...options.allowedTools]
          : undefined,
        scenario: options?.scenario,
        toolEventCollector: options?.toolEventCollector,
      },
    };

    return new Promise<string>((resolve, reject) => {
      this.mailbox.enqueue(sourceType, payload, {
        priority: options?.priority,
        metadata: {
          senderId,
          senderName: senderInfo?.name,
          senderRole: senderInfo?.role,
          responsePromise: { resolve, reject },
        },
      });
    });
  }

  /**
   * Streaming counterpart of `sendMessage`.  Routes the request through the
   * mailbox, but passes the SSE event callback and cancel token so that
   * `processMailboxItemInternal` can delegate to `handleMessageStream`.
   */
  sendMessageStream(
    userMessage: string,
    onEvent: (event: LLMStreamEvent & { agentEvent?: string }) => void,
    senderId?: string,
    senderInfo?: { name: string; role: string },
    cancelToken?: { cancelled: boolean },
    images?: string[],
    fileNames?: string[],
  ): Promise<string> {
    const payload: MailboxPayload = {
      summary: userMessage.slice(0, 100),
      content: userMessage,
      extra: {
        images,
        fileNames,
        stream: true,
        onEvent,
        cancelToken,
      },
    };

    return new Promise<string>((resolve, reject) => {
      this.mailbox.enqueue('human_chat', payload, {
        priority: 0,
        metadata: {
          senderId,
          senderName: senderInfo?.name,
          senderRole: senderInfo?.role,
          responsePromise: { resolve, reject },
        },
      });
    });
  }

  /**
   * Route a task execution through the mailbox.  Fire-and-forget: the returned
   * promise resolves when the agent finishes (or errors out), but the caller
   * does not need to await it.
   *
   * Internally enqueues a `task_status_update` with `extra.triggerExecution`
   * so the attention controller triggers `executeTask()` instead of a
   * lightweight notification.
   */
  sendTaskExecution(
    taskId: string,
    taskDescription: string,
    onLog: (entry: { seq: number; type: string; content: string; metadata?: unknown; persist: boolean }) => void,
    cancelToken?: { cancelled: boolean },
    taskProjectContext?: TaskProjectContext,
    executionRound?: number,
    taskTitle?: string,
    requirementId?: string,
  ): Promise<string> {
    const payload: MailboxPayload = {
      summary: `Task: ${taskTitle ?? taskDescription.slice(0, 80)}`,
      content: taskDescription,
      taskId,
      requirementId,
      extra: {
        triggerExecution: true,
        onLog,
        cancelToken,
        taskProjectContext,
        executionRound,
      },
    };

    return new Promise<string>((resolve, reject) => {
      this.mailbox.enqueue('task_status_update', payload, {
        priority: 1,
        metadata: {
          taskId,
          responsePromise: { resolve, reject },
        },
      });
    });
  }

  /**
   * Route a session reply (e.g. post-task comment) through the mailbox.
   * The returned promise resolves with the agent's reply text.
   */
  sendSessionReply(
    sessionId: string,
    userMessage: string,
    onLog: (entry: { seq: number; type: string; content: string; metadata?: unknown; persist: boolean }) => void,
    senderId?: string,
    senderInfo?: { name: string; role: string },
  ): Promise<string> {
    const payload: MailboxPayload = {
      summary: userMessage.slice(0, 100),
      content: userMessage,
      extra: {
        sessionId,
        onLog,
      },
    };

    return new Promise<string>((resolve, reject) => {
      this.mailbox.enqueue('session_reply', payload, {
        metadata: {
          senderId,
          senderName: senderInfo?.name,
          senderRole: senderInfo?.role,
          responsePromise: { resolve, reject },
        },
      });
    });
  }

  /** Get the current cognitive state of the agent. */
  getMindState(): AgentMindState {
    return this.attentionController.getMindState();
  }

  /** Get the raw mailbox instance (for persistence wiring). */
  getMailbox(): AgentMailbox {
    return this.mailbox;
  }

  /** Drop queued informational status-update items for a task (used before retry). */
  dropStaleStatusUpdates(taskId: string): number {
    return this.mailbox.dropStatusUpdatesByTaskId(taskId);
  }

  /** Get the attention controller (for persistence wiring). */
  getAttentionController(): AttentionController {
    return this.attentionController;
  }

  /**
   * Check yield point during task execution — called between LLM turns.
   * Returns decision info so the tool loop can act on preemption or merges.
   */
  async checkAttentionYieldPoint(): Promise<{
    decision: DecisionType;
    item?: MailboxItem;
    reasoning?: string;
  }> {
    return this.attentionController.checkYieldPoint();
  }

  /**
   * Build the AttentionDelegate that bridges the AttentionController
   * back to the Agent's existing processing methods.
   */
  private createAttentionDelegate(): AttentionDelegate {
    return {
      processMailboxItem: async (item: MailboxItem) => {
        return this.processMailboxItemInternal(item);
      },
      onDecisionMade: (decision: AttentionDecision) => {
        log.debug('Attention decision', {
          agentId: this.id,
          type: decision.decisionType,
          itemType: this.attentionController.getCurrentFocus()?.sourceType,
          reasoning: decision.reasoning.slice(0, 120),
        });
      },
      onFocusChanged: (item: MailboxItem | undefined) => {
        this.eventBus.emit('agent:focus-changed', {
          agentId: this.id,
          focus: item ? {
            mailboxItemId: item.id,
            type: item.sourceType,
            label: item.payload.summary,
            taskId: item.payload.taskId,
          } : undefined,
          mailboxDepth: this.mailbox.depth,
        });
        if (item) {
          this.setStatus('working');
        } else if (this.activeTasks.size === 0) {
          this.setStatus('idle');
        }
      },
      evaluateInterrupt: async (currentItem: MailboxItem, newItem: MailboxItem) => {
        return this.attentionController.evaluateWithLLMFallback(currentItem, newItem);
      },
      getTriageContext: async () => {
        const messages = this.currentSessionId
          ? this.memory.getRecentMessages(this.currentSessionId, TRIAGE_CONTEXT_MESSAGES_MAX * 2)
              .filter(m => m.role === 'user' || m.role === 'assistant')
              .slice(-TRIAGE_CONTEXT_MESSAGES_MAX)
              .map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content.slice(0, TRIAGE_CONTEXT_MSG_CHARS) : String(m.content).slice(0, TRIAGE_CONTEXT_MSG_CHARS) }))
          : [];
        const activities = this.recentActivitySummaries();

        // Include active task IDs for situational awareness
        const activeTaskIds = Array.from(this.activeTasks);

        return { agentName: this.config.name, recentMainSessionMessages: messages, recentActivitySummaries: activities, activeTaskIds };
      },
      onTriageCompleted: (result) => {
        if (!result) return;
        this.updateCognition(result);
      },
    };
  }

  /**
   * Route a mailbox item to the appropriate Agent processing method.
   * Options like sessionId/images/scenario are forwarded from payload.extra
   * when present, falling back to type-appropriate defaults.
   */
  private async processMailboxItemInternal(item: MailboxItem): Promise<string | void> {
    this.processingMailboxItemId = item.id;
    if (item.sourceType === 'human_chat' && item.metadata?.senderId) {
      this.currentInteractingUserId = item.metadata.senderId;
    }
    const extra = item.payload.extra ?? {};
    const senderInfo = item.metadata?.senderName
      ? { name: item.metadata.senderName, role: item.metadata.senderRole ?? 'user' }
      : undefined;
    const resolveResponse = (reply: string) => {
      if (typeof item.metadata?.responsePromise?.resolve === 'function') {
        item.metadata.responsePromise.resolve(stripCompletionMarker(reply));
      }
    };
    const rejectResponse = (err: unknown) => {
      if (typeof item.metadata?.responsePromise?.reject === 'function') {
        item.metadata.responsePromise.reject(err);
      }
    };

    const ts = Date.now();

    const registry = MAILBOX_TYPE_REGISTRY[item.sourceType];
    const needsMarker = !!registry?.invokesLLM;
    const markerSuffix = needsMarker ? COMPLETION_MARKER_INSTRUCTION : '';

    const buildHandleOpts = (defaults: Record<string, unknown> = {}) => {
      const opts: Record<string, unknown> = { ...defaults };
      if (extra.sessionId !== undefined) opts.sessionId = extra.sessionId;
      if (extra.channelContext !== undefined) opts.channelContext = extra.channelContext;
      if (extra.images !== undefined) opts.images = extra.images;
      if (extra.fileNames !== undefined) opts.fileNames = extra.fileNames;
      if (extra.scenario !== undefined) opts.scenario = extra.scenario;
      if (extra.toolEventCollector !== undefined) opts.toolEventCollector = extra.toolEventCollector;
      if (extra.allowedTools !== undefined) {
        opts.allowedTools = new Set(extra.allowedTools as string[]);
      }
      return opts;
    };

    try {
      switch (item.sourceType) {
        case 'human_chat':
        case 'a2a_message': {
          if (extra.stream && typeof extra.onEvent === 'function') {
            const reply = await this.handleMessageStream(
              item.payload.content + markerSuffix,
              extra.onEvent as (event: LLMStreamEvent & { agentEvent?: string }) => void,
              item.metadata?.senderId,
              senderInfo,
              extra.cancelToken as { cancelled: boolean } | undefined,
              extra.images as string[] | undefined,
              extra.fileNames as string[] | undefined,
            );
            resolveResponse(reply);
            return reply;
          }
          const defaults = item.sourceType === 'a2a_message'
            ? { sessionId: `a2a_${this.id}_${ts}`, scenario: 'a2a' as const }
            : {};
          const reply = await this.handleMessage(
            item.payload.content + markerSuffix,
            item.metadata?.senderId,
            senderInfo,
            buildHandleOpts(defaults),
          );
          resolveResponse(reply);
          return reply;
        }

        case 'task_status_update': {
          if (extra.triggerExecution && item.payload.taskId) {
            const taskId = item.payload.taskId;
            const description = item.payload.content;
            const onLog = (extra.onLog as ((entry: { seq: number; type: string; content: string; metadata?: unknown; persist: boolean }) => void)) ?? (() => {});
            await this.executeTask(
              taskId,
              description,
              onLog,
              extra.cancelToken as { cancelled: boolean } | undefined,
              extra.taskProjectContext as TaskProjectContext | undefined,
              extra.executionRound as number | undefined,
              item.payload.requirementId,
            );
            resolveResponse('');
            return;
          }
          log.info('Task status update (informational, no LLM)', {
            agentId: this.id, summary: item.payload.summary,
          });
          resolveResponse('');
          return;
        }

        case 'mention': {
          const reply = await this.handleMessage(
            item.payload.content + markerSuffix,
            item.metadata?.senderId,
            senderInfo,
            buildHandleOpts({ sessionId: `sys_${this.id}_${ts}`, scenario: 'a2a' }),
          );
          resolveResponse(reply);
          return reply;
        }

        case 'requirement_update': {
          if (extra.actionRequired) {
            const reqId = item.payload.requirementId ?? 'unknown';
            const reply = await this.handleMessage(
              item.payload.content + markerSuffix,
              item.metadata?.senderId,
              senderInfo,
              buildHandleOpts({ sessionId: `requirement_${reqId}_${ts}`, scenario: 'requirement_action' }),
            );
            resolveResponse(reply);
            return reply;
          }
          log.info('Requirement update (informational, no LLM)', {
            agentId: this.id, summary: item.payload.summary,
          });
          resolveResponse('');
          return;
        }

        case 'requirement_comment': {
          const reqId = item.payload.requirementId ?? 'unknown';
          const reply = await this.handleMessage(
            item.payload.content + markerSuffix,
            item.metadata?.senderId,
            senderInfo,
            buildHandleOpts({ sessionId: `comment_${reqId}_${ts}`, scenario: 'comment_response' }),
          );
          resolveResponse(reply);
          return reply;
        }

        case 'task_comment': {
          const taskId = item.metadata?.taskId ?? item.payload.taskId;
          if (taskId && this.activeTasks.has(taskId)) {
            const round = this.getTaskExecutionRound(taskId);
            const sessionId = `task_${taskId}_r${round}`;
            this.injectUserMessage(sessionId, item.payload.content);
          } else {
            const commentTaskId = taskId ?? 'unknown';
            await this.handleMessage(
              item.payload.content + markerSuffix,
              item.metadata?.senderId,
              senderInfo,
              buildHandleOpts({ sessionId: `comment_${commentTaskId}_${ts}`, scenario: 'comment_response' }),
            );
          }
          resolveResponse('');
          return;
        }

        case 'review_request': {
          const reply = await this.handleMessage(
            item.payload.content + markerSuffix,
            item.metadata?.senderId,
            item.metadata?.senderName
              ? { name: item.metadata.senderName, role: item.metadata.senderRole ?? 'worker' }
              : undefined,
            buildHandleOpts({ sessionId: `review_${this.id}_${ts}`, scenario: 'review' }),
          );
          resolveResponse(reply);
          return reply;
        }

        case 'heartbeat': {
          await this.handleHeartbeat({
            agentId: this.id,
            triggeredAt: item.queuedAt,
          });
          const hbReply = COMPLETION_MARKER;
          resolveResponse(hbReply);
          return hbReply;
        }

        case 'system_event':
        case 'daily_report': {
          const reply = await this.handleMessage(
            item.payload.content + markerSuffix,
            undefined,
            undefined,
            buildHandleOpts({ sessionId: `sys_${this.id}_${ts}`, scenario: 'heartbeat' }),
          );
          resolveResponse(reply);
          return reply;
        }

        case 'memory_consolidation': {
          const reply = await this.handleMessage(
            item.payload.content + markerSuffix,
            undefined,
            undefined,
            buildHandleOpts({ sessionId: `sys_${this.id}_${ts}`, scenario: 'memory_consolidation' }),
          );
          resolveResponse(reply);
          return reply;
        }

        case 'session_reply': {
          const sessionId = extra.sessionId as string | undefined;
          const onLog = (extra.onLog as ((entry: { seq: number; type: string; content: string; metadata?: unknown; persist: boolean }) => void)) ?? (() => {});
          if (sessionId) {
            const reply = await this.respondInSession(sessionId, item.payload.content + markerSuffix, onLog);
            resolveResponse(reply);
            return reply;
          }
          const reply = await this.handleMessage(
            item.payload.content + markerSuffix,
            item.metadata?.senderId,
            senderInfo,
            buildHandleOpts({ sessionId: `sys_${this.id}_${ts}` }),
          );
          resolveResponse(reply);
          return reply;
        }
      }
    } catch (err) {
      rejectResponse(err);
      throw err;
    } finally {
      this.processingMailboxItemId = undefined;

      // Inject concise activity summary into main session for non-chat items
      // so the agent maintains narrative continuity across processing contexts.
      if (item.sourceType !== 'human_chat' && this.currentSessionId) {
        try {
          const outcome = this.buildActivityOutcome(item);
          if (outcome) {
            this.injectActivityToMainSession({
              type: item.sourceType,
              summary: item.payload.summary?.slice(0, 120) ?? item.sourceType,
              outcome,
              mailboxItemId: item.id,
              taskId: item.payload.taskId ?? item.metadata?.taskId as string | undefined,
              requirementId: item.payload.requirementId,
            });
          }
        } catch { /* never fail the main flow */ }
      }
    }
  }

  /** Derive a short outcome string for the activity log based on item type. */
  private buildActivityOutcome(item: MailboxItem): string | undefined {
    const extra = item.payload.extra ?? {};
    switch (item.sourceType) {
      case 'task_status_update':
        return extra.triggerExecution ? 'executed' : 'noted (informational)';
      case 'review_request':
        return 'reviewed';
      case 'a2a_message':
        return 'responded';
      case 'mention':
        return 'responded to mention';
      case 'task_comment':
        return item.payload.taskId && this.activeTasks.has(item.payload.taskId)
          ? 'injected into active task session'
          : 'responded to comment';
      case 'requirement_comment':
        return 'responded to requirement comment';
      case 'requirement_update':
        return (extra.actionRequired) ? 'processed (action required)' : 'noted (informational)';
      case 'heartbeat':
        return 'heartbeat processed';
      case 'session_reply':
        return 'replied in session';
      case 'system_event':
      case 'daily_report':
      case 'memory_consolidation':
        return 'processed';
      default:
        return 'processed';
    }
  }

  /**
   * Get the current execution round for a task (used for session ID construction).
   */
  private getTaskExecutionRound(_taskId: string): number {
    return 1;
  }

  /**
   * Reload the agent's role from its ROLE.md file on disk.
   * Used after overwriting ROLE.md with a custom system prompt (e.g., from Agent Father).
   */
  reloadRole(): void {
    const roleFile = join(this.dataDir, 'role', 'ROLE.md');
    if (!existsSync(roleFile)) return;
    try {
      const content = readFileSync(roleFile, 'utf-8');
      const name = content.match(/^#\s+(.+)$/m)?.[1]?.trim() || this.role.name;
      this.role = {
        ...this.role,
        name,
        systemPrompt: content,
      };
      log.info(`Role reloaded from disk for agent ${this.config.name}`);
    } catch (err) {
      log.warn(`Failed to reload role for agent ${this.config.name}`, { error: String(err) });
    }
  }

  /**
   * Reload the agent's heartbeat checklist from its HEARTBEAT.md file on disk.
   * Called when the agent modifies its own HEARTBEAT.md via file_edit/file_write.
   */
  reloadHeartbeat(): void {
    const heartbeatFile = join(this.dataDir, 'role', 'HEARTBEAT.md');
    if (!existsSync(heartbeatFile)) return;
    try {
      const content = readFileSync(heartbeatFile, 'utf-8');
      this.role = {
        ...this.role,
        heartbeatChecklist: content,
      };
      log.info(`Heartbeat checklist reloaded from disk for agent ${this.config.name}`);
    } catch (err) {
      log.warn(`Failed to reload heartbeat for agent ${this.config.name}`, { error: String(err) });
    }
  }

  /**
   * Start a fresh conversation session, discarding the current in-memory session context.
   * Called when the user explicitly starts a "New Chat".
   */
  startNewSession(): void {
    const session = this.memory.createSession(this.id);
    this.currentSessionId = session.id;
    log.info(`New session started for agent ${this.config.name}: ${session.id}`);
  }

  /**
   * Bind the current in-memory session to a DB session ID (ses_*).
   * Called after persistUserMessage creates a new DB session for a "new chat",
   * so subsequent messages with that DB sessionId reuse the same memory context.
   */
  bindDbSession(dbSessionId: string): void {
    if (this.currentSessionId) {
      this.dbSessionMap.set(dbSessionId, this.currentSessionId);
      log.debug(`Bound DB session ${dbSessionId} → memory session ${this.currentSessionId}`);
    }
  }

  /**
   * Restore the agent's memory context for an existing DB session.
   * If a mapping exists to a live memory session, switch to it.
   * Otherwise, create a new memory session populated with the DB messages.
   *
   * When `isRetry` is true, the last assistant reply (and preceding user
   * message) are stripped from the memory context so the retried message
   * doesn't see the old failed response.
   */
  restoreSessionFromHistory(
    dbSessionId: string,
    dbMessages: Array<{ role: string; content: string }>,
    options?: { isRetry?: boolean },
  ): void {
    const existingMemorySessionId = this.dbSessionMap.get(dbSessionId);
    if (existingMemorySessionId) {
      const session = this.memory.getSession(existingMemorySessionId);
      if (session) {
        this.currentSessionId = existingMemorySessionId;
        if (options?.isRetry) {
          while (session.messages.length > 0 && session.messages[session.messages.length - 1]!.role !== 'user') {
            session.messages.pop();
          }
          if (session.messages.length > 0 && session.messages[session.messages.length - 1]!.role === 'user') {
            session.messages.pop();
          }
          log.info(`Trimmed memory session for retry: ${existingMemorySessionId} (${session.messages.length} messages remaining)`);
        }
        log.debug(`Switched to existing memory session ${existingMemorySessionId} for DB session ${dbSessionId}`);
        return;
      }
      this.dbSessionMap.delete(dbSessionId);
    }

    const session = this.memory.createSession(this.id);
    this.dbSessionMap.set(dbSessionId, session.id);

    for (const msg of dbMessages) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        this.memory.appendMessage(session.id, {
          role: msg.role as 'user' | 'assistant',
          content: msg.content,
        });
      }
    }

    this.currentSessionId = session.id;
    log.info(
      `Restored session context for DB session ${dbSessionId} → memory session ${session.id} (${dbMessages.length} messages)`
    );
  }

  pause(reason?: string): void {
    this.pauseReason = reason;
    if (this.state.status !== 'offline') {
      this.cancelActiveStream();
      this.heartbeat.stop();
      this.attentionController.stop();
      if (this.memoryConsolidationTimer) {
        clearInterval(this.memoryConsolidationTimer);
        this.memoryConsolidationTimer = undefined;
      }
    }
    this.setStatus('paused');
    this.eventBus.emit('agent:paused', { agentId: this.id, reason });
    log.info(`Agent paused: ${this.config.name}`, { reason });
  }

  resume(): void {
    if (this.state.status !== 'paused') return;
    this.pauseReason = undefined;
    this.heartbeat.start();
    this.attentionController.start();
    if (!this.memoryConsolidationTimer) {
      this.memoryConsolidationTimer = setInterval(() => {
        this.consolidateMemory().catch(e =>
          log.warn('Memory consolidation failed', { error: String(e) })
        );
      }, Agent.MEMORY_CONSOLIDATION_INTERVAL_MS);
    }
    this.setStatus(this.activeTasks.size > 0 ? 'working' : 'idle');
    this.eventBus.emit('agent:resumed', { agentId: this.id });
    log.info(`Agent resumed: ${this.config.name}`);
  }

  getPauseReason(): string | undefined {
    return this.pauseReason;
  }

  /**
   * Inject a user message into a specific session (e.g. live comments during task execution).
   * Messages are buffered and flushed into the session between LLM turns
   * (after all tool results are appended) to avoid breaking message ordering.
   * If no task loop is running for this session, the message is appended directly.
   */
  injectUserMessage(sessionId: string, content: string): void {
    let session = this.memory.getSession?.(sessionId);
    if (!session) {
      session = this.memory.getOrCreateSession(this.id, sessionId);
    }

    const taskId = sessionId.startsWith('task_') ? sessionId.replace(/^task_/, '').replace(/_r\d+$/, '') : undefined;
    if (taskId && this.activeTasks.has(taskId)) {
      let queue = this.pendingInjections.get(sessionId);
      if (!queue) {
        queue = [];
        this.pendingInjections.set(sessionId, queue);
      }
      queue.push(content);
      log.debug('Buffered injected message for next LLM turn', { sessionId, contentLength: content.length, queueSize: queue.length });
    } else {
      this.memory.appendMessage(sessionId, { role: 'user', content });
      log.debug('Injected user message into session (direct)', { sessionId, contentLength: content.length });
    }
  }

  /**
   * Flush any buffered injections for a session into memory.
   * Called by the task execution loop after all tool results are appended.
   */
  private flushPendingInjections(sessionId: string): void {
    const queue = this.pendingInjections.get(sessionId);
    if (!queue || queue.length === 0) return;

    for (const content of queue) {
      this.memory.appendMessage(sessionId, { role: 'user', content });
    }
    log.info('Flushed pending injections into session', { sessionId, count: queue.length });
    this.pendingInjections.delete(sessionId);
  }

  /**
   * 执行聊天任务（高优先级）
   */
  async executeChatTask(
    taskId: string,
    description: string,
    onLog: (entry: {
      seq: number;
      type: string;
      content: string;
      metadata?: unknown;
      persist: boolean;
    }) => void,
    cancelToken?: { cancelled: boolean }
  ): Promise<void> {
    if (!this.taskExecutor) {
      throw new Error('Task executor not initialized');
    }

    const result = await this.taskExecutor.executeChatTask(
      taskId,
      async () => {
        return this._executeTaskInternal(taskId, description, onLog, cancelToken);
      },
      {
        priority: TaskPriority.HIGH,
        onProgress: (progress: number, currentStep?: string) => {
          onLog({
            seq: -1,
            type: 'progress',
            content: JSON.stringify({ progress, currentStep }),
            persist: false,
          });
        },
        cancelToken,
      }
    );

    if (result.status === TaskStatus.FAILED && result.error) {
      throw result.error;
    }
  }

  /**
   * 获取Agent状态摘要
   */
  getAgentStatusSummary() {
    if (!this.stateManager) {
      return {
        agentId: this.id,
        isBusy: this.activeTasks.size > 0,
        activeTaskCount: this.activeTasks.size,
        queueStats: {
          pending: 0,
          running: this.activeTasks.size,
          completed: 0,
          failed: 0,
          cancelled: 0,
          total: this.activeTasks.size,
        },
        currentTasks: Array.from(this.activeTasks).map(taskId => ({
          id: taskId,
          type: 'task' as const,
          priority: TaskPriority.MEDIUM,
          status: TaskStatus.RUNNING,
          progress: 0,
          startedAt: new Date(),
        })),
      };
    }

    return this.stateManager.getStatusSummary();
  }

  /**
   * 获取所有任务状态
   */
  getAllTasks() {
    if (!this.stateManager) {
      return [];
    }
    return this.stateManager.getAllTaskInfo();
  }

  getActiveTasks(): Array<{ taskId: string }> {
    return Array.from(this.activeTasks).map(taskId => ({ taskId }));
  }

  /**
   * Returns the task ID currently being executed.
   * Prefers the per-task AsyncLocalStorage context (safe for concurrent tasks)
   * over the shared instance field which can be overwritten by a later task.
   */
  getCurrentTaskId(): string | undefined {
    return taskAsyncContext.getStore()?.taskId ?? this.currentTaskId;
  }

  private getCurrentRequirementId(): string | undefined {
    return taskAsyncContext.getStore()?.requirementId;
  }

  /**
   * Externally remove a task from the activeTasks set.
   * Used when a task reaches a terminal state outside of the executeTask finally block
   * (e.g. reviewer completes the task while the execution is already winding down).
   */
  removeActiveTask(taskId: string): void {
    this.activeTasks.delete(taskId);
    this.activeTaskGen.delete(taskId);
    for (const key of this.pendingInjections.keys()) {
      if (key.startsWith(`task_${taskId}_`)) this.pendingInjections.delete(key);
    }
  }

  /**
   * 获取运行中的任务
   */
  getRunningTasks() {
    if (!this.stateManager) {
      return Array.from(this.activeTasks).map(taskId => ({
        id: taskId,
        type: 'task' as const,
        priority: TaskPriority.MEDIUM,
        status: TaskStatus.RUNNING,
        progress: 0,
        currentStep: undefined,
        startedAt: new Date(),
        completedAt: undefined,
        error: undefined,
        result: undefined,
      }));
    }
    return this.stateManager.getRunningTaskInfo();
  }

  /**
   * 取消任务
   */
  cancelTask(taskId: string): boolean {
    if (!this.taskExecutor) {
      return false;
    }
    return this.taskExecutor.cancelTask(taskId);
  }

  /** Cancel any active streaming response */
  cancelActiveStream(): void {
    if (this.activeStreamToken) {
      this.activeStreamToken.cancelled = true;
      log.info('Active stream cancelled', { agentId: this.id });
    }
  }

  /** Get a cancel token for the current stream */
  getStreamCancelToken(): { cancelled: boolean } {
    this.activeStreamToken = { cancelled: false };
    return this.activeStreamToken;
  }

  /** Access the guardrail pipeline to add/remove guardrails */
  getGuardrails(): GuardrailPipeline {
    return this.guardrails;
  }

  /** Register a tool execution hook for before/after processing */
  addToolHook(hook: ToolHook): void {
    this.toolHooks.register(hook);
  }

  /** Access the tool hook registry */
  getToolHooks(): ToolHookRegistry {
    return this.toolHooks;
  }

  /**
   * 更新任务进度
   */
  updateTaskProgress(taskId: string, progress: number, currentStep?: string): boolean {
    if (!this.taskExecutor) {
      return false;
    }
    return this.taskExecutor.updateProgress(taskId, progress, currentStep);
  }

  /**
   * 更新令牌使用量
   */
  /**
   * Create an LLM-powered summarizer that uses the cheapest available model
   * to produce high-quality conversation summaries during context compaction.
   */
  private createLLMSummarizer(): LLMSummarizer {
    return async (messages: LLMMessage[]): Promise<string> => {
      const textParts: string[] = [];
      for (const msg of messages) {
        const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        if (msg.role === 'system') continue;
        const truncated = text.slice(0, 300);
        textParts.push(`[${msg.role}]: ${truncated}`);
      }
      const conversationText = textParts.join('\n').slice(0, 8000);

      const response = await this.llmRouter.chat({
        messages: [
          {
            role: 'system',
            content: 'You are a conversation summarizer. Given a conversation history, produce a concise summary that preserves: (1) key decisions and their reasoning, (2) important file paths, variable names, and technical details, (3) errors encountered and how they were resolved, (4) current task progress and next steps. Keep the summary under 1500 characters. Write in the same language as the conversation.',
          },
          {
            role: 'user',
            content: `Summarize the following conversation history:\n\n${conversationText}`,
          },
        ],
        maxTokens: 1024,
        temperature: 0.2,
      });

      return response.content || '';
    };
  }

  /**
   * Manus-inspired: offload large tool results to filesystem.
   * Keeps a compact reference in context, full data in a file the agent can re-read.
   * This prevents context bloat while preserving all information (restorable compression).
   */
  private extractTaskLabel(description: string, taskId: string): string {
    const lines = description.split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (line.startsWith('#') || line.startsWith('**') || line.startsWith('[') || line.startsWith('//')) continue;
      if (line.length > 10 && line.length < 200 && !line.includes('Current time:') && !line.includes('Execution Context')) {
        return line.slice(0, 100);
      }
    }
    return `Task ${taskId}`;
  }

  private static readonly BROWSER_INTERACTIVE_TOOLS = new Set([
    'take_snapshot', 'take_screenshot', 'evaluate_script',
    'list_console_messages', 'list_network_requests', 'get_network_request',
    'lighthouse_audit', 'performance_stop_trace', 'performance_analyze_insight',
  ]);

  private offloadLargeResult(toolName: string, result: string): string {
    const OFFLOAD_THRESHOLD = 50_000;
    if (result.length <= OFFLOAD_THRESHOLD) return result;

    // file_read already has built-in auto-limiting — don't re-offload its output
    // to avoid the infinite loop where reading the offloaded file triggers another offload.
    if (toolName === 'file_read') return result;

    const baseName = toolName.includes('__') ? toolName.split('__').pop()! : toolName;
    const isBrowserTool = Agent.BROWSER_INTERACTIVE_TOOLS.has(baseName);
    const previewSize = isBrowserTool ? 30_000 : 2_000;

    try {
      const offloadDir = join(this.dataDir, 'tool-outputs');
      mkdirSync(offloadDir, { recursive: true });
      const filename = `${toolName}_${++this.toolResultCounter}_${Date.now()}.txt`;
      const filepath = join(offloadDir, filename);
      writeFileSync(filepath, result);

      const preview = result.slice(0, previewSize);
      const lineCount = result.split('\n').length;
      return [
        `[FULL output (${result.length} chars, ${lineCount} lines) saved to: ${filepath}]`,
        `[NOTE: The content below is only the first ${previewSize} chars. The complete, untruncated result is in the file above.]`,
        `[To read the full content, use file_read with offset and limit parameters to read in chunks, e.g.: file_read(path="${filepath}", offset=1, limit=500)]`,
        ``,
        preview,
        ``,
        `[... remaining ${result.length - previewSize} chars in file ...]`,
      ].join('\n');
    } catch {
      const fallbackSize = isBrowserTool ? 30_000 : 8_000;
      return result.slice(0, fallbackSize) + `\n\n[... output truncated at ${fallbackSize} of ${result.length} total chars due to file-save failure ...]`;
    }
  }

  private estimateMessagesTokens(messages: LLMMessage[]): number {
    const counter = (() => {
      try {
        const { getDefaultTokenCounter } = require('./token-counter.js');
        return getDefaultTokenCounter();
      } catch { return null; }
    })();
    if (!counter) return 0;
    let total = 0;
    for (const msg of messages) {
      const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      total += counter.countMessageTokens(text, msg.role);
    }
    return total;
  }

  private calibrateTokenCounter(actualInputTokens: number): void {
    if (this.lastEstimatedInputTokens > 0 && actualInputTokens > 0) {
      try {
        const { getDefaultTokenCounter } = require('./token-counter.js');
        const counter = getDefaultTokenCounter();
        if ('calibrate' in counter) {
          (counter as any).calibrate(this.lastEstimatedInputTokens, actualInputTokens);
        }
      } catch { /* ignore */ }
    }
    this.lastEstimatedInputTokens = 0;
  }

  private checkDailyTokenBudget(): void {
    const dailyLimit = this.config.llmConfig?.maxTokensPerDay;
    if (dailyLimit && this.getTokensUsed() >= dailyLimit) {
      const msg = `Daily token budget exhausted (${this.getTokensUsed()} / ${dailyLimit})`;
      log.warn(msg, { agentId: this.id });
      this.pause(msg);
      throw new Error(`Agent ${this.id}: ${msg}`);
    }
  }

  private updateTokensUsed(tokens: number): void {
    this.state.tokensUsedToday += tokens;
    if (this.stateManager) {
      this.stateManager.updateTokensUsed(tokens);
    }
    this.notifyStateChange();
  }

  /**
   * 获取令牌使用量
   */
  private getTokensUsed(): number {
    if (this.stateManager) {
      return this.stateManager.getTokensUsed();
    }
    return this.state.tokensUsedToday;
  }

  /**
   * 获取令牌使用量（公开方法）
   */
  getTokensUsedToday(): number {
    return this.getTokensUsed();
  }

  /**
   * Reset daily token counter (called at midnight by scheduler).
   */
  resetDailyTokens(): void {
    this.state.tokensUsedToday = 0;
    if (this.stateManager) {
      this.stateManager.resetTokensUsed();
    }
    this.notifyStateChange();
  }


  get maxToolIterations(): number {
    return this._maxToolIterations;
  }

  set maxToolIterations(value: number) {
    this._maxToolIterations = value <= 0 ? Infinity : value;
  }

  setOrgContext(ctx: OrgContext): void {
    this.orgContext = ctx;
  }

  setTeamDataDir(dir: string): void {
    this.teamDataDir = dir;
  }

  private getTeamContextParams(): { teamAnnouncements?: string; teamNorms?: string; teamDataDir?: string; isTeamManager?: boolean } {
    if (!this.teamDataDir) return {};
    const annPath = join(this.teamDataDir, 'ANNOUNCEMENT.md');
    const normsPath = join(this.teamDataDir, 'NORMS.md');
    const ann = existsSync(annPath) ? readFileSync(annPath, 'utf-8').trim() : '';
    const norms = existsSync(normsPath) ? readFileSync(normsPath, 'utf-8').trim() : '';
    return {
      teamAnnouncements: ann || undefined,
      teamNorms: norms || undefined,
      teamDataDir: this.teamDataDir,
      isTeamManager: this.config.agentRole === 'manager',
    };
  }

  setIdentityContext(ctx: IdentityContext): void {
    this.identityContext = ctx;
  }

  addDynamicContextProvider(provider: () => string, key?: string): void {
    const providerKey = key ?? `provider_${this.dynamicContextProviders.size}`;
    this.dynamicContextProviders.set(providerKey, provider);
  }

  injectSkillInstructions(skillName: string, instructions: string): void {
    this.activatedSkillInstructions.set(skillName, instructions);
  }

  hasSkillInstructions(skillName: string): boolean {
    return this.activatedSkillInstructions.has(skillName);
  }

  getActiveSkillNames(): string[] {
    const names = new Set(this.config.skills);
    for (const name of this.activatedSkillInstructions.keys()) {
      names.add(name);
    }
    return [...names];
  }

  deactivateSkill(skillName: string): void {
    this.activatedSkillInstructions.delete(skillName);
  }

  setAvailableSkillCatalog(catalog: Array<{ name: string; description: string; category: string }>): void {
    this.availableSkillCatalog = catalog;
  }

  getAvailableSkillCatalog(): Array<{ name: string; description: string; category: string }> {
    return this.availableSkillCatalog;
  }

  setSkillMcpActivator(
    cb: (
      skillName: string,
      mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>,
    ) => Promise<AgentToolHandler[]>,
  ): void {
    this.skillMcpActivator = cb;
  }

  setSkillSearcher(cb: (query: string) => Promise<Array<{ name: string; description: string; source: string; slug?: string; author?: string; githubRepo?: string; githubSkillPath?: string }>>): void {
    this.skillSearcher = cb;
  }

  setSkillInstaller(cb: (request: Record<string, unknown>) => Promise<{ installed: boolean; name: string; method: string }>): void {
    this.skillInstaller = cb;
  }

  setUserApprovalRequester(cb: (opts: {
    agentId: string; agentName: string; title: string; description: string;
    options?: Array<{ id: string; label: string; description?: string }>;
    allowFreeform?: boolean; priority?: string; relatedTaskId?: string;
  }) => Promise<{ approved: boolean; comment?: string; selectedOption?: string }>): void {
    this.userApprovalRequester = cb;
  }

  setUserNotifier(cb: (opts: { type: string; title: string; body: string; priority?: string; actionType?: string; actionTarget?: string; metadata?: Record<string, unknown> }) => void): void {
    this.userNotifier = cb;
  }

  /**
   * Inject a concise activity summary into the main chat session.
   * This keeps the agent aware of what it has done across different processing
   * contexts (task execution, review, A2A, etc.) and surfaces the activity
   * in the frontend chat timeline.
   */
  /** Activity types that warrant a full session message injection */
  private static readonly SESSION_INJECT_TYPES = new Set([
    'notify_user', 'escalation', 'task_completed', 'task_failed',
  ]);

  injectActivityToMainSession(opts: {
    type: string;
    summary: string;
    outcome?: string;
    mailboxItemId?: string;
    taskId?: string;
    requirementId?: string;
  }): void {
    if (!this.currentSessionId) return;

    this.lastInjectedActivityType = opts.type;

    const text = opts.summary;
    this.recentActivityRing.push(`[${opts.type}] ${text}${opts.outcome ? ' → ' + opts.outcome : ''}`);
    if (this.recentActivityRing.length > Agent.ACTIVITY_RING_SIZE) {
      this.recentActivityRing.shift();
    }

    // Only inject user-facing activity types as session messages to keep sessions thin.
    // All other types (heartbeats, A2A, routine status) stay in recentActivityRing only.
    if (!Agent.SESSION_INJECT_TYPES.has(opts.type)) return;

    this.memory.appendMessage(this.currentSessionId, {
      role: 'assistant',
      content: text,
    });
    this.eventBus.emit('agent:activity-log', {
      agentId: this.id,
      sessionId: this.currentSessionId,
      message: text,
      metadata: {
        activityLog: true,
        activityType: opts.type,
        ...(opts.outcome ? { outcome: opts.outcome } : {}),
        ...(opts.mailboxItemId ? { mailboxItemId: opts.mailboxItemId } : {}),
        ...(opts.taskId ? { taskId: opts.taskId } : {}),
        ...(opts.requirementId ? { requirementId: opts.requirementId } : {}),
      },
    });
  }

  /**
   * Get the last N activity summaries for triage context.
   */
  private recentActivitySummaries(count = 5): string[] {
    return this.recentActivityRing.slice(-count);
  }

  /**
   * Update the agent's persistent situational awareness from a triage result.
   * This cognition is injected into all subsequent system prompts via getDynamicContext().
   */
  private updateCognition(result: TriageResult): void {
    const lines: string[] = [];
    lines.push('## Current Situational Awareness (latest triage)');
    lines.push(`Decision: Processing item [${result.processItemId}]`);
    if (result.deferItemIds.length > 0) {
      lines.push(`Deferred ${result.deferItemIds.length} item(s)`);
    }
    if (result.dropItemIds.length > 0) {
      lines.push(`Dropped ${result.dropItemIds.length} item(s)`);
    }
    lines.push(`Reasoning: ${result.reasoning}`);
    this.currentCognition = lines.join('\n');
  }

  private getDynamicContext(): string | undefined {
    const parts = [...this.dynamicContextProviders.values()].map(p => p()).filter(Boolean);
    for (const [name, instructions] of this.activatedSkillInstructions) {
      parts.push(`<skill name="${name}">\n${instructions}\n</skill>`);
    }
    if (this.currentCognition) {
      parts.push(this.currentCognition);
    }
    return parts.length > 0 ? parts.join('\n\n') : undefined;
  }

  private getMailboxContext(): {
    currentFocus?: { type: string; label: string; elapsedMs: number; taskId?: string };
    queueDepth: number;
    topQueued?: Array<{ type: string; priority: number; summary: string }>;
    recentDecisions?: Array<{ type: string; reasoning: string }>;
    mergedContent?: string;
  } | undefined {
    const mind = this.attentionController.getMindState();
    if (mind.attentionState === 'idle' && mind.mailboxDepth === 0 && mind.recentDecisions.length === 0) {
      return undefined;
    }

    const focus = this.attentionController.getCurrentFocus();
    return {
      currentFocus: focus ? {
        type: focus.sourceType,
        label: focus.payload.summary,
        elapsedMs: focus.startedAt
          ? Date.now() - new Date(focus.startedAt).getTime()
          : Date.now() - new Date(focus.queuedAt).getTime(),
        taskId: focus.payload.taskId,
      } : undefined,
      queueDepth: mind.mailboxDepth,
      topQueued: mind.queuedItems.map(i => ({
        type: i.sourceType,
        priority: i.priority,
        summary: i.summary,
      })),
      recentDecisions: mind.recentDecisions.slice(-5).map(d => ({
        type: d.decisionType,
        reasoning: d.reasoning,
      })),
    };
  }

  setAuditCallback(
    cb: (event: {
      type: string;
      action: string;
      tokensUsed?: number;
      durationMs?: number;
      success: boolean;
      detail?: string;
    }) => void
  ): void {
    this.auditCallback = cb;
  }

  getMetrics(period: '1h' | '24h' | '7d' = '24h'): AgentMetricsSnapshot {
    return this.metricsCollector.getMetrics(period);
  }

  getUsageStats() {
    return this.metricsCollector.getUsageStats();
  }

  private emitAudit(event: {
    type: string;
    action: string;
    tokensUsed?: number;
    durationMs?: number;
    success: boolean;
    detail?: string;
  }): void {
    this.metricsCollector.recordAudit(event);
    this.auditCallback?.(event);

    const actId = this.state.currentActivity?.id;
    if (actId && event.type !== 'tool_call') {
      const logType: AgentActivityLogEntry['type'] =
        event.type === 'llm_request' ? 'llm_request' :
        event.type === 'error' ? 'error' : 'status';
      const parts: string[] = [event.action];
      if (event.durationMs) parts.push(`${(event.durationMs / 1000).toFixed(1)}s`);
      if (event.tokensUsed) parts.push(`${event.tokensUsed} tokens`);
      if (!event.success) parts.push('FAILED');
      this.emitActivityLog(actId, logType, parts.join(' · '), {
        tokensUsed: event.tokensUsed,
        durationMs: event.durationMs,
        action: event.action,
        success: event.success,
      });
    }
  }

  setApprovalCallback(cb: ApprovalCallback): void {
    this.approvalCallback = cb;
    this.rebuildShellToolWithApproval();
  }

  private rebuildShellToolWithApproval(): void {
    const wp = this.pathPolicy?.primaryWorkspace;
    const newShell = createBuiltinTools({
      agentId: this.id,
      workspacePath: wp,
      pathPolicy: this.pathPolicy,
      onCommandApproval: this.getCommandApprovalCallback(),
    }).find(t => t.name === 'shell_execute');
    if (newShell) this.tools.set('shell_execute', newShell);
  }

  private getCommandApprovalCallback(): ((command: string, reason: string) => Promise<{ approved: boolean; comment?: string }>) | undefined {
    if (!this.approvalCallback) return undefined;
    return async (command: string, reason: string) => this.approvalCallback!({
      agentId: this.id,
      agentName: this.config.name,
      toolName: 'shell_execute',
      toolArgs: { command },
      reason,
      taskId: this.getCurrentTaskId(),
    });
  }

  setEscalationCallback(cb: (agentId: string, reason: string) => void): void {
    this.escalationCallback = cb;
  }

  setStateChangeCallback(
    cb: (
      agentId: string,
      state: { status: string; tokensUsedToday: number; activeTaskIds: string[]; lastError?: string; lastErrorAt?: string; currentActivity?: AgentActivity }
    ) => void
  ): void {
    this.stateChangeCallback = cb;
  }

  private notifyStateChange(): void {
    if (this.stateChangeCallback) {
      this.stateChangeCallback(this.id, {
        status: this.state.status,
        tokensUsedToday: this.state.tokensUsedToday,
        activeTaskIds: [...this.activeTasks],
        lastError: this.state.lastError,
        lastErrorAt: this.state.lastErrorAt,
        currentActivity: this.state.currentActivity,
      });
    }
  }

  setActivityCallbacks(cbs: {
    onStart?: (activity: AgentActivity & { agentId: string }) => void;
    onLog?: (data: { activityId: string; agentId: string; seq: number; type: string; content: string; metadata?: Record<string, unknown> }) => void;
    onEnd?: (activityId: string, summary: { endedAt: string; totalTokens: number; totalTools: number; success: boolean; summary?: string; keywords?: string }) => void;
  }): void {
    this.onActivityStartCb = cbs.onStart;
    this.onActivityLogCb = cbs.onLog;
    this.onActivityEndCb = cbs.onEnd;
  }

  // ─── Activity Tracking ───────────────────────────────────────────────────────

  private startActivity(type: AgentActivity['type'], label: string, extra?: Partial<AgentActivity>): string {
    const id = `act-${this.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const mailboxItemId = extra?.mailboxItemId ?? this.processingMailboxItemId;
    const activity: AgentActivity = { id, type, label, startedAt: new Date().toISOString(), ...extra, ...(mailboxItemId ? { mailboxItemId } : {}) };
    this.state.currentActivity = activity;
    this.activityLogs.set(id, []);
    this.activitySeqCounters.set(id, 0);

    if (this.activityLogs.size > Agent.MAX_ACTIVITY_LOGS_KEPT) {
      const keys = [...this.activityLogs.keys()];
      for (let i = 0; i < keys.length - Agent.MAX_ACTIVITY_LOGS_KEPT; i++) {
        this.activityLogs.delete(keys[i]);
        this.activitySeqCounters.delete(keys[i]);
      }
    }

    try { this.onActivityStartCb?.({ ...activity, agentId: this.id }); } catch { /* best effort */ }
    this.emitActivityLog(id, 'status', `Started: ${label}`);
    this.notifyStateChange();
    return id;
  }

  private computeActivitySummary(activityId: string): { summary: string; keywords: string } {
    const logs = this.activityLogs.get(activityId) ?? [];
    const toolNames = new Set<string>();
    const errors: string[] = [];
    let lastText = '';

    for (const log of logs) {
      if (log.type === 'tool_start') {
        const name = (log.metadata?.toolName as string) ?? '';
        if (name) toolNames.add(name);
      }
      if (log.type === 'error') errors.push(log.content.slice(0, 100));
      if (log.type === 'text') lastText = log.content.slice(0, 200);
    }

    const parts: string[] = [];
    if (toolNames.size > 0) parts.push(`Used: ${[...toolNames].join(', ')}`);
    if (errors.length > 0) parts.push(`Errors: ${errors.slice(0, 2).join('; ')}`);
    if (lastText) parts.push(lastText);

    return {
      summary: parts.join('. ').slice(0, 500),
      keywords: [...toolNames, ...errors.map(e => e.split(':')[0]?.trim() ?? '')].filter(Boolean).join(','),
    };
  }

  private endActivity(activityId?: string, opts?: { success?: boolean }): void {
    const aid = activityId ?? this.state.currentActivity?.id;
    if (aid) {
      this.emitActivityLog(aid, 'status', 'Completed');

      const logs = this.activityLogs.get(aid) ?? [];
      let totalTokens = 0;
      let totalTools = 0;
      for (const l of logs) {
        if (l.type === 'llm_request' && l.metadata?.tokensUsed) totalTokens += l.metadata.tokensUsed as number;
        if (l.type === 'tool_start' || l.type === 'tool_end') totalTools++;
      }
      totalTools = Math.floor(totalTools / 2);

      const { summary, keywords } = this.computeActivitySummary(aid);

      try {
        this.onActivityEndCb?.(aid, {
          endedAt: new Date().toISOString(),
          totalTokens,
          totalTools,
          success: opts?.success !== false,
          summary,
          keywords,
        });
      } catch { /* best effort */ }

      this.activityLogs.delete(aid);
      this.activitySeqCounters.delete(aid);
    }
    this.state.currentActivity = undefined;
    this.notifyStateChange();
  }

  private emitActivityLog(activityId: string, type: AgentActivityLogEntry['type'], content: string, metadata?: Record<string, unknown>): void {
    // Defensive: strip completion marker from all log content regardless of caller
    const cleanContent = (type === 'text' || type === 'status')
      ? stripCompletionMarker(content)
      : content;

    let logs = this.activityLogs.get(activityId);
    if (!logs) {
      logs = [];
      this.activityLogs.set(activityId, logs);
    }

    const seq = (this.activitySeqCounters.get(activityId) ?? 0) + 1;
    this.activitySeqCounters.set(activityId, seq);

    const entry: AgentActivityLogEntry = {
      seq,
      type,
      content: cleanContent,
      metadata,
      createdAt: new Date().toISOString(),
    };
    logs.push(entry);

    if (logs.length > Agent.MAX_ACTIVITY_LOG_ENTRIES) {
      logs.splice(0, logs.length - Agent.MAX_ACTIVITY_LOG_ENTRIES);
    }

    try { this.onActivityLogCb?.({ activityId, agentId: this.id, seq, type, content: cleanContent, metadata }); } catch { /* best effort */ }

    this.eventBus.emit('agent:activity_log', {
      agentId: this.id,
      activityId,
      ...entry,
    });
  }

  getActivityLogs(activityId: string): AgentActivityLogEntry[] {
    return this.activityLogs.get(activityId) ?? [];
  }

  getCurrentActivity(): AgentActivity | undefined {
    return this.state.currentActivity;
  }

  getCurrentActivityId(): string | undefined {
    return this.state.currentActivity?.id;
  }

  /** Return summary of currently-live in-memory activities */
  getRecentActivities(): Array<{
    id: string;
    type: AgentActivity['type'];
    label: string;
    taskId?: string;
    heartbeatName?: string;
    startedAt: string;
    logCount: number;
  }> {
    const current = this.state.currentActivity;
    if (!current) return [];

    const logs = this.activityLogs.get(current.id);
    return [{
      id: current.id,
      type: current.type,
      label: current.label,
      taskId: current.taskId,
      heartbeatName: current.heartbeatName,
      startedAt: current.startedAt,
      logCount: logs?.length ?? 0,
    }];
  }

  /** Inject a function that returns tasks for system prompt context (all org tasks with assignment info) */
  setTasksFetcher(
    fetcher: () => Array<{
      id: string;
      title: string;
      description: string;
      status: string;
      priority: string;
      assignedAgentId?: string;
      assignedAgentName?: string;
    }>
  ): void {
    this.tasksFetcher = fetcher;
  }

  async generateDailyReport(): Promise<string> {
    const dailyLog = this.memory.getRecentDailyLogs(1);
    const state = this.getState();
    const prompt = [
      `[DAILY REPORT REQUEST]`,
      `Generate a brief daily status report. Include:`,
      `1. What you worked on today (if anything)`,
      `2. Current status and any blockers`,
      `3. What you plan to work on next`,
      ``,
      `Your status: ${state.status}, tokens used today: ${this.getTokensUsed()}`,
      dailyLog ? `\nRecent activity log:\n${dailyLog}` : `\nNo recent activity recorded.`,
      ``,
      `Keep the report concise (3-5 sentences). Do NOT use any tools — just summarize from your memory.`,
    ].join('\n');

    try {
      const report = await this.sendMessage(prompt, undefined, undefined, {
        sourceType: 'daily_report',
        sessionId: `sys_${this.id}_${Date.now()}`,
        scenario: 'heartbeat',
      });
      this.memory.writeDailyLog(this.id, `## Daily Report\n\n${report}`);
      return report;
    } catch (error) {
      log.error('Failed to generate daily report', { error: String(error) });
      return `Unable to generate report: ${String(error)}`;
    }
  }

  getUptime(): number {
    return this.state.status !== 'offline'
      ? Date.now() - new Date(this.config.createdAt).getTime()
      : 0;
  }

  async handleMessage(
    userMessage: string,
    senderId?: string,
    senderInfo?: { name: string; role: string },
    options?: {
      sessionId?: string;
      channelContext?: Array<{ role: string; content: string }>;
      images?: string[];
      fileNames?: string[];
      allowedTools?: Set<string>;
      scenario?: 'chat' | 'task_execution' | 'heartbeat' | 'a2a' | 'comment_response' | 'memory_consolidation' | 'review';
      maxToolIterations?: number;
      toolEventCollector?: Array<{
        tool: string;
        status: 'done' | 'error';
        arguments?: unknown;
        result?: string;
        durationMs?: number;
      }>;
    }
  ): Promise<string> {
    if (this.activeTasks.size === 0) {
      this.setStatus('working');
    }

    const scenario = options?.scenario ?? 'chat';
    const isLightweight = scenario !== 'chat' && scenario !== 'task_execution' && scenario !== 'review';
    const PREEMPTABLE_SCENARIOS = new Set(['heartbeat', 'memory_consolidation']);
    const isPreemptable = PREEMPTABLE_SCENARIOS.has(scenario);

    // Track chat activity (only if not already in a heartbeat or other activity)
    let chatActivityId: string | undefined;
    if (!this.state.currentActivity) {
      let actType: AgentActivity['type'] = 'chat';
      let actLabel: string;
      const peerName = senderInfo?.name || senderId || undefined;
      switch (scenario) {
        case 'a2a':
          actType = 'a2a';
          actLabel = peerName ? `Chat from ${peerName}` : 'Agent Message';
          break;
        case 'heartbeat':
          actType = 'internal';
          actLabel = userMessage.includes('DAILY REPORT') ? 'Daily Report'
            : userMessage.includes('MEMORY FLUSH') ? 'Memory Flush'
            : 'Internal Operation';
          break;
        case 'comment_response':
          actType = 'chat';
          actLabel = peerName ? `Comment reply to ${peerName}` : 'Comment Reply';
          break;
        case 'review':
          actType = 'internal';
          actLabel = peerName ? `Reviewing task from ${peerName}` : 'Task Review';
          break;
        default:
          actLabel = peerName ? `Chat with ${peerName}` : 'Human Chat';
          break;
      }
      chatActivityId = this.startActivity(actType, actLabel);
    }

    // Run input guardrails
    const inputCheck = await this.guardrails.checkInput(userMessage, {
      agentId: this.id,
      senderId,
    });
    if (!inputCheck.passed) {
      if (chatActivityId) this.endActivity(chatActivityId);
      return `I cannot process this request: ${inputCheck.reason}`;
    }
    const effectiveMessage = inputCheck.transformedInput ?? userMessage;

    const maxHistory = 200;

    // Session resolution: explicit sessionId > auto-generated
    let sessionId: string;
    if (options?.sessionId) {
      sessionId = options.sessionId;
    } else if (!isLightweight) {
      if (!this.currentSessionId) {
        const session = this.memory.createSession(this.id);
        this.currentSessionId = session.id;
      }
      sessionId = this.currentSessionId;
    } else {
      sessionId = options?.sessionId ?? `${scenario}_${this.id}_${Date.now()}`;
    }
    this.memory.getOrCreateSession(this.id, sessionId);
    const userContent = await this.buildUserContent(userMessage, options?.images, options?.fileNames);
    this.memory.appendMessage(sessionId, { role: 'user', content: userContent });

    // Inject channel context: on first turn, prepend all messages.
    // On subsequent turns, inject latest N messages as a context block if changed.
    if (options?.channelContext?.length) {
      const session = this.memory.getSession(sessionId);
      if (session) {
        const contextHash = options.channelContext.map(m => m.content).join('|').slice(0, 200);
        const lastHash = (session as unknown as { _channelCtxHash?: string })._channelCtxHash;
        if (session.messages.length <= 1) {
          const channelMsgs: LLMMessage[] = options.channelContext.map(m => ({
            role: (m.role === 'assistant' ? 'assistant' : 'user') as LLMMessage['role'],
            content: m.content,
          }));
          session.messages = [...channelMsgs, ...session.messages];
          (session as unknown as { _channelCtxHash: string })._channelCtxHash = contextHash;
        } else if (lastHash !== contextHash) {
          const latest = options.channelContext.slice(-5);
          const block = latest.map(m => `[${m.role}] ${m.content}`).join('\n');
          this.memory.appendMessage(sessionId, {
            role: 'user',
            content: `[Channel context update — latest messages]\n${block}\n[End channel context]`,
          });
          (session as unknown as { _channelCtxHash: string })._channelCtxHash = contextHash;
        }
      }
    }

    // Set active model on token counter and ensure tiktoken encoder is loaded
    const effectiveModelName = this.llmRouter.getActiveModelName(this.getEffectiveProvider());
    if (effectiveModelName) {
      const { getDefaultTokenCounter } = await import('./token-counter.js');
      const counter = getDefaultTokenCounter();
      counter.setActiveModel(effectiveModelName);
      await counter.ensureReady();
    }

    const systemPrompt = await this.contextEngine.buildSystemPrompt({
      agentId: this.id,
      agentName: this.config.name,
      role: this.role,
      orgContext: this.orgContext,
      contextMdPath: this.contextMdPath,
      memory: this.memory,
      currentQuery: effectiveMessage,
      identity: this.identityContext,
      senderIdentity: senderId && senderInfo ? { id: senderId, ...senderInfo } : undefined,
      assignedTasks: isLightweight ? undefined : this.tasksFetcher?.(),
      deliverableContext: isLightweight ? undefined : this.getDeliverableContext(effectiveMessage),
      environment: this.environmentProfile,
      scenario,
      agentWorkspace: this.pathPolicy ? {
        primaryWorkspace: this.pathPolicy.primaryWorkspace,
        sharedWorkspace: this.pathPolicy.sharedWorkspace,
        builderArtifactsDir: this.pathPolicy.builderArtifactsDir,
      } : undefined,
      dynamicContext: this.getDynamicContext(),
      agentDataDir: this.dataDir,
      availableSkills: this.availableSkillCatalog,
      mailboxContext: this.getMailboxContext(),
      ...this.getTeamContextParams(),
    });

    let llmTools = this.buildToolDefinitions({
      userMessage: effectiveMessage,
      isReview: scenario === 'review',
    });
    if (options?.allowedTools) {
      llmTools = llmTools.filter(t => options.allowedTools!.has(t.name));
    }

    const sessionMessages = this.memory.getRecentMessages(sessionId, maxHistory);
    const prepared = await this.contextEngine.prepareMessages({
      systemPrompt,
      sessionMessages,
      memory: this.memory,
      sessionId,
      agentId: this.id,
      modelContextWindow: this.llmRouter.getModelContextWindow(this.getEffectiveProvider()),
      modelMaxOutput: this.llmRouter.getModelMaxOutput(this.getEffectiveProvider()),
      toolDefinitions: llmTools,
    });
    const messages = prepared.messages;
    log.debug('Context usage for chat', { usagePercent: prepared.usage.usagePercent, totalUsed: prepared.usage.totalUsed });

    const useCompaction = this.llmRouter.isCompactionSupported(this.getEffectiveProvider());
    try {
      this.checkDailyTokenBudget();
      this.lastEstimatedInputTokens = this.estimateMessagesTokens(messages);
      const llmStart = Date.now();
      let response = await this.withNetworkRetry(
        () => this.llmRouter.chat({
          messages,
          tools: llmTools.length > 0 ? llmTools : undefined,
          metadata: this.getLLMMetadata(sessionId),
          compaction: useCompaction,
        }, this.getEffectiveProvider()),
        'Chat LLM call',
      );

      const tokensThisCall = response.usage.inputTokens + response.usage.outputTokens;
      this.updateTokensUsed(tokensThisCall);
      this.calibrateTokenCounter(response.usage.inputTokens);
      this.emitAudit({
        type: 'llm_request',
        action: 'chat',
        tokensUsed: tokensThisCall,
        durationMs: Date.now() - llmStart,
        success: true,
      });

      let toolIterations = 0;
      const effectiveMaxIter = options?.maxToolIterations ?? this._maxToolIterations;

      while (
        (response.finishReason === 'tool_use' && response.toolCalls?.length) ||
        response.finishReason === 'max_tokens'
      ) {
        if (++toolIterations > effectiveMaxIter) {
          log.warn('Tool loop hit max iterations', {
            agentId: this.id,
            iterations: toolIterations,
            cap: effectiveMaxIter,
          });
          break;
        }

        // Handle max_tokens continuation (model was cut off mid-response)
        if (response.finishReason === 'max_tokens' && !response.toolCalls?.length) {
          this.memory.appendMessage(sessionId, { role: 'assistant', content: response.content, reasoningContent: response.reasoningContent });
          const contMsg: LLMMessage = {
            role: 'user',
            content: '[Continue from where you left off. Do not repeat what you already said.]',
          };
          this.memory.appendMessage(sessionId, contMsg);
        } else {
          // Normal tool_use flow
          const currentActId = this.state.currentActivity?.id;
          if (currentActId && response.reasoningContent?.trim()) {
            this.emitActivityLog(currentActId, 'text', response.reasoningContent, { isThinking: true });
          }
          if (currentActId && response.content?.trim()) {
            this.emitActivityLog(currentActId, 'text', response.content);
          }
          this.memory.appendMessage(sessionId, {
            role: 'assistant',
            content: response.content,
            toolCalls: response.toolCalls,
            reasoningContent: response.reasoningContent,
          });

          // Execute all tool calls in parallel
          const toolResults = await Promise.all(
            response.toolCalls!.map(async tc => {
              const toolStart = Date.now();
              if (currentActId) {
                this.emitActivityLog(currentActId, 'tool_start', tc.name, { arguments: tc.arguments });
              }
              try {
                let result = await this.executeTool(tc, undefined, sessionId);
                // Manus-inspired: offload large results to filesystem instead of truncating
                // This preserves full data (agent can re-read) while keeping context lean
                result = this.offloadLargeResult(tc.name, result);
                const isToolError = isErrorResult(result);
                this.emitAudit({
                  type: 'tool_call',
                  action: tc.name,
                  durationMs: Date.now() - toolStart,
                  success: !isToolError,
                  detail: JSON.stringify(tc.arguments),
                });
                if (currentActId) {
                  this.emitActivityLog(currentActId, 'tool_end', tc.name, {
                    durationMs: Date.now() - toolStart,
                    success: !isToolError,
                    arguments: tc.arguments,
                    result,
                  });
                }
                if (options?.toolEventCollector) {
                  options.toolEventCollector.push({
                    tool: tc.name,
                    status: isToolError ? 'error' : 'done',
                    arguments: tc.arguments,
                    result,
                    durationMs: Date.now() - toolStart,
                  });
                }
                return { toolCallId: tc.id, content: result, error: false };
              } catch (toolErr) {
                // Manus principle: keep errors in context for model self-correction
                this.emitAudit({
                  type: 'tool_call',
                  action: tc.name,
                  durationMs: Date.now() - toolStart,
                  success: false,
                  detail: String(toolErr),
                });
                if (currentActId) {
                  this.emitActivityLog(currentActId, 'error', `Tool ${tc.name} failed: ${String(toolErr)}`);
                }
                if (options?.toolEventCollector) {
                  options.toolEventCollector.push({
                    tool: tc.name,
                    status: 'error',
                    arguments: tc.arguments,
                    result: String(toolErr),
                    durationMs: Date.now() - toolStart,
                  });
                }
                return { toolCallId: tc.id, content: `Error: ${String(toolErr)}`, error: true };
              }
            })
          );

          for (const tr of toolResults) {
            this.memory.appendMessage(sessionId, {
              role: 'tool',
              content: tr.content,
              toolCallId: tr.toolCallId,
            });
          }

          // Record calls for loop detection
          for (let i = 0; i < response.toolCalls!.length; i++) {
            const tc = response.toolCalls![i]!;
            this.loopDetector.record(tc.name, tc.arguments ?? {}, toolResults[i]?.content ?? '');
          }
          const loopCheck = this.loopDetector.check();
          if (loopCheck.detected) {
            const warningMsg = `[SYSTEM] Loop detected: ${loopCheck.message}. You are repeating the same actions without progress. Try a different approach or stop.`;
            this.memory.appendMessage(sessionId, { role: 'user', content: warningMsg });
            if (loopCheck.severity === 'critical') {
              log.warn('Loop detector: critical pattern — force-breaking tool loop', {
                agentId: this.id,
                pattern: loopCheck.pattern,
              });
              break;
            }
          }

          // Early preemption check after parallel tools complete — skip next
          // LLM call and reach the yield point faster when an interrupt arrived
          // during tool execution.
          if (isPreemptable && this.attentionController.hasInterruptPending()) {
            log.info('Interrupt arrived during parallel tool execution, breaking early', {
              agentId: this.id, scenario,
            });
            break;
          }
        }

        // Attention yield point — preemptable scenarios (heartbeat, memory
        // consolidation, etc.) allow full preemption; user-facing chat only
        // allows merge since the caller is awaiting a response.
        const chatYield = await this.checkAttentionYieldPoint();
        if ((chatYield.decision === 'preempt' || chatYield.decision === 'cancel') && isPreemptable) {
          const marker = chatYield.decision === 'cancel' ? '[cancelled]' : '[preempted]';
          log.info(`handleMessage ${chatYield.decision} by higher-priority item`, {
            agentId: this.id, scenario,
            preemptedBy: chatYield.item?.sourceType,
          });
          return marker;
        }
        if (chatYield.decision === 'merge' && chatYield.item) {
          const mergeMsg = `[LIVE UPDATE] ${chatYield.item.payload.summary}\n\n${chatYield.item.payload.content}`;
          this.memory.appendMessage(sessionId, { role: 'user', content: mergeMsg });
        }

        const updatedSessionMessages = this.memory.getRecentMessages(sessionId, maxHistory);
        const prepared2 = await this.contextEngine.prepareMessages({
          systemPrompt,
          sessionMessages: updatedSessionMessages,
          memory: this.memory,
          sessionId,
          agentId: this.id,
          modelContextWindow: this.llmRouter.getModelContextWindow(this.getEffectiveProvider()),
          modelMaxOutput: this.llmRouter.getModelMaxOutput(this.getEffectiveProvider()),
          toolDefinitions: llmTools,
        });
        const updatedMessages = prepared2.messages;

        const llmStart2 = Date.now();
        response = await this.withNetworkRetry(
          () => this.llmRouter.chat({
            messages: updatedMessages,
            tools: llmTools.length > 0 ? llmTools : undefined,
            metadata: this.getLLMMetadata(sessionId),
            compaction: useCompaction,
          }, this.getEffectiveProvider()),
          'Chat LLM continuation',
        );

        const tokens2 = response.usage.inputTokens + response.usage.outputTokens;
        this.updateTokensUsed(tokens2);
        this.calibrateTokenCounter(response.usage.inputTokens);
        this.emitAudit({
          type: 'llm_request',
          action: 'chat',
          tokensUsed: tokens2,
          durationMs: Date.now() - llmStart2,
          success: true,
        });
      }

      const rawReply = sanitizeLLMReply(response.content);
      const displayReply = stripCompletionMarker(rawReply);
      const outputCheck = await this.guardrails.checkOutput(displayReply, { agentId: this.id });
      if (!outputCheck.passed) {
        const filtered = `[Response filtered: ${outputCheck.reason}]`;
        this.memory.appendMessage(sessionId, { role: 'assistant', content: filtered, reasoningContent: response.reasoningContent });
        return filtered;
      }
      this.memory.appendMessage(sessionId, { role: 'assistant', content: displayReply, reasoningContent: response.reasoningContent });
      if (!isLightweight && displayReply.length > 50 && senderId) {
        this.memory.writeDailyLog(
          this.id,
          `[Chat with ${senderInfo?.name ?? senderId}] Q: ${userMessage.slice(0, 150)}... A: ${displayReply.slice(0, 300)}`
        );
      }
      if (chatActivityId && response.reasoningContent?.trim()) {
        this.emitActivityLog(chatActivityId, 'text', response.reasoningContent, { isThinking: true });
      }
      if (chatActivityId && displayReply.trim()) {
        this.emitActivityLog(chatActivityId, 'text', displayReply);
      }
      if (chatActivityId) this.endActivity(chatActivityId);
      if (this.activeTasks.size === 0) this.setStatus('idle');

      this.eventBus.emit('agent:message', {
        agentId: this.id,
        senderId,
        userMessage,
        reply: displayReply,
        tokensUsed: this.getTokensUsed(),
      });

      return rawReply;
    } catch (error) {
      if (chatActivityId) this.endActivity(chatActivityId);

      const errContent = `[Error: ${String(error).slice(0, 300)}]`;
      try {
        this.memory.appendMessage(sessionId, {
          role: 'assistant',
          content: errContent,
        });
      } catch { /* avoid masking the original error */ }

      if (this.activeTasks.size === 0) this.setStatus('error', String(error));
      this.emitAudit({
        type: 'error',
        action: 'handle_message',
        success: false,
        detail: String(error),
      });
      log.error('Failed to handle message', { error: String(error) });
      throw error;
    }
  }

  async handleMessageStream(
    userMessage: string,
    onEvent: (event: LLMStreamEvent & { agentEvent?: string }) => void,
    senderId?: string,
    senderInfo?: { name: string; role: string },
    cancelToken?: { cancelled: boolean },
    images?: string[],
    fileNames?: string[],
  ): Promise<string> {
    if (this.activeTasks.size === 0) {
      this.setStatus('working');
    }

    // Track chat activity for streaming
    let streamChatActivityId: string | undefined;
    if (!this.state.currentActivity) {
      const senderLabel = senderInfo?.name ?? senderId ?? 'user';
      streamChatActivityId = this.startActivity('chat', `Chat with ${senderLabel}`);
    }

    // Run input guardrails
    const inputCheck = await this.guardrails.checkInput(userMessage, {
      agentId: this.id,
      senderId,
    });
    if (!inputCheck.passed) {
      if (streamChatActivityId) this.endActivity(streamChatActivityId);
      return `I cannot process this request: ${inputCheck.reason}`;
    }
    const effectiveMessage = inputCheck.transformedInput ?? userMessage;

    if (!this.currentSessionId) {
      const session = this.memory.createSession(this.id);
      this.currentSessionId = session.id;
    }

    const userContent = await this.buildUserContent(userMessage, images, fileNames);
    this.memory.appendMessage(this.currentSessionId, { role: 'user', content: userContent });

    const systemPrompt = await this.contextEngine.buildSystemPrompt({
      agentId: this.id,
      agentName: this.config.name,
      role: this.role,
      orgContext: this.orgContext,
      contextMdPath: this.contextMdPath,
      memory: this.memory,
      currentQuery: effectiveMessage,
      identity: this.identityContext,
      senderIdentity: senderId && senderInfo ? { id: senderId, ...senderInfo } : undefined,
      assignedTasks: this.tasksFetcher?.(),
      deliverableContext: this.getDeliverableContext(effectiveMessage),
      environment: this.environmentProfile,
      scenario: 'chat',
      agentWorkspace: this.pathPolicy ? {
        primaryWorkspace: this.pathPolicy.primaryWorkspace,
        sharedWorkspace: this.pathPolicy.sharedWorkspace,
        builderArtifactsDir: this.pathPolicy.builderArtifactsDir,
      } : undefined,
      dynamicContext: this.getDynamicContext(),
      agentDataDir: this.dataDir,
      availableSkills: this.availableSkillCatalog,
      mailboxContext: this.getMailboxContext(),
      ...this.getTeamContextParams(),
    });

    const llmTools = this.buildToolDefinitions({ userMessage: effectiveMessage });

    const sessionMessages = this.memory.getRecentMessages(this.currentSessionId, 200);
    const preparedStream = await this.contextEngine.prepareMessages({
      systemPrompt,
      sessionMessages,
      memory: this.memory,
      sessionId: this.currentSessionId,
      agentId: this.id,
      modelContextWindow: this.llmRouter.getModelContextWindow(this.getEffectiveProvider()),
      modelMaxOutput: this.llmRouter.getModelMaxOutput(this.getEffectiveProvider()),
      toolDefinitions: llmTools,
    });
    const messages = preparedStream.messages;
    log.debug('Context usage for stream', { usagePercent: preparedStream.usage.usagePercent });

    const useCompaction = this.llmRouter.isCompactionSupported(this.getEffectiveProvider());

    // Link cancelToken to an AbortController so we can abort in-flight LLM calls
    const abortController = new AbortController();
    let cancelPollTimer: ReturnType<typeof setInterval> | undefined;
    if (cancelToken) {
      cancelPollTimer = setInterval(() => {
        if (cancelToken.cancelled && !abortController.signal.aborted) {
          abortController.abort();
        }
      }, 500);
    }

    let lastResponseContent = '';
    let thinkingBuffer = '';
    const streamMarkerDelta = createMarkerStrippingDelta((text) => {
      onEvent({ type: 'text_delta', text });
    });
    const wrappedOnEvent = (event: LLMStreamEvent & { agentEvent?: string }) => {
      if (event.type === 'thinking_delta' && event.thinking) {
        thinkingBuffer += event.thinking;
      }
      if (event.type === 'text_delta' && event.text) {
        streamMarkerDelta.emit(event.text);
        return;
      }
      onEvent(event);
    };
    try {
      this.checkDailyTokenBudget();
      const llmStart = Date.now();
      let response = await this.withNetworkRetry(
        () => this.llmRouter.chatStream(
          { messages, tools: llmTools.length > 0 ? llmTools : undefined, metadata: this.getLLMMetadata(this.currentSessionId), compaction: useCompaction },
          wrappedOnEvent,
          this.getEffectiveProvider(),
          abortController.signal,
        ),
        'Stream LLM call',
      );
      streamMarkerDelta.flush();
      const tokensThisCall = response.usage.inputTokens + response.usage.outputTokens;
      this.updateTokensUsed(tokensThisCall);
      this.calibrateTokenCounter(response.usage.inputTokens);
      lastResponseContent = response.content || '';
      this.emitAudit({
        type: 'llm_request',
        action: 'chat_stream',
        tokensUsed: tokensThisCall,
        durationMs: Date.now() - llmStart,
        success: true,
      });

      let streamToolIterations = 0;

      while (
        (response.finishReason === 'tool_use' && response.toolCalls?.length) ||
        response.finishReason === 'max_tokens'
      ) {
        if (++streamToolIterations > this._maxToolIterations) {
          log.warn('Stream tool loop hit max iterations', {
            agentId: this.id,
            iterations: streamToolIterations,
          });
          break;
        }

        if (cancelToken?.cancelled) {
          log.info('Stream cancelled by user during tool loop', { agentId: this.id });
          if (lastResponseContent && this.currentSessionId) {
            this.memory.appendMessage(this.currentSessionId, {
              role: 'assistant',
              content: lastResponseContent + '\n\n[interrupted by user]',
            });
          }
          if (streamChatActivityId) this.endActivity(streamChatActivityId);
          if (this.activeTasks.size === 0) this.setStatus('idle');
          return lastResponseContent || '';
        }

        // Handle max_tokens continuation
        if (response.finishReason === 'max_tokens' && !response.toolCalls?.length) {
          this.memory.appendMessage(this.currentSessionId, {
            role: 'assistant',
            content: response.content,
            reasoningContent: response.reasoningContent,
          });
          this.memory.appendMessage(this.currentSessionId, {
            role: 'user',
            content: '[Continue from where you left off. Do not repeat what you already said.]',
          });
        } else {
          this.memory.appendMessage(this.currentSessionId, {
            role: 'assistant',
            content: response.content,
            toolCalls: response.toolCalls,
            reasoningContent: response.reasoningContent,
          });

          // Execute all tool calls in parallel
          const subagentProgressCb: SubagentProgressCallback = (event) => {
            onEvent({
              type: 'subagent_progress',
              tool: 'spawn_subagents',
              subagentEvent: { eventType: event.type, content: event.content, metadata: event.metadata },
            });
          };
          const streamActId = streamChatActivityId ?? this.state.currentActivity?.id;
          const toolResults = await Promise.all(
            response.toolCalls!.map(async tc => {
              const toolStart = Date.now();
              onEvent({ type: 'agent_tool', tool: tc.name, phase: 'start', arguments: tc.arguments });
              if (streamActId) this.emitActivityLog(streamActId, 'tool_start', tc.name, { arguments: tc.arguments });
              const toolOutputCb: ToolOutputCallback = (chunk) => {
                onEvent({ type: 'tool_output', tool: tc.name, text: chunk });
              };
              const runTool = () => this.executeTool(tc, toolOutputCb, this.currentSessionId);
              try {
                const isSubagentTool = tc.name === 'spawn_subagent' || tc.name === 'spawn_subagents';
                let result = isSubagentTool
                  ? await chatSubagentContext.run({ subagentProgress: subagentProgressCb }, runTool)
                  : await runTool();
                result = this.offloadLargeResult(tc.name, result);
                const isToolError = isErrorResult(result);
                const durationMs = Date.now() - toolStart;
                this.emitAudit({
                  type: 'tool_call',
                  action: tc.name,
                  durationMs,
                  success: !isToolError,
                  detail: JSON.stringify(tc.arguments),
                });
                if (streamActId) this.emitActivityLog(streamActId, 'tool_end', tc.name, { arguments: tc.arguments, result, durationMs, success: !isToolError });
                onEvent({ type: 'agent_tool', tool: tc.name, phase: 'end', success: !isToolError, arguments: tc.arguments, result, durationMs });
                return { toolCallId: tc.id, content: result };
              } catch (toolErr) {
                const durationMs = Date.now() - toolStart;
                this.emitAudit({
                  type: 'tool_call',
                  action: tc.name,
                  durationMs,
                  success: false,
                  detail: String(toolErr),
                });
                if (streamActId) this.emitActivityLog(streamActId, 'tool_end', tc.name, { arguments: tc.arguments, error: String(toolErr), durationMs, success: false });
                onEvent({ type: 'agent_tool', tool: tc.name, phase: 'end', success: false, arguments: tc.arguments, error: String(toolErr), durationMs });
                return { toolCallId: tc.id, content: `Error: ${String(toolErr)}` };
              }
            })
          );

          for (const tr of toolResults) {
            this.memory.appendMessage(this.currentSessionId, {
              role: 'tool',
              content: tr.content,
              toolCallId: tr.toolCallId,
            });
          }

          for (let i = 0; i < response.toolCalls!.length; i++) {
            const tc = response.toolCalls![i]!;
            this.loopDetector.record(tc.name, tc.arguments ?? {}, toolResults[i]?.content ?? '');
          }
          const loopCheck = this.loopDetector.check();
          if (loopCheck.detected) {
            const warningMsg = `[SYSTEM] Loop detected: ${loopCheck.message}. You are repeating the same actions without progress. Try a different approach or stop.`;
            this.memory.appendMessage(this.currentSessionId, { role: 'user', content: warningMsg });
            if (loopCheck.severity === 'critical') {
              log.warn('Stream loop detector: critical pattern — force-breaking tool loop', {
                agentId: this.id, pattern: loopCheck.pattern,
              });
              break;
            }
          }
        }

        const updatedSessionMessages = this.memory.getRecentMessages(this.currentSessionId, 200);
        const preparedCont = await this.contextEngine.prepareMessages({
          systemPrompt,
          sessionMessages: updatedSessionMessages,
          memory: this.memory,
          sessionId: this.currentSessionId,
          agentId: this.id,
          modelContextWindow: this.llmRouter.getModelContextWindow(this.getEffectiveProvider()),
          modelMaxOutput: this.llmRouter.getModelMaxOutput(this.getEffectiveProvider()),
          toolDefinitions: llmTools,
        });
        const updatedMessages = preparedCont.messages;

        if (cancelToken?.cancelled) {
          log.info('Stream cancelled before LLM re-call', { agentId: this.id });
          if (lastResponseContent && this.currentSessionId) {
            this.memory.appendMessage(this.currentSessionId, {
              role: 'assistant',
              content: lastResponseContent + '\n\n[interrupted by user]',
            });
          }
          if (streamChatActivityId) this.endActivity(streamChatActivityId);
          if (this.activeTasks.size === 0) this.setStatus('idle');
          return lastResponseContent || '';
        }

        const llmStart2 = Date.now();
        response = await this.withNetworkRetry(
          () => this.llmRouter.chatStream(
            { messages: updatedMessages, tools: llmTools.length > 0 ? llmTools : undefined, metadata: this.getLLMMetadata(this.currentSessionId), compaction: useCompaction },
            wrappedOnEvent,
            this.getEffectiveProvider(),
            abortController.signal,
          ),
          'Stream LLM continuation',
        );
        streamMarkerDelta.flush();
        const tokens2 = response.usage.inputTokens + response.usage.outputTokens;
        this.updateTokensUsed(tokens2);
        this.calibrateTokenCounter(response.usage.inputTokens);
        lastResponseContent = response.content || lastResponseContent;
        this.emitAudit({
          type: 'llm_request',
          action: 'chat_stream',
          tokensUsed: tokens2,
          durationMs: Date.now() - llmStart2,
          success: true,
        });
      }

      streamMarkerDelta.flush();
      const rawReply = sanitizeLLMReply(response.content);
      const displayReply = stripCompletionMarker(rawReply);
      const outputCheck = await this.guardrails.checkOutput(displayReply, { agentId: this.id });
      if (!outputCheck.passed) {
        const filtered = `[Response filtered: ${outputCheck.reason}]`;
        this.memory.appendMessage(this.currentSessionId, { role: 'assistant', content: filtered, reasoningContent: response.reasoningContent });
        return filtered;
      }
      this.memory.appendMessage(this.currentSessionId, { role: 'assistant', content: displayReply, reasoningContent: response.reasoningContent });
      if (streamChatActivityId && thinkingBuffer.trim()) {
        this.emitActivityLog(streamChatActivityId, 'text', thinkingBuffer, { isThinking: true });
      }
      if (streamChatActivityId && displayReply.trim()) {
        this.emitActivityLog(streamChatActivityId, 'text', displayReply);
      }
      if (streamChatActivityId) this.endActivity(streamChatActivityId);
      if (this.activeTasks.size === 0) this.setStatus('idle');

      this.eventBus.emit('agent:message', {
        agentId: this.id,
        senderId,
        userMessage,
        reply: displayReply,
        tokensUsed: this.getTokensUsed(),
      });

      return rawReply;
    } catch (error) {
      streamMarkerDelta.flush();
      if (streamChatActivityId) this.endActivity(streamChatActivityId, { success: !cancelToken?.cancelled });
      if (cancelToken?.cancelled) {
        if (lastResponseContent && this.currentSessionId) {
          try {
            this.memory.appendMessage(this.currentSessionId, {
              role: 'assistant',
              content: lastResponseContent + '\n\n[interrupted by user]',
            });
          } catch { /* avoid masking */ }
        }
        if (this.activeTasks.size === 0) this.setStatus('idle');
        return lastResponseContent || '';
      }

      // Append error as assistant message so the next conversation turn has full context
      if (this.currentSessionId) {
        const errContent = lastResponseContent
          ? `${lastResponseContent}\n\n[Error: ${String(error).slice(0, 300)}]`
          : `[Error: ${String(error).slice(0, 300)}]`;
        try {
          this.memory.appendMessage(this.currentSessionId, {
            role: 'assistant',
            content: errContent,
          });
        } catch { /* avoid masking the original error */ }
      }

      if (this.activeTasks.size === 0) this.setStatus('error', String(error));
      this.emitAudit({
        type: 'error',
        action: 'handle_message_stream',
        success: false,
        detail: String(error),
      });
      log.error('Failed to handle stream message', { error: String(error) });
      throw error;
    } finally {
      if (cancelPollTimer) clearInterval(cancelPollTimer);
    }
  }

  /**
   * Execute a task concurrently (non-blocking). Multiple tasks can run simultaneously.
   * Each task gets its own isolated LLM session independent of the chat session.
   *
   * @param onLog callback receives structured log entries.
   *   persist=true entries should be saved to DB (status/text/tool_start/tool_end/error).
   *   persist=false entries are real-time text_delta chunks for live streaming only.
   */
  /**
   * 执行任务（兼容旧版本）
   */
  async executeTask(
    taskId: string,
    description: string,
    onLog: (entry: {
      seq: number;
      type: string;
      content: string;
      metadata?: unknown;
      persist: boolean;
    }) => void,
    cancelToken?: { cancelled: boolean },
    taskProjectContext?: TaskProjectContext,
    executionRound?: number,
    requirementId?: string,
  ): Promise<void> {
    return this.executeTaskConcurrent(taskId, description, onLog, cancelToken, undefined, taskProjectContext, executionRound, requirementId);
  }

  /**
   * 并发执行任务（使用TaskExecutor）
   */
  async executeTaskConcurrent(
    taskId: string,
    description: string,
    onLog: (entry: {
      seq: number;
      type: string;
      content: string;
      metadata?: unknown;
      persist: boolean;
    }) => void,
    cancelToken?: { cancelled: boolean },
    priority: TaskPriority = TaskPriority.MEDIUM,
    taskProjectContext?: TaskProjectContext,
    executionRound?: number,
    requirementId?: string,
  ): Promise<void> {
    if (!this.taskExecutor) {
      throw new Error('Task executor not initialized');
    }

    // 使用TaskExecutor执行任务
    // Wrap in AsyncLocalStorage context so concurrent task executions each
    // resolve their own taskId (prevents deliverable cross-contamination).
    const result = await this.taskExecutor.executeTaskTask(
      taskId,
      () => taskAsyncContext.run({ taskId, requirementId }, () =>
        this._executeTaskInternal(taskId, description, onLog, cancelToken, taskProjectContext, executionRound)
      ),
      {
        priority,
        onProgress: (progress: number, currentStep?: string) => {
          // 发送进度更新
          onLog({
            seq: -1,
            type: 'progress',
            content: JSON.stringify({ progress, currentStep }),
            persist: false,
          });
        },
        cancelToken,
      }
    );

    // 处理执行结果
    if (result.status === TaskStatus.FAILED && result.error) {
      throw result.error;
    }
  }

  /**
   * 内部任务执行逻辑（原executeTask的核心逻辑）
   */
  private async _executeTaskInternal(
    taskId: string,
    description: string,
    onLog: (entry: {
      seq: number;
      type: string;
      content: string;
      metadata?: unknown;
      persist: boolean;
    }) => void,
    cancelToken?: { cancelled: boolean },
    taskProjectContext?: TaskProjectContext,
    executionRound?: number
  ): Promise<void> {
    this.currentTaskId = taskId;
    if (
      this.config.profile?.maxConcurrentTasks !== undefined &&
      this.config.profile.maxConcurrentTasks !== null &&
      this.activeTasks.size >= this.config.profile.maxConcurrentTasks
    ) {
      throw new Error(
        `Agent has reached maximum concurrent tasks (${this.config.profile.maxConcurrentTasks})`
      );
    }
    this.setStatus('working');
    this.activeTasks.add(taskId);
    const execGen = (this.activeTaskGen.get(taskId) ?? 0) + 1;
    this.activeTaskGen.set(taskId, execGen);
    const taskActLabel = this.extractTaskLabel(description, taskId);
    const taskActId = this.startActivity('task', taskActLabel, { taskId });
    this.notifyStateChange();
    const taskStartMs = Date.now();
    let taskFailed = '';

    let seq = 0;
    const emit = (type: string, content: string, metadata?: unknown) => {
      onLog({ seq: seq++, type, content, metadata, persist: true });
    };
    const rawEmitDelta = (text: string) => {
      onLog({ seq: -1, type: 'text_delta', content: text, persist: false });
    };
    const markerDelta = createMarkerStrippingDelta(rawEmitDelta);
    const emitDelta = markerDelta.emit;

    // Wire subagent progress events into task execution logs so the frontend
    // can render subagent steps (tool calls, thinking, completion) in real-time.
    const subagentProgress: SubagentProgressCallback = (event) => {
      const prefix = event.type === 'started' || event.type === 'completed' || event.type === 'error'
        ? `subagent_${event.type}` : `subagent_${event.type}`;
      emit(prefix, event.content, event.metadata);
    };
    const alsStore = taskAsyncContext.getStore();
    if (alsStore) {
      alsStore.subagentProgress = subagentProgress;
    }

    emit('status', 'started', { agentId: this.id, agentName: this.config.name });

    if (taskProjectContext) {
      log.info('Task execution with project context', {
        taskId, agentId: this.id,
        repos: taskProjectContext.repositories.map(r => r.localPath),
      });
    }

    // AbortController linked to cancelToken so we can abort in-flight LLM calls
    const abortController = new AbortController();
    let cancelPollTimer: ReturnType<typeof setInterval> | undefined;
    if (cancelToken) {
      cancelPollTimer = setInterval(() => {
        if (cancelToken.cancelled && !abortController.signal.aborted) {
          abortController.abort();
        }
      }, 500);
    }

    // Deterministic session ID per task+round. Retries within the same execution
    // round reuse the existing message history (tool calls, file contents, etc.)
    // so the agent doesn't have to re-read files or redo work.
    // New rounds (scheduled reruns, review rejections) get a fresh session.
    const round = executionRound ?? 1;
    const sessionId = `task_${taskId}_r${round}`;
    const session = this.memory.getOrCreateSession(this.id, sessionId);
    const isRetryWithHistory = session.messages.length > 0;

    const isResume = description.includes('## Previous Execution Context') ||
      description.includes('## ⚠ RETRY');
    const hasErrors = description.includes('⚠ Error Guidance') ||
      description.includes('⚠ Errors from Previous Attempts');
    const taskPrompt = [
      `[TASK EXECUTION — Task ID: ${taskId}]`,
      '',
      description,
      '',
      isResume
        ? [
            'Review the previous execution history above, then continue and complete the remaining work. Skip steps already marked as completed (✓).',
            '**IMPORTANT — Dependency check:** If this task has a "Dependency Tasks" section, you MUST review all dependency task outputs before continuing. Use `file_read` to inspect any deliverable files listed, and use `task_get` to retrieve full details. These outputs provide essential background knowledge that your work should build upon.',
            '**IMPORTANT — Check existing knowledge:** Before diving in, check the "Your Knowledge" section in your system context above. Follow any procedures or insights that match this type of task.',
            ...(hasErrors ? [
              '',
              '⚠ CRITICAL — LEARN FROM PREVIOUS FAILURES:',
              'This task has ALREADY FAILED in previous attempts. The "Errors from Previous Attempts" section above describes exactly what went wrong.',
              'You MUST read and understand those errors BEFORE starting any work.',
              'Do NOT repeat the same approach that caused those failures — use a DIFFERENT strategy.',
              'If the errors were caused by generating content that was too large, split your work into multiple smaller steps.',
              'If the errors were caused by malformed output, simplify your output format and validate before submitting.',
            ] : []),
          ].join('\n')
        : [
            'Execute this task completely using your available tools. When done, provide a concise summary of what was accomplished.',
            '',
            '**IMPORTANT — Dependency check:** If this task has a "Dependency Tasks" section above, you MUST review all dependency task outputs BEFORE starting your own work. Use `file_read` to inspect any deliverable files listed, and use `task_get` to retrieve full details of each dependency task. These dependency outputs provide essential background knowledge and artifacts that your work should build upon.',
            '**IMPORTANT — Check existing knowledge:** Before diving in, check the "Your Knowledge" section in your system context above. Follow any procedures or insights that match this type of task.',
          ].join('\n'),
      '',
      '## Completion Requirements — MANDATORY',
      '**You MUST call `task_submit_review` when your work is done.** This is the ONLY way to complete a task execution round.',
      'The task will NOT be considered complete and will NOT enter review unless you call `task_submit_review`.',
      '',
      'When calling `task_submit_review`, provide:',
      '- `summary`: A clear description of what was accomplished, key decisions, and results',
      '- `deliverables`: List ALL artifacts produced — each with `type` (file/directory), `reference` (file or directory path), and `summary`',
      '- `known_issues` (optional): Any limitations or follow-up items',
      '',
      'The system auto-fills task_id, reviewer, and branch — you do NOT need to specify these.',
      'Before calling `task_submit_review`, use `task_note` to record detailed progress notes for traceability.',
    ].join('\n');

    // Check if session has meaningful work from a previous attempt
    const hasAssistantWork = isRetryWithHistory &&
      session.messages.some(m => m.role === 'assistant' || m.role === 'tool');

    if (hasAssistantWork) {
      // On retry with previous work: the session already has the full conversation
      // (tool calls, file contents, results). Append a continuation message so
      // the LLM picks up where it left off without redoing work.
      this.memory.appendMessage(sessionId, {
        role: 'user',
        content: [
          '[SYSTEM: Your previous execution attempt was interrupted by a transient error (e.g. network timeout).',
          'The conversation history above contains ALL your prior work — tool calls, file reads, and results are preserved.',
          'CONTINUE from where you left off. Do NOT re-read files or redo completed steps.',
          'Pick up exactly at the point where the error occurred and finish the task.]',
        ].join('\n'),
      });
    } else {
      this.memory.appendMessage(sessionId, { role: 'user', content: taskPrompt });
    }

    const systemPrompt = await this.contextEngine.buildSystemPrompt({
      agentId: this.id,
      agentName: this.config.name,
      role: this.role,
      orgContext: this.orgContext,
      contextMdPath: this.contextMdPath,
      memory: this.memory,
      currentQuery: taskPrompt,
      identity: this.identityContext,
      assignedTasks: this.tasksFetcher?.(),
      deliverableContext: this.getDeliverableContext(taskPrompt),
      environment: this.environmentProfile,
      scenario: 'task_execution',
      ...(taskProjectContext ? { projectContext: taskProjectContext } : {}),
      agentWorkspace: this.pathPolicy ? {
        primaryWorkspace: this.pathPolicy.primaryWorkspace,
        sharedWorkspace: this.pathPolicy.sharedWorkspace,
        builderArtifactsDir: this.pathPolicy.builderArtifactsDir,
      } : undefined,
      dynamicContext: this.getDynamicContext(),
      agentDataDir: this.dataDir,
      availableSkills: this.availableSkillCatalog,
      mailboxContext: this.getMailboxContext(),
      ...this.getTeamContextParams(),
    });

    const llmTools = this.buildToolDefinitions({ userMessage: taskPrompt, isTaskExecution: true });
    const useCompaction = this.llmRouter.isCompactionSupported(this.getEffectiveProvider());
    let textBuffer = '';
    let thinkingBuffer = '';
    let taskToolIterations = 0;

    const flushThinking = () => {
      if (thinkingBuffer.trim()) {
        emit('text', thinkingBuffer, { isThinking: true });
        thinkingBuffer = '';
      }
    };
    const flushText = () => {
      markerDelta.flush();
      flushThinking();
      if (textBuffer.trim()) {
        emit('text', textBuffer);
        textBuffer = '';
      }
    };
    const handleStreamEvent = (event: { type: string; text?: string; thinking?: string }) => {
      if (event.type === 'thinking_delta' && event.thinking) {
        thinkingBuffer += event.thinking;
      }
      if (event.type === 'text_delta' && event.text) {
        textBuffer += event.text;
        emitDelta(event.text);
      }
    };

    try {
      if (cancelToken?.cancelled) {
        emit('status', 'cancelled', { reason: 'Task execution was stopped externally' });
        return;
      }

      const preparedTask = await this.contextEngine.prepareMessages({
        systemPrompt,
        sessionMessages: this.memory.getRecentMessages(sessionId, 200),
        memory: this.memory,
        sessionId,
        agentId: this.id,
        modelContextWindow: this.llmRouter.getModelContextWindow(this.getEffectiveProvider()),
        modelMaxOutput: this.llmRouter.getModelMaxOutput(this.getEffectiveProvider()),
        toolDefinitions: llmTools,
      });
      const messages = preparedTask.messages;
      log.debug('Context usage for task execution', { taskId, usagePercent: preparedTask.usage.usagePercent, totalUsed: preparedTask.usage.totalUsed });

      let taskLlmStart = Date.now();
      let response = await this.withNetworkRetry(
        () => this.llmRouter.chatStream(
          { messages, tools: llmTools.length > 0 ? llmTools : undefined, metadata: this.getLLMMetadata(sessionId), compaction: useCompaction },
          handleStreamEvent,
          this.getEffectiveProvider(),
          abortController.signal,
        ),
        'Task execution LLM call',
      );
      let taskLlmTokens = response.usage.inputTokens + response.usage.outputTokens;
      this.updateTokensUsed(taskLlmTokens);
      this.calibrateTokenCounter(response.usage.inputTokens);
      this.emitAudit({ type: 'llm_request', action: 'task_execution', tokensUsed: taskLlmTokens, durationMs: Date.now() - taskLlmStart, success: true });

      while (
        (response.finishReason === 'tool_use' && response.toolCalls?.length) ||
        response.finishReason === 'max_tokens'
      ) {
        taskToolIterations++;
        if (cancelToken?.cancelled) {
          flushText();
          emit('status', 'cancelled', { reason: 'Task execution was stopped externally' });
          log.info('Task execution cancelled externally', { taskId, agentId: this.id });
          return;
        }

        flushText();

        if (response.finishReason === 'max_tokens' && !response.toolCalls?.length) {
          this.memory.appendMessage(sessionId, { role: 'assistant', content: response.content, reasoningContent: response.reasoningContent });
          this.memory.appendMessage(sessionId, {
            role: 'user',
            content: '[Continue from where you left off. Do not repeat what you already said.]',
          });
        } else {
          this.memory.appendMessage(sessionId, {
            role: 'assistant',
            content: response.content,
            toolCalls: response.toolCalls,
            reasoningContent: response.reasoningContent,
          });

          let interruptedDuringTools = false;
          for (const tc of response.toolCalls!) {
            if (cancelToken?.cancelled) break;
            if (this.attentionController.hasInterruptPending()) {
              log.info('Attention interrupt pending — skipping remaining tools', {
                agentId: this.id, taskId, skippedTool: tc.name,
              });
              this.memory.appendMessage(sessionId, {
                role: 'tool',
                content: '[Tool skipped — preempted by higher-priority item]',
                toolCallId: tc.id,
              });
              interruptedDuringTools = true;
              continue;
            }
            emit('tool_start', tc.name, { arguments: tc.arguments });
            const toolStart = Date.now();
            try {
              const preemptionRace = this.attentionController.waitForPreemptionSignal();
              const toolResult = this.executeTool(tc, undefined, sessionId);
              const raceResult = await Promise.race([
                toolResult.then(r => ({ source: 'tool' as const, value: r })),
                preemptionRace.then(() => ({ source: 'preempt' as const, value: undefined })),
              ]);
              this.attentionController.clearPreemptionSignal();

              let result: string;
              if (raceResult.source === 'preempt') {
                log.info('Tool execution preempted by critical interrupt', {
                  agentId: this.id, taskId, tool: tc.name,
                  elapsedMs: Date.now() - toolStart,
                });
                result = await toolResult;
                result = this.offloadLargeResult(tc.name, result);
                interruptedDuringTools = true;
              } else {
                result = raceResult.value as string;
                result = this.offloadLargeResult(tc.name, result);
              }

              const isErr = isErrorResult(result);
              const durationMs = Date.now() - toolStart;
              emit('tool_end', tc.name, {
                success: !isErr,
                durationMs,
                arguments: tc.arguments,
                result,
              });
              this.emitAudit({ type: 'tool_call', action: tc.name, durationMs, success: !isErr });
              this.memory.appendMessage(sessionId, {
                role: 'tool',
                content: result,
                toolCallId: tc.id,
              });
              if (interruptedDuringTools) break;
            } catch (toolErr) {
              this.attentionController.clearPreemptionSignal();
              const durationMs = Date.now() - toolStart;
              emit('tool_end', tc.name, { success: false, durationMs, arguments: tc.arguments, error: String(toolErr) });
              this.emitAudit({ type: 'tool_call', action: tc.name, durationMs, success: false });
              this.memory.appendMessage(sessionId, {
                role: 'tool',
                content: `Error: ${String(toolErr)}`,
                toolCallId: tc.id,
              });
            }
          }

          if (interruptedDuringTools) {
            for (const tc of response.toolCalls!) {
              const hasResult = this.memory.getRecentMessages(sessionId, 100)
                .some(m => m.role === 'tool' && m.toolCallId === tc.id);
              if (!hasResult) {
                this.memory.appendMessage(sessionId, {
                  role: 'tool',
                  content: '[Tool skipped — preempted by higher-priority item]',
                  toolCallId: tc.id,
                });
              }
            }
          }
        }

        if (cancelToken?.cancelled) {
          emit('status', 'cancelled', { reason: 'Task execution was stopped externally' });
          log.info('Task execution cancelled externally after tools', { taskId, agentId: this.id });
          return;
        }

        // Flush buffered live comments now that all tool results are safely appended.
        this.flushPendingInjections(sessionId);

        // ── Attention yield point ──────────────────────────────────────
        // Between LLM turns is a safe point to check for higher-priority
        // mailbox items. All tool results are saved to the session, so we
        // can pause and resume without data loss.
        const yieldResult = await this.checkAttentionYieldPoint();
        if (yieldResult.decision === 'preempt' || yieldResult.decision === 'cancel') {
          const statusLabel = yieldResult.decision === 'cancel' ? 'cancelled' : 'preempted';
          emit('status', statusLabel, {
            reason: yieldResult.reasoning,
            preemptedBy: yieldResult.item?.sourceType,
          });
          log.info(`Task ${statusLabel} by higher-priority mailbox item`, {
            taskId,
            agentId: this.id,
            decision: yieldResult.decision,
            preemptedBy: yieldResult.item?.sourceType,
            reasoning: yieldResult.reasoning?.slice(0, 120),
          });
          return;
        }
        if (yieldResult.decision === 'merge' && yieldResult.item) {
          this.memory.appendMessage(sessionId, {
            role: 'user',
            content: `[LIVE UPDATE] ${yieldResult.item.payload.summary}\n\n${yieldResult.item.payload.content}`,
          });
          log.debug('Merged mailbox item into active task session', {
            taskId,
            mergedType: yieldResult.item.sourceType,
          });
        }

        // Re-inject critical task completion reminder every 10 tool iterations
        // to prevent "lost in the middle" — the original task_submit_review
        // instruction drifts away from recent context as tool calls accumulate.
        if (taskToolIterations > 0 && taskToolIterations % 10 === 0) {
          this.memory.appendMessage(sessionId, {
            role: 'user',
            content: [
              `[SYSTEM REMINDER — Task ${taskId}]`,
              'You have completed multiple tool call rounds. Remember:',
              '- When ALL your work is done, you MUST call `task_submit_review` with summary and deliverables.',
              '- If you are stuck or blocked, update the task status to `blocked` with an explanation.',
              '- Do NOT just stop — the task is NOT complete until you call `task_submit_review`.',
              '- Use `task_note` to record progress before submitting.',
            ].join('\n'),
          });
          log.debug('Injected task completion reminder', { taskId, iteration: taskToolIterations });
        }

        // Mid-execution reflection nudge every 30 tool iterations.
        // Forces the agent to pause and capture insights while context is fresh.
        if (taskToolIterations > 0 && taskToolIterations % 30 === 0) {
          this.memory.appendMessage(sessionId, {
            role: 'user',
            content: [
              '[REFLECTION CHECKPOINT]',
              `You have completed ${taskToolIterations} tool call rounds on this task.`,
              'Before continuing, briefly consider:',
              '- Have you encountered any surprising errors or workarounds worth remembering?',
              '- Have you discovered a better tool or approach mid-task?',
              'If yes, save it now using `memory_save` with tags: `["insight", ...]`.',
              'Then continue with the task.',
            ].join('\n'),
          });
          log.debug('Injected mid-execution reflection nudge', { taskId, iteration: taskToolIterations });
        }

        const preparedTaskCont = await this.contextEngine.prepareMessages({
          systemPrompt,
          sessionMessages: this.memory.getRecentMessages(sessionId, 200),
          memory: this.memory,
          sessionId,
          agentId: this.id,
          modelContextWindow: this.llmRouter.getModelContextWindow(this.getEffectiveProvider()),
          modelMaxOutput: this.llmRouter.getModelMaxOutput(this.getEffectiveProvider()),
          toolDefinitions: llmTools,
        });
        taskLlmStart = Date.now();
        response = await this.withNetworkRetry(
          () => this.llmRouter.chatStream(
            {
              messages: preparedTaskCont.messages,
              tools: llmTools.length > 0 ? llmTools : undefined,
              metadata: this.getLLMMetadata(sessionId),
              compaction: useCompaction,
            },
            handleStreamEvent,
            this.getEffectiveProvider(),
            abortController.signal,
          ),
          'Task execution LLM continuation',
        );
        taskLlmTokens = response.usage.inputTokens + response.usage.outputTokens;
        this.updateTokensUsed(taskLlmTokens);
        this.calibrateTokenCounter(response.usage.inputTokens);
        this.emitAudit({ type: 'llm_request', action: 'task_execution', tokensUsed: taskLlmTokens, durationMs: Date.now() - taskLlmStart, success: true });
      }

      // Final cancel check after the tool loop exits
      if (cancelToken?.cancelled) {
        flushText();
        emit('status', 'cancelled', { reason: 'Task execution was stopped externally' });
        log.info('Task execution cancelled externally after completion', { taskId, agentId: this.id });
        return;
      }

      // Last-chance check: did the agent call task_submit_review?
      // Scan session messages for a tool call to task_submit_review.
      const sessionMsgs = this.memory.getRecentMessages(sessionId, 500);
      const didSubmitReview = sessionMsgs.some(
        m => m.role === 'assistant' && m.toolCalls?.some(tc => tc.name === 'task_submit_review')
      );
      if (!didSubmitReview && !cancelToken?.cancelled) {
        log.warn('Task execution ending without task_submit_review — injecting final reminder', { taskId, agentId: this.id });
        flushText();
        this.memory.appendMessage(sessionId, { role: 'assistant', content: response.content, reasoningContent: response.reasoningContent });
        this.memory.appendMessage(sessionId, {
          role: 'user',
          content: [
            `[SYSTEM — CRITICAL REMINDER — Task ${taskId}]`,
            'You are about to finish without calling `task_submit_review`. This is MANDATORY.',
            'The task will NOT enter review and will be automatically retried if you do not submit.',
            '',
            'Call `task_submit_review` NOW with:',
            '- `summary`: What you accomplished',
            '- `deliverables`: List of files/directories you produced',
            '',
            'If you were unable to complete the task, call `task_update` with status "blocked" or "failed" and a note explaining why.',
            'Do NOT just stop — take action NOW.',
          ].join('\n'),
        });

        const preparedFinal = await this.contextEngine.prepareMessages({
          systemPrompt,
          sessionMessages: this.memory.getRecentMessages(sessionId, 200),
          memory: this.memory,
          sessionId,
          agentId: this.id,
          modelContextWindow: this.llmRouter.getModelContextWindow(this.getEffectiveProvider()),
          modelMaxOutput: this.llmRouter.getModelMaxOutput(this.getEffectiveProvider()),
          toolDefinitions: llmTools,
        });
        taskLlmStart = Date.now();
        response = await this.withNetworkRetry(
          () => this.llmRouter.chatStream(
            {
              messages: preparedFinal.messages,
              tools: llmTools.length > 0 ? llmTools : undefined,
              metadata: this.getLLMMetadata(sessionId),
              compaction: useCompaction,
            },
            handleStreamEvent,
            this.getEffectiveProvider(),
            abortController.signal,
          ),
          'Task execution final submit reminder',
        );
        taskLlmTokens = response.usage.inputTokens + response.usage.outputTokens;
        this.updateTokensUsed(taskLlmTokens);
        this.calibrateTokenCounter(response.usage.inputTokens);

        // Process any tool calls from the final reminder turn
        if (response.toolCalls?.length) {
          this.memory.appendMessage(sessionId, {
            role: 'assistant',
            content: response.content,
            toolCalls: response.toolCalls,
            reasoningContent: response.reasoningContent,
          });
          for (const tc of response.toolCalls) {
            if (cancelToken?.cancelled) break;
            if (this.attentionController.hasInterruptPending()) {
              this.memory.appendMessage(sessionId, {
                role: 'tool',
                content: '[Tool skipped — preempted by higher-priority item]',
                toolCallId: tc.id,
              });
              continue;
            }
            emit('tool_start', tc.name, { arguments: tc.arguments });
            const toolStart = Date.now();
            try {
              let result = await this.executeTool(tc, undefined, sessionId);
              result = this.offloadLargeResult(tc.name, result);
              const isErr = isErrorResult(result);
              const durationMs = Date.now() - toolStart;
              emit('tool_end', tc.name, { success: !isErr, durationMs, arguments: tc.arguments, result });
              this.memory.appendMessage(sessionId, { role: 'tool', content: result, toolCallId: tc.id });
            } catch (toolErr) {
              const durationMs = Date.now() - toolStart;
              emit('tool_end', tc.name, { success: false, durationMs, arguments: tc.arguments, error: String(toolErr) });
              this.memory.appendMessage(sessionId, { role: 'tool', content: `Error: ${String(toolErr)}`, toolCallId: tc.id });
            }
          }
          // After processing tool calls, only append if there's non-tool-call text
          flushText();
        } else {
          flushText();
          const finalReply = stripCompletionMarker(sanitizeLLMReply(response.content));
          this.memory.appendMessage(sessionId, { role: 'assistant', content: finalReply, reasoningContent: response.reasoningContent });
        }
      } else {
        flushText();
        const finalReply = stripCompletionMarker(sanitizeLLMReply(response.content));
        this.memory.appendMessage(sessionId, { role: 'assistant', content: finalReply, reasoningContent: response.reasoningContent });
      }

      emit('status', 'execution_finished', {});
      this.metricsCollector.recordTaskCompletion(taskId, 'completed', Date.now() - taskStartMs);
      this.eventBus.emit('task:completed', { taskId, agentId: this.id });
      log.info('Task execution finished', { taskId, agentId: this.id });
    } catch (error) {
      // If abort was triggered by cancel, treat as cancellation not error
      if (cancelToken?.cancelled) {
        flushText();
        emit('status', 'cancelled', { reason: 'Task execution was stopped externally' });
        log.info('Task execution cancelled (caught abort)', { taskId, agentId: this.id });
        return;
      }
      // Save any partial assistant text to the session so retries have full context
      if (textBuffer.trim()) {
        this.memory.appendMessage(sessionId, {
          role: 'assistant',
          content: textBuffer + '\n\n[interrupted by error]',
        });
      }
      flushText();
      emit('error', String(error));
      this.metricsCollector.recordTaskCompletion(taskId, 'failed', Date.now() - taskStartMs);
      this.emitAudit({
        type: 'error',
        action: 'execute_task',
        success: false,
        detail: String(error),
      });
      log.error('Task execution failed', { taskId, agentId: this.id, error: String(error) });
      this.eventBus.emit('task:failed', { taskId, agentId: this.id, error: String(error) });
      taskFailed = String(error);
      throw error;
    } finally {
      if (cancelPollTimer) clearInterval(cancelPollTimer);

      // Task workspace tools are now task-local (stored in AsyncLocalStorage) and
      // automatically discarded when the async context ends — no restore needed.

      // Only remove from activeTasks if this execution is still the latest one.
      // A newer execution for the same taskId bumps the generation counter;
      // stale finally blocks must not clear it.
      if (this.activeTaskGen.get(taskId) === execGen) {
        this.activeTasks.delete(taskId);
        this.activeTaskGen.delete(taskId);
        this.pendingInjections.delete(sessionId);
      }
      this.endActivity(taskActId);
      this.notifyStateChange();

      if (this.activeTasks.size === 0) {
        if (taskFailed) {
          this.setStatus('error', taskFailed);
        } else {
          this.setStatus('idle');
        }
      }
    }
  }

  /**
   * Continue an existing session with a new user message, using streamed
   * LLM calls and the same onLog callback as task execution. This gives
   * callers full visibility (text deltas, tool_start/tool_end events)
   * without the task lifecycle overhead (no task_submit_review requirement,
   * no activeTasks tracking, no workspace setup).
   *
   * Intended for post-task discussions where the agent should respond
   * with full context and tools, and the process should be observable.
   */
  async respondInSession(
    sessionId: string,
    userMessage: string,
    onLog: (entry: {
      seq: number;
      type: string;
      content: string;
      metadata?: unknown;
      persist: boolean;
    }) => void,
  ): Promise<string> {
    this.setStatus('working');
    const risLabel = userMessage.replace(/^[\s#*[\]]+/g, '').slice(0, 80) || 'Session response';
    const actId = this.startActivity('respond_in_session', risLabel);

    let seq = 0;
    const emit = (type: string, content: string, metadata?: unknown) => {
      onLog({ seq: seq++, type, content, metadata, persist: true });
    };
    const rawEmitDeltaRIS = (text: string) => {
      onLog({ seq: -1, type: 'text_delta', content: text, persist: false });
    };
    const markerDeltaRIS = createMarkerStrippingDelta(rawEmitDeltaRIS);
    const emitDelta = markerDeltaRIS.emit;

    this.memory.getOrCreateSession(this.id, sessionId);
    this.memory.appendMessage(sessionId, { role: 'user', content: userMessage });

    const systemPrompt = await this.contextEngine.buildSystemPrompt({
      agentId: this.id,
      agentName: this.config.name,
      role: this.role,
      orgContext: this.orgContext,
      contextMdPath: this.contextMdPath,
      memory: this.memory,
      currentQuery: userMessage,
      identity: this.identityContext,
      assignedTasks: this.tasksFetcher?.(),
      deliverableContext: this.getDeliverableContext(userMessage),
      environment: this.environmentProfile,
      scenario: 'chat',
      agentWorkspace: this.pathPolicy ? {
        primaryWorkspace: this.pathPolicy.primaryWorkspace,
        sharedWorkspace: this.pathPolicy.sharedWorkspace,
        builderArtifactsDir: this.pathPolicy.builderArtifactsDir,
      } : undefined,
      dynamicContext: this.getDynamicContext(),
      agentDataDir: this.dataDir,
      availableSkills: this.availableSkillCatalog,
      mailboxContext: this.getMailboxContext(),
      ...this.getTeamContextParams(),
    });

    const llmTools = this.buildToolDefinitions({ userMessage });
    const useCompaction = this.llmRouter.isCompactionSupported(this.getEffectiveProvider());
    let textBuffer = '';
    let thinkingBuffer = '';
    const flushThinking = () => {
      if (thinkingBuffer.trim()) {
        emit('text', thinkingBuffer, { isThinking: true });
        thinkingBuffer = '';
      }
    };
    const flushText = () => {
      markerDeltaRIS.flush();
      flushThinking();
      if (textBuffer.trim()) {
        emit('text', textBuffer);
        textBuffer = '';
      }
    };
    const handleStreamEvent = (event: { type: string; text?: string; thinking?: string }) => {
      if (event.type === 'thinking_delta' && event.thinking) {
        thinkingBuffer += event.thinking;
      }
      if (event.type === 'text_delta' && event.text) {
        textBuffer += event.text;
        emitDelta(event.text);
      }
    };

    try {
      const prepared = await this.contextEngine.prepareMessages({
        systemPrompt,
        sessionMessages: this.memory.getRecentMessages(sessionId, 200),
        memory: this.memory,
        sessionId,
        agentId: this.id,
        modelContextWindow: this.llmRouter.getModelContextWindow(this.getEffectiveProvider()),
        modelMaxOutput: this.llmRouter.getModelMaxOutput(this.getEffectiveProvider()),
        toolDefinitions: llmTools,
      });
      const messages = prepared.messages;

      let risLlmStart = Date.now();
      let response = await this.withNetworkRetry(
        () => this.llmRouter.chatStream(
          { messages, tools: llmTools.length > 0 ? llmTools : undefined, metadata: this.getLLMMetadata(sessionId), compaction: useCompaction },
          handleStreamEvent,
          this.getEffectiveProvider(),
        ),
        'RespondInSession LLM call',
      );
      let risTokens = response.usage.inputTokens + response.usage.outputTokens;
      this.updateTokensUsed(risTokens);
      this.calibrateTokenCounter(response.usage.inputTokens);
      this.emitAudit({ type: 'llm_request', action: 'respond_in_session', tokensUsed: risTokens, durationMs: Date.now() - risLlmStart, success: true });

      let toolIter = 0;
      while (
        (response.finishReason === 'tool_use' && response.toolCalls?.length) ||
        response.finishReason === 'max_tokens'
      ) {
        if (++toolIter > 200) break;
        flushText();

        if (response.finishReason === 'max_tokens' && !response.toolCalls?.length) {
          this.memory.appendMessage(sessionId, { role: 'assistant', content: response.content, reasoningContent: response.reasoningContent });
          this.memory.appendMessage(sessionId, {
            role: 'user',
            content: '[Continue from where you left off. Do not repeat what you already said.]',
          });
        } else {
          this.memory.appendMessage(sessionId, {
            role: 'assistant',
            content: response.content,
            toolCalls: response.toolCalls,
            reasoningContent: response.reasoningContent,
          });

          for (const tc of response.toolCalls!) {
            if (this.attentionController.hasInterruptPending()) {
              this.memory.appendMessage(sessionId, {
                role: 'tool',
                content: '[Tool skipped — preempted by higher-priority item]',
                toolCallId: tc.id,
              });
              continue;
            }
            emit('tool_start', tc.name, { arguments: tc.arguments });
            const toolStart = Date.now();
            try {
              let result = await this.executeTool(tc, undefined, sessionId);
              result = this.offloadLargeResult(tc.name, result);
              const isErr = isErrorResult(result);
              const durationMs = Date.now() - toolStart;
              emit('tool_end', tc.name, { success: !isErr, durationMs, arguments: tc.arguments, result });
              this.emitAudit({ type: 'tool_call', action: tc.name, durationMs, success: !isErr });
              this.memory.appendMessage(sessionId, { role: 'tool', content: result, toolCallId: tc.id });
            } catch (toolErr) {
              const durationMs = Date.now() - toolStart;
              emit('tool_end', tc.name, { success: false, durationMs, arguments: tc.arguments, error: String(toolErr) });
              this.emitAudit({ type: 'tool_call', action: tc.name, durationMs, success: false });
              this.memory.appendMessage(sessionId, { role: 'tool', content: `Error: ${String(toolErr)}`, toolCallId: tc.id });
            }
          }
        }

        const preparedCont = await this.contextEngine.prepareMessages({
          systemPrompt,
          sessionMessages: this.memory.getRecentMessages(sessionId, 200),
          memory: this.memory,
          sessionId,
          agentId: this.id,
          modelContextWindow: this.llmRouter.getModelContextWindow(this.getEffectiveProvider()),
          modelMaxOutput: this.llmRouter.getModelMaxOutput(this.getEffectiveProvider()),
          toolDefinitions: llmTools,
        });
        risLlmStart = Date.now();
        response = await this.withNetworkRetry(
          () => this.llmRouter.chatStream(
            { messages: preparedCont.messages, tools: llmTools.length > 0 ? llmTools : undefined, metadata: this.getLLMMetadata(sessionId), compaction: useCompaction },
            handleStreamEvent,
            this.getEffectiveProvider(),
          ),
          'RespondInSession LLM continuation',
        );
        risTokens = response.usage.inputTokens + response.usage.outputTokens;
        this.updateTokensUsed(risTokens);
        this.calibrateTokenCounter(response.usage.inputTokens);
        this.emitAudit({ type: 'llm_request', action: 'respond_in_session', tokensUsed: risTokens, durationMs: Date.now() - risLlmStart, success: true });
      }

      flushText();
      const rawReply = sanitizeLLMReply(response.content);
      const displayReply = stripCompletionMarker(rawReply);
      this.memory.appendMessage(sessionId, { role: 'assistant', content: displayReply, reasoningContent: response.reasoningContent });
      return rawReply;
    } catch (error) {
      if (textBuffer.trim()) {
        this.memory.appendMessage(sessionId, { role: 'assistant', content: textBuffer + '\n\n[interrupted by error]' });
      }
      flushText();
      emit('error', String(error));
      throw error;
    } finally {
      this.endActivity(actId);
      if (this.activeTasks.size === 0) this.setStatus('idle');
    }
  }

  private skillProficiency = new Map<
    string,
    { uses: number; successes: number; lastUsed: string }
  >();

  getSkillProficiency(): Record<string, { uses: number; successes: number; lastUsed: string }> {
    return Object.fromEntries(this.skillProficiency);
  }

  recordToolUsage(toolName: string, success: boolean): void {
    const existing = this.skillProficiency.get(toolName) ?? { uses: 0, successes: 0, lastUsed: '' };
    existing.uses += 1;
    if (success) existing.successes += 1;
    existing.lastUsed = new Date().toISOString();
    this.skillProficiency.set(toolName, existing);
  }

  addMemory(content: string, type: 'fact' | 'note' = 'fact'): void {
    this.memory.addEntry({
      id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      type,
      content,
    });
  }

  registerTool(handler: AgentToolHandler): void {
    this.tools.set(handler.name, handler);
  }

  registerBackgroundSession(bgSessionId: string, originSessionId: string): void {
    this.bgSessionOrigin.set(bgSessionId, originSessionId);
  }

  getTools(): Map<string, AgentToolHandler> {
    return this.tools;
  }

  /**
   * Mark tool names as permanently activated so they appear in every LLM call.
   * Used by skill MCP integration to ensure skill-provided tools are always visible.
   */
  activateTools(names: string[]): void {
    for (const name of names) {
      this.activatedExtraTools.add(name);
    }
  }


  getState(): AgentState {
    const state = { ...this.state };
    if (state.status === 'error' && !state.lastError) {
      const lastErr = this.metricsCollector.getLastError();
      if (lastErr) {
        state.lastError = lastErr.message;
        state.lastErrorAt = new Date(lastErr.timestamp).toISOString();
      }
    }
    return state;
  }

  getModelSupportsVision(): boolean {
    return this.llmRouter.modelSupportsVision(this.getEffectiveProvider());
  }

  getEventBus(): EventBus {
    return this.eventBus;
  }

  getMemory(): IMemoryStore {
    return this.memory;
  }

  getContextEngine(): ContextEngine {
    return this.contextEngine;
  }

  setSemanticSearch(ss: SemanticMemorySearch): void {
    this.semanticSearch = ss;
  }

  private getDeliverableContext(query?: string): string | undefined {
    if (this.memory instanceof EnhancedMemorySystem) {
      return this.memory.getAgentContext(this.id, query) || undefined;
    }
    return undefined;
  }

  private getLLMMetadata(sessionId?: string): { agentId: string; taskId?: string; sessionId?: string } {
    return {
      agentId: this.id,
      taskId: this.getCurrentTaskId(),
      sessionId,
    };
  }

  private async buildUserContent(text: string, images?: string[], fileNames?: string[]): Promise<string | LLMContentPart[]> {
    if (!images?.length) return text;

    const supportsVision = this.llmRouter.modelSupportsVision(this.getEffectiveProvider());

    if (supportsVision) {
      const parts: LLMContentPart[] = [{ type: 'text', text }];
      for (const img of images) {
        parts.push({ type: 'image_url', image_url: { url: img } });
      }
      return parts;
    }

    const { convertFilesToText } = await import('./file-converter.js');
    const converted = await convertFilesToText(images, fileNames);
    const attachmentText = converted
      .map(d => `\n\n<attached_file name="${d.name}" type="${d.mimeType}">\n${d.text}\n</attached_file>`)
      .join('');
    return text + attachmentText;
  }

  private buildToolDefinitions(context?: {
    userMessage?: string;
    isTaskExecution?: boolean;
    isReview?: boolean;
  }): LLMTool[] {
    const isManager = this.config.agentRole === 'manager';

    // Include tools the agent explicitly requested via discover_tools
    const recentPlusActivated = [...this.recentToolNames, ...this.activatedExtraTools];

    const effectiveTools = taskAsyncContext.getStore()?.tools ?? this.tools;

    const tools = this.toolSelector.selectTools({
      allTools: effectiveTools,
      userMessage: context?.userMessage ?? '',
      recentToolNames: recentPlusActivated,
      isManager,
      isTaskExecution: context?.isTaskExecution,
      isReview: context?.isReview,
      skillCatalog: this.skillRegistry?.list(),
    });

    return tools;
  }

  /**
   * Handle the discover_tools meta-tool. Supports:
   * - mode="list_skills": list all available skills (prompt-based instruction packages, optionally with MCP tools)
   * - name with skill names: activate skill by injecting its instructions and connecting its MCP servers
   * - name with tool names: activate individual tools already registered on the agent
   */
  private async handleDiscoverTools(args: Record<string, unknown>): Promise<string> {
    const mode = (args.mode as string) ?? 'activate';

    if (mode === 'list_skills') {
      const skills = this.skillRegistry?.list() ?? [];
      if (skills.length === 0) {
        return JSON.stringify({
          status: 'ok',
          skills: [],
          message: 'No skills available in the registry.',
        });
      }
      const catalog = skills.map(s => ({
        name: s.name,
        description: s.description,
        category: s.category,
        hasInstructions: !!s.instructions,
        hasMcpTools: !!s.mcpServers && Object.keys(s.mcpServers).length > 0,
      }));
      return JSON.stringify({
        status: 'ok',
        skills: catalog,
        message: `${catalog.length} skills available. Use discover_tools({ name: ["skill-name"] }) to activate a skill (loads its instructions and MCP tools into your context).`,
      });
    }

    // Search remote registries for skills not yet installed
    if (mode === 'search_registry') {
      const query = (args.query as string) ?? '';
      if (!this.skillSearcher) {
        return JSON.stringify({ status: 'error', message: 'Remote skill search is not available.' });
      }
      try {
        const results = await this.skillSearcher(query);
        // Filter out already-installed skills
        const installed = new Set((this.skillRegistry?.list() ?? []).map(s => s.name.toLowerCase()));
        const available = results.filter(s => !installed.has(s.name.toLowerCase()));
        return JSON.stringify({
          status: 'ok',
          results: available,
          message: available.length > 0
            ? `Found ${available.length} skill(s) matching "${query}". Use discover_tools({ mode: "install", ... }) to install one, then activate it.`
            : `No uninstalled skills found for "${query}".`,
        });
      } catch (err) {
        return JSON.stringify({ status: 'error', message: `Search failed: ${String(err)}` });
      }
    }

    // Normalize `name` — accept string, array, or legacy `tool_names` for backward compat
    const resolvedNames: string[] = [];
    const nameArg = args.name ?? args.tool_names;
    if (Array.isArray(nameArg)) {
      for (const n of nameArg as string[]) {
        if (typeof n === 'string' && n.trim()) resolvedNames.push(n.trim());
      }
    } else if (typeof nameArg === 'string' && nameArg.trim()) {
      resolvedNames.push(nameArg.trim());
    }

    // Install a skill from a remote registry
    if (mode === 'install') {
      const skillName = resolvedNames[0];
      if (!skillName) {
        return JSON.stringify({ status: 'error', message: 'name is required for install mode.' });
      }
      if (!this.skillInstaller) {
        return JSON.stringify({ status: 'error', message: 'Skill installation is not available.' });
      }
      try {
        const installArgs = { ...args, name: skillName };
        const result = await this.skillInstaller(installArgs);
        log.info('Skill installed via discover_tools', { agentId: this.id, skill: skillName, method: result.method });
        return JSON.stringify({
          status: 'ok',
          installed: result.name,
          method: result.method,
          message: `Skill "${result.name}" installed successfully. Use discover_tools({ name: ["${result.name}"] }) to activate it.`,
        });
      } catch (err) {
        return JSON.stringify({ status: 'error', message: `Install failed: ${String(err instanceof Error ? err.message : err)}` });
      }
    }

    // mode === 'activate' (default)
    const requested = resolvedNames;
    const activated: string[] = [];
    const unknown: string[] = [];

    for (const name of requested) {
      // 1. Check if it's an existing tool name on this agent
      if (this.tools.has(name)) {
        this.activatedExtraTools.add(name);
        activated.push(name);
        continue;
      }

      // 2. Check if it's a skill name in the registry -- inject instructions and/or MCP tools
      if (this.skillRegistry) {
        const skill = this.skillRegistry.get(name);
        if (skill) {
          if (skill.manifest.instructions) {
            this.activatedSkillInstructions.set(name, skill.manifest.instructions);
          }

          let mcpToolCount = 0;
          if (skill.manifest.mcpServers && this.skillMcpActivator) {
            try {
              const mcpTools = await this.skillMcpActivator(name, skill.manifest.mcpServers);
              const toolNames: string[] = [];
              for (const tool of mcpTools) {
                this.registerTool(tool);
                toolNames.push(tool.name);
              }
              this.activateTools(toolNames);
              mcpToolCount = mcpTools.length;
            } catch (err) {
              log.warn('Failed to activate skill MCP servers via discover_tools', {
                agentId: this.id, skill: name, error: String(err),
              });
            }
          }

          const parts = [name];
          if (skill.manifest.instructions) parts.push('instructions loaded');
          if (mcpToolCount > 0) parts.push(`${mcpToolCount} MCP tools loaded`);
          if (!skill.manifest.instructions && mcpToolCount === 0) parts.push('skill found but has no instructions or MCP tools');
          activated.push(parts.length > 1 ? `${parts[0]} (${parts.slice(1).join(', ')})` : parts[0]);

          log.info('Skill activated via discover_tools', {
            agentId: this.id, skill: name, mcpToolCount,
            hasInstructions: !!skill.manifest.instructions,
          });
          continue;
        }
      }

      // 3. Not found as tool or skill
      unknown.push(name);
    }

    const result: Record<string, unknown> = {
      status: 'ok',
      activated,
      message: activated.length > 0
        ? `${activated.length} items activated. Skill instructions are now part of your context.`
        : 'Nothing was activated.',
    };
    if (unknown.length > 0) {
      result.unknown = unknown;
      result.hint = 'These names were not found as tools or skills. '
        + 'Use discover_tools({ mode: "list_skills" }) to see all available skills.';
    }
    return JSON.stringify(result);
  }

  private async executeTool(toolCall: LLMToolCall, onOutput?: ToolOutputCallback, sessionId?: string): Promise<string> {
    // Handle the discover_tools meta-tool: activate requested tools, skills, and skill MCP servers
    if (toolCall.name === 'discover_tools') {
      return await this.handleDiscoverTools(toolCall.arguments);
    }

    // Handle notify_user: proactive message to the user (appears in chat + notification bell)
    if (toolCall.name === 'notify_user') {
      const title = (toolCall.arguments.title as string) ?? '';
      const body = (toolCall.arguments.body as string) ?? '';
      if (!title || !body) {
        return JSON.stringify({ status: 'error', message: 'title and body are required' });
      }
      try {
        const priority = (toolCall.arguments.priority as string) ?? 'normal';
        const explicitTaskId = toolCall.arguments.related_task_id as string | undefined;
        const taskId = explicitTaskId ?? this.getCurrentTaskId();
        const requirementId = this.getCurrentRequirementId();

        // Write full message into in-memory session (as regular message, not activityLog)
        const formattedMsg = `**${title}**\n\n${body}`;
        if (this.currentSessionId) {
          this.memory.appendMessage(this.currentSessionId, {
            role: 'assistant',
            content: formattedMsg,
          });
        }
        this.recentActivityRing.push(`[notify_user] ${title}`);
        if (this.recentActivityRing.length > Agent.ACTIVITY_RING_SIZE) {
          this.recentActivityRing.shift();
        }

        // Emit event — start.ts handler does DB persist + WS broadcast + notification
        this.eventBus.emit('agent:notify-user', {
          agentId: this.id,
          sessionId: this.currentSessionId,
          targetUserId: this.currentInteractingUserId,
          title,
          body,
          priority,
          taskId,
          requirementId,
        });

        log.info('User notification sent', { agentId: this.id, title });
        return JSON.stringify({ status: 'ok', message: 'Notification sent to user.' });
      } catch (err) {
        return JSON.stringify({ status: 'error', message: `Failed to send notification: ${String(err)}` });
      }
    }

    // Handle request_user_approval: blocking approval/decision request
    if (toolCall.name === 'request_user_approval') {
      const title = (toolCall.arguments.title as string) ?? '';
      const description = (toolCall.arguments.description as string) ?? '';
      if (!title || !description) {
        return JSON.stringify({ status: 'error', message: 'title and description are required' });
      }
      if (!this.userApprovalRequester) {
        return JSON.stringify({ status: 'error', message: 'User approval is not available.' });
      }
      try {
        const priority = (toolCall.arguments.priority as string) ?? 'normal';
        const relatedTaskId = toolCall.arguments.related_task_id as string | undefined;
        const options = toolCall.arguments.options as Array<{ id: string; label: string; description?: string }> | undefined;
        const allowFreeform = (toolCall.arguments.allow_freeform as boolean) ?? false;

        this.attentionController.setWaitingForApproval(true);
        try {
          const result = await this.userApprovalRequester({
            agentId: this.id,
            agentName: this.config.name,
            title,
            description,
            options,
            allowFreeform,
            priority,
            relatedTaskId,
          });

          log.info('User approval response received', { agentId: this.id, title, approved: result.approved, selectedOption: result.selectedOption });
          return JSON.stringify({
            status: 'ok',
            approved: result.approved,
            selected_option: result.selectedOption ?? (result.approved ? 'approve' : 'reject'),
            comment: result.comment ?? '',
          });
        } finally {
          this.attentionController.setWaitingForApproval(false);
        }
      } catch (err) {
        return JSON.stringify({ status: 'error', message: `Failed to get user approval: ${String(err)}` });
      }
    }

    // Enforce agent profile tool restrictions
    const profile = this.config.profile;
    if (profile) {
      if (profile.toolWhitelist && !profile.toolWhitelist.includes(toolCall.name)) {
        return JSON.stringify({
          status: 'denied',
          error: `Tool '${toolCall.name}' is not in this agent's allowed tool list`,
        });
      }
      if (profile.toolBlacklist?.includes(toolCall.name)) {
        return JSON.stringify({
          status: 'denied',
          error: `Tool '${toolCall.name}' is blocked by agent profile`,
        });
      }
    }

    // Check if this tool requires human approval
    const needsApproval = this.config.profile?.requireApprovalFor?.some(
      pattern => toolCall.name === pattern || toolCall.name.startsWith(pattern.replace('*', ''))
    );
    if (needsApproval) {
      if (this.approvalCallback) {
        log.info(`Tool ${toolCall.name} requires approval, requesting...`, { agentId: this.id });
        const result = await this.approvalCallback({
          agentId: this.id,
          agentName: this.config.name,
          toolName: toolCall.name,
          toolArgs: toolCall.arguments,
          reason: `Agent wants to execute '${toolCall.name}'`,
          taskId: this.getCurrentTaskId(),
        });
        if (!result.approved) {
          const reason = result.comment ? `: ${result.comment}` : '';
          log.info(`Tool ${toolCall.name} execution denied by human`, { agentId: this.id });
          return JSON.stringify({
            status: 'denied',
            error: `Execution of '${toolCall.name}' was denied by human reviewer${reason}`,
          });
        }
        log.info(`Tool ${toolCall.name} approved by human`, { agentId: this.id });
      } else {
        log.warn(`Tool ${toolCall.name} requires approval but no approval callback set`, {
          agentId: this.id,
        });
      }
    }

    const effectiveTools = taskAsyncContext.getStore()?.tools ?? this.tools;
    const handler = effectiveTools.get(toolCall.name);
    if (!handler) {
      this.recordToolUsage(toolCall.name, false);
      this.handleFailure(`Unknown tool: ${toolCall.name}`);
      return JSON.stringify({ error: `Unknown tool: ${toolCall.name}` });
    }

    // Track recently used tools so they stay active in subsequent turns
    if (!this.recentToolNames.includes(toolCall.name)) {
      this.recentToolNames.push(toolCall.name);
      if (this.recentToolNames.length > 10) this.recentToolNames.shift();
    }

    // Run before-hooks (outside retry loop — hooks decide once)
    const idempotencyKey = generateIdempotencyKey(toolCall.name, toolCall.arguments);
    const hookCtx = {
      agentId: this.id,
      toolName: toolCall.name,
      arguments: toolCall.arguments,
      attempt: 0,
      idempotencyKey,
    };
    const beforeResult = await this.toolHooks.runBefore(hookCtx);
    if (!beforeResult.proceed) {
      // Check for idempotency cache hit
      if (beforeResult.reason?.startsWith('__idempotent__:')) {
        return beforeResult.reason.slice('__idempotent__:'.length);
      }
      return JSON.stringify({
        status: 'denied',
        error: beforeResult.reason ?? 'Blocked by tool hook',
      });
    }
    const baseArgs = beforeResult.modifiedArgs ?? toolCall.arguments;
    const effectiveArgs = sessionId
      ? { ...baseArgs, _browserSessionId: sessionId }
      : baseArgs;

    let lastError: unknown;
    for (let attempt = 0; attempt <= Agent.TOOL_RETRY_MAX; attempt++) {
      try {
        if (attempt > 0) {
          const delay = Agent.TOOL_RETRY_BASE_MS * Math.pow(2, attempt - 1);
          log.info(`Retrying tool ${toolCall.name} (attempt ${attempt + 1})`, { delay });
          await new Promise(r => setTimeout(r, delay));
        }
        log.debug(`Executing tool: ${toolCall.name}`, { args: effectiveArgs, attempt });
        const span = startSpan('agent.tool', { tool: toolCall.name, attempt });
        try {
          const result = await handler.execute(effectiveArgs, onOutput);
          this.recordToolUsage(toolCall.name, true);
          this.consecutiveFailures = 0;
          const toolDurationMs = Date.now() - span.startTime;
          span.end({ success: true });
          const finalResult = await this.toolHooks.runAfter({
            ...hookCtx,
            attempt,
            result,
            durationMs: toolDurationMs,
            success: true,
          });
          return finalResult;
        } catch (error) {
          span.setError(error instanceof Error ? error : String(error));
          span.end({ success: false });
          throw error;
        }
      } catch (error) {
        lastError = error;
        log.error(`Tool execution failed: ${toolCall.name} (attempt ${attempt + 1})`, {
          error: String(error),
        });
      }
    }

    this.recordToolUsage(toolCall.name, false);
    this.handleFailure(
      `Tool ${toolCall.name} failed after ${Agent.TOOL_RETRY_MAX + 1} attempts: ${String(lastError)}`
    );
    return JSON.stringify({ error: String(lastError) });
  }

  private handleFailure(reason: string): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= Agent.MAX_CONSECUTIVE_FAILURES) {
      log.warn('Consecutive failure threshold reached, escalating to human', {
        agentId: this.id,
        failures: this.consecutiveFailures,
      });
      const escalationReason = `Agent ${this.config.name} needs help: ${reason} (${this.consecutiveFailures} consecutive failures)`;
      this.escalationCallback?.(this.id, escalationReason);

      // Write escalation message into in-memory session so agent is aware
      const formattedMsg = `**I need help**\n\n${escalationReason}`;
      if (this.currentSessionId) {
        this.memory.appendMessage(this.currentSessionId, {
          role: 'assistant',
          content: formattedMsg,
        });
      }
      this.recentActivityRing.push(`[escalation] ${escalationReason}`);
      if (this.recentActivityRing.length > Agent.ACTIVITY_RING_SIZE) {
        this.recentActivityRing.shift();
      }

      // Emit event — start.ts handler does DB persist + WS broadcast + notification + audit
      this.eventBus.emit('agent:escalation', {
        agentId: this.id,
        sessionId: this.currentSessionId,
        reason: escalationReason,
      });

      this.consecutiveFailures = 0;
    }
  }

  private static isNetworkError(error: unknown): boolean {
    if (error instanceof Error && error.name === 'AbortError') return true;
    const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
    return msg.includes('enotfound') ||
      msg.includes('getaddrinfo') ||
      msg.includes('econnrefused') ||
      msg.includes('econnreset') ||
      msg.includes('etimedout') ||
      msg.includes('fetch failed') ||
      msg.includes('network') ||
      msg.includes('socket hang up') ||
      msg.includes('dns') ||
      msg.includes('aborted') ||
      msg.includes('aborterror');
  }

  private async withNetworkRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < Agent.NETWORK_RETRY_MAX; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (!Agent.isNetworkError(error) || attempt >= Agent.NETWORK_RETRY_MAX - 1) {
          throw error;
        }
        const delay = Agent.NETWORK_RETRY_BASE_MS * Math.pow(2, attempt);
        log.warn(`${label} failed with network error, retrying (${attempt + 1}/${Agent.NETWORK_RETRY_MAX})`, {
          agentId: this.id,
          error: String(error).slice(0, 200),
          delay,
        });
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    throw lastError;
  }

  /**
   * Check whether today's daily report deliverable already exists.
   * Returns true if a report with today's date tag is found in memory.
   */
  private hasTodayDailyReport(): boolean {
    const todayTag = `daily-report:${new Date().toISOString().slice(0, 10)}`;
    try {
      const results = this.memory.search(todayTag);
      return results.length > 0;
    } catch { return false; }
  }

  private async handleHeartbeat(ctx: {
    agentId: string;
    triggeredAt: string;
  }): Promise<void> {
    log.info('Processing heartbeat check-in');
    const activityId = this.startActivity('heartbeat', 'Heartbeat check-in', {});

    let lastHeartbeatSummary = '';
    try {
      const results = this.memory.search('heartbeat:summary');
      if (results.length > 0) {
        const latest = results[results.length - 1];
        if (latest) {
          lastHeartbeatSummary = `\n## Last Heartbeat (${latest.timestamp ?? 'unknown'})\n${latest.content}\n`;
        }
      }
    } catch { /* ignore search failures */ }

    const checklist = this.role.heartbeatChecklist || '- Check assigned tasks with `task_list`';

    const now = new Date();
    const currentHour = now.getHours();
    const todayDate = now.toISOString().slice(0, 10);

    // --- Failed task recovery section (all agents) ---
    const failedTaskRecoverySection = [
      '',
      '## Failed Task Recovery',
      'Check `task_list` for tasks assigned to you with status `failed`.',
      'If you find any, retry them by calling `task_update` with `status: "in_progress"` and a note explaining the retry.',
      'This will automatically restart task execution with previous context preserved, so the agent can learn from the failure.',
      'Only retry tasks where you are the `assignedAgentId`. Do NOT retry tasks assigned to others.',
    ].join('\n');

    // --- Requirement monitoring section (all agents) ---
    const requirementMonitoringSection = [
      '',
      '## Requirement Monitoring',
      'Check requirements you proposed with `requirement_list` (set `mine_only: true`):',
      '- If **pending** for a long time → send a message to the user reminding them to review',
      '- If **in_progress** but no tasks created yet → create tasks to break it down and get started',
      '- If **in_progress** → check linked task status and update the requirement if all tasks are done',
      '- If **rejected** → read the rejection reason and decide if a revised proposal makes sense',
      'Use `requirement_comment` to post updates or ask questions on requirements.',
      'Use `task_comment` with @mentions to coordinate with other agents on shared tasks.',
    ].join('\n');

    // --- Manager daily report logic ---
    const isManager = this.config.agentRole === 'manager';
    let dailyReportSection = '';
    if (isManager && currentHour >= 20 && !this.hasTodayDailyReport()) {
      const todayLog = this.memory.getDailyLog(todayDate);
      dailyReportSection = [
        '',
        '## Daily Report Required',
        `It is now past 20:00 and no daily report exists for ${todayDate}. You MUST produce one now.`,
        '',
        `**CRITICAL — date boundary**: This report covers **only ${todayDate}**.`,
        'Do NOT include tasks completed or work done before today.',
        'When checking task_list, use the `updatedAt` field to determine if activity happened today.',
        'Base your report primarily on the activity log below and current task statuses.',
        '',
        todayLog
          ? `**Today's activity log (${todayDate})**:\n\`\`\`\n${todayLog.slice(0, HEARTBEAT_DAILY_LOG_CHARS)}\n\`\`\``
          : `**Today's activity log**: No activity recorded for ${todayDate}.`,
        '',
        '**Report format** — create a deliverable via `deliverable_create`:',
        `- **title**: "Daily Report — ${todayDate}"`,
        '- **type**: "file"',
        '- **Content must be concise, clear, and accurate**:',
        '  1. **My work today**: What you personally accomplished (tasks reviewed, approved/rejected, decisions made)',
        '  2. **My team progress**: What each member of YOUR team accomplished today (use `team_status` to check). Focus on your own team only.',
        '  3. **Cross-team interactions**: Any coordination with other teams (if applicable)',
        '  4. **Blockers & risks**: Anything stalled or at risk within your team',
        '  5. **Plan for tomorrow**: Top priorities for the next day',
        '- Keep it under 500 words. No filler. Every sentence must carry information.',
        '- IMPORTANT: Only report on YOUR team. Do NOT report on agents from other teams.',
        '- If no meaningful activity happened today, say so honestly — do not fabricate work.',
        '- The system will automatically mark the report as created after this heartbeat.',
        '',
      ].join('\n');
    }

    // --- Self-evolution reflection section (all agents) ---
    const selfEvolutionSection = [
      '',
      '## Completed Task Review & Best Practice Extraction',
      'Use `task_list` to find tasks recently completed (status `completed`) where you were the assignee.',
      'For each completed task since your last heartbeat:',
      '',
      '1. **What went well?** — First-pass approvals (no revision) are strong signals. Efficient tool usage, clean patterns, good decomposition.',
      '2. **What could be improved?** — Friction, rework, reviewer feedback that revealed a better way.',
      '3. **Is there a repeatable pattern?** — If you solved a class of problems (not just one instance), add it to your MEMORY.md knowledge.',
      '',
      '## Knowledge Lifecycle (how to save what you learn)',
      '',
      '**Observation buffer** (`memory_save` → memories.json):',
      '- Individual observations: insights, tool tips, gotchas, task outcomes.',
      '- Format: `[INSIGHT] <summary>` + context/approach/why.',
      '- Tags: always `"insight"` first, then category: `coding`, `tool-usage`, `architecture`, `domain:<topic>`.',
      '- Dream cycles will promote recurring patterns (3+ similar) to MEMORY.md and prune source entries.',
      '',
      '**Curated knowledge** (`memory_update_longterm` → MEMORY.md):',
      '- You organize MEMORY.md however you want — create sections that make sense for your work.',
      '- Use `mode: "patch"` to append to a section, `mode: "replace"` to rewrite a section.',
      '- **ALWAYS check existing knowledge first** (`memory_search`) — update rather than duplicate.',
      '- Common sections: `procedures`, `conventions`, `preferences`, `domain-knowledge`.',
      '',
      '**Shareable skills** (for team-wide practices):',
      '- Check existing skills first: `discover_tools({ mode: "list_skills" })` and `builder_list`.',
      '- To update an existing skill: edit files in `~/.markus/builder-artifacts/skills/{name}/`, bump version, re-install with `builder_install`.',
      '',
      '**Direct self-evolution** (simplest and most impactful):',
      '- **Update ROLE.md** — When you discover a behavioral rule, working style, or guiding principle that should always apply, append it to your ROLE.md via `file_edit`. ROLE.md is loaded into every conversation, so changes take effect immediately. Read first, then append. No need to accumulate 3 insights — even a single validated lesson can warrant a role update if it is fundamental.',
      '- **Update HEARTBEAT.md** — When you realize your patrol routine should include a new recurring check (or remove an obsolete one), modify your HEARTBEAT.md via `file_edit`. This is your personal checklist — customize it to match your actual responsibilities. Changes take effect at the next heartbeat.',
      '',
      '**Decision guide — where does this insight go?**',
      '| Observation type | Action |',
      '|---|---|',
      '| Single insight / gotcha | `memory_save` with tags: `["insight"]` |',
      '| Tool tip or preference | `memory_save` with tags: `["insight", "tool:<name>"]` |',
      '| Multi-step repeatable workflow | `memory_update_longterm({ section: "procedures", mode: "patch" })` |',
      '| Practice worth sharing with the team | Create skill via **skill-building**, then install with `builder_install` |',
      '| Behavioral rule or guiding principle | Update ROLE.md (`file_read` → `file_edit` to append) |',
      '| New recurring check for your patrol | Update HEARTBEAT.md (`file_read` → `file_edit`) |',
      '',
      'Quality bar: Only record insights that are **specific**, **actionable**, and **non-obvious**.',
      'Skip if nothing meaningful happened since last heartbeat.',
    ].join('\n');

    // Drain any background process completion notifications
    const bgCompletions = drainCompletedNotifications();
    let bgCompletionSection = '';
    if (bgCompletions.length > 0) {
      const lines = bgCompletions.map(n => {
        const status = n.exitCode === 0 ? 'OK' : `FAILED (exit ${n.exitCode})`;
        return `- [${status}] \`${n.command}\` (${Math.round(n.durationMs / 1000)}s)${n.exitCode !== 0 && n.stderrTail ? `\n  stderr: ${n.stderrTail.slice(0, 200)}` : ''}`;
      });
      bgCompletionSection = [
        '',
        '## Background Processes Completed',
        `${bgCompletions.length} background process(es) finished since last check:`,
        ...lines,
        'Review any failures and take action if needed.',
      ].join('\n');
    }

    const qualitySignalSection = [
      '',
      '## Quality Signal Check',
      'When reviewing completed tasks, note your revision rate:',
      '- Tasks with `executionRound > 1` required revision — your initial approach had issues.',
      '- A high revision rate (>30%) suggests your knowledge is not being applied effectively.',
      '- Check: does your MEMORY.md knowledge actually cover the failure patterns you see?',
      '- If you keep making the same type of mistake, escalate: save as insight → add to MEMORY.md → update ROLE.md or HEARTBEAT.md.',
      '- Consider: would a ROLE.md rule or a HEARTBEAT.md check have prevented any recent failures?',
    ].join('\n');

    const prompt = [
      '[HEARTBEAT CHECK-IN]',
      '',
      '## Your Checklist',
      checklist,
      lastHeartbeatSummary,
      bgCompletionSection,
      failedTaskRecoverySection,
      requirementMonitoringSection,
      dailyReportSection,
      selfEvolutionSection,
      qualitySignalSection,
      '',
      '## Core Principle: Patrol, Don\'t Build',
      'Heartbeat is a patrol — observe, triage, and take lightweight actions. Heavy work belongs in tasks.',
      '',
      '## Communication Channels',
      'Your raw text output is NOT visible to humans in heartbeat mode. To communicate:',
      '- **Reach humans**: `notify_user` — your message appears in their chat timeline AND notification bell. This is the ONLY way humans will see your findings.',
      '- **Reach agents**: `agent_send_message` — sends a message to a peer agent\'s mailbox.',
      '',
      '## What You CAN Do (lightweight actions)',
      '- **Check status**: `task_list`, `task_get`, `team_status` — see what\'s going on',
      '- **Notify user**: `notify_user` — message appears in chat + notification bell',
      '- **Request user approval**: `request_user_approval` — blocks until user responds',
      '- **Recall history**: `recall_activity` — review your past execution logs',
      '- **Message agents**: `agent_send_message` — coordinate with colleagues',
      '- **Create tasks**: `task_create` — if you spot something that needs doing, create a task for it (assign to yourself or others)',
      '- **Trigger existing tasks**: `task_update(status: "in_progress")` — restart failed tasks or unblock stuck ones',
      '- **Retry failed tasks**: If tasks assigned to you are in `failed` status, retry via `task_update(status: "in_progress")` with a note',
      '- **Quick reviews**: If tasks are in `review` where you are the reviewer, review them now (may need more tool calls)',
      '- **Save insights**: `memory_save` — record observations, insights, and patterns',
      '- **Propose requirements**: `requirement_propose` — suggest work based on what you observe',
      '',
      '## What You Must NOT Do',
      '- **No complex multi-step implementation** — don\'t write code, refactor modules, or do deep analysis in heartbeat',
      '- If you identify something complex that needs doing:',
      '  1. Notify the user via `notify_user` explaining what you found and why it matters',
      '     (Use `request_user_approval` if you need the user to make a decision or provide input)',
      '  2. Create a task via `task_create` with clear description and acceptance criteria',
      '  3. The user will approve and the task system handles execution',
      '',
      '## Conditional Actions',
      '- If background processes failed → check the error, notify the responsible developer or user',
      '- If tasks are blocked for too long → investigate blockers, send a message to the assignee or PM',
      '- If a dependency task completed → check if downstream tasks can be unblocked',
      '- If you notice a recurring pattern → save it as an insight via `memory_save`',
      '',
      '## Finishing Up',
      '- Compare against your last heartbeat summary above. Skip unchanged items.',
      '- If the Daily Report Required section is present above, you MUST produce the report.',
      '- Call `memory_save` with key `heartbeat:summary` — one line per finding.',
      '- If nothing needs attention and no daily report is due, respond with exactly: HEARTBEAT_OK',
    ].join('\n');

    const baseTools = [
      'task_create', 'task_list', 'task_update', 'task_get', 'task_note',
      'task_comment', 'requirement_comment',
      'file_read', 'agent_send_message',
      'requirement_propose', 'requirement_list', 'requirement_update_status',
      'memory_save', 'memory_search', 'memory_update_longterm',
      'discover_tools', 'notify_user', 'request_user_approval', 'recall_activity',
    ];
    if (isManager) {
      baseTools.push(
        'task_board_health', 'task_cleanup_duplicates', 'task_assign',
        'team_status', 'deliverable_create', 'deliverable_search',
        'team_hire_agent', 'team_list_templates', 'builder_install', 'builder_list',
      );
    }
    const HEARTBEAT_ALLOWED_TOOLS = new Set(baseTools);

    const HEARTBEAT_MAX_RETRIES = 3;
    const HEARTBEAT_RETRY_BASE_MS = 3000;
    let lastError: unknown;

    for (let attempt = 0; attempt <= HEARTBEAT_MAX_RETRIES; attempt++) {
      try {
        const reply = await this.handleMessage(prompt, undefined, undefined, {
          sessionId: `hb_${this.id}_${Date.now()}`,
          allowedTools: HEARTBEAT_ALLOWED_TOOLS,
          scenario: 'heartbeat',
          maxToolIterations: Agent.HEARTBEAT_MAX_TOOL_ITERATIONS,
        });
        this.state.lastHeartbeat = new Date().toISOString();
        this.metricsCollector.recordHeartbeat(true);

        if (dailyReportSection) {
          this.memory.addEntry({
            id: `daily_report_${todayDate}`,
            timestamp: new Date().toISOString(),
            type: 'note',
            content: `daily-report:${todayDate} created`,
            metadata: { tags: ['daily-report'] },
          });
        }

        const cleanReply = reply ? stripCompletionMarker(reply) : '';
        const isOk = cleanReply.trim() === 'HEARTBEAT_OK';
        if (cleanReply && !isOk && cleanReply.length > 20) {
          this.emitActivityLog(activityId, 'text', cleanReply);
          this.memory.writeDailyLog(this.id, `[Heartbeat] ${cleanReply}`);
        }
        this.endActivity(activityId);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < HEARTBEAT_MAX_RETRIES) {
          const delay = HEARTBEAT_RETRY_BASE_MS * Math.pow(2, attempt);
          log.warn(`Heartbeat attempt ${attempt + 1}/${HEARTBEAT_MAX_RETRIES + 1} failed, retrying in ${delay}ms`, {
            agentId: this.id,
            error: String(error).slice(0, 200),
          });
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    this.emitActivityLog(activityId, 'error', String(lastError));
    this.endActivity(activityId);
    this.metricsCollector.recordHeartbeat(false);
    log.error('Heartbeat failed after all retries', {
      agentId: this.id,
      attempts: HEARTBEAT_MAX_RETRIES + 1,
      error: String(lastError),
    });
  }

  /**
   * Memory flush: before compaction, prompt the agent to persist important information.
   * Inspired by OpenClaw's pre-compaction memory flush pattern.
   */
  private async memoryFlush(sessionId: string): Promise<void> {
    const session = this.memory.getSession(sessionId);
    if (!session || session.messages.length < 20) return;

    const recentMessages = session.messages.slice(-20);
    const hasSubstantiveContent = recentMessages.some(
      m => m.role === 'assistant' && (typeof m.content === 'string' ? m.content.length : 0) > 100
    );
    if (!hasSubstantiveContent) return;

    try {
      const flushPrompt = [
        '[MEMORY FLUSH — System Request]',
        '',
        'The conversation context is approaching its limit and will be compacted soon.',
        'Review the recent conversation and save any important information that should be remembered long-term.',
        '',
        'Use `memory_save` to persist:',
        '- Key decisions or conclusions reached',
        '- Important facts learned about the project or user preferences',
        '- Task outcomes or status changes',
        '- Technical details that would be costly to rediscover',
        '',
        'Only save genuinely important information. Skip routine exchanges.',
        'If nothing important needs saving, just respond with "No important information to save."',
      ].join('\n');

      await this.handleMessage(flushPrompt, undefined, undefined, {
        sessionId: `sys_${this.id}_${Date.now()}`,
        scenario: 'heartbeat',
      });
      log.info('Memory flush completed before compaction', { agentId: this.id, sessionId });
    } catch (error) {
      log.warn('Memory flush failed, proceeding with compaction anyway', { error: String(error) });
    }
  }

  /**
   * Periodic memory consolidation:
   * 1. Compact main session if it has grown large
   * 2. Memory dream: prune, deduplicate, merge (once per day)
   */
  private lastDreamDate = '';

  private async consolidateMemory(): Promise<void> {
    try {
      const today = new Date().toISOString().slice(0, 10);

      // Session compaction is now handled exclusively by MemoryStore.checkAndCompact
      // (triggered on appendMessage at >80 messages). No session compaction here —
      // consolidateMemory only runs the dream cycle.

      // Memory dream: prune, deduplicate, merge — once per day when entries are large
      const entries = this.memory.getEntries();
      if (entries.length >= 50 && this.lastDreamDate !== today) {
        this.lastDreamDate = today;
        await this.dreamConsolidateMemory(entries);
        this.pruneMemoryMd();
      }

      log.debug('Memory consolidation completed', { agentId: this.id });
    } catch (error) {
      log.warn('Memory consolidation failed', { agentId: this.id, error: String(error) });
    }
  }

  /**
   * "Dream" cycle: send memory entries to the LLM to identify duplicates,
   * outdated items, and merge opportunities. Apply changes programmatically.
   */
  private async dreamConsolidateMemory(entries: MemoryEntry[]): Promise<void> {
    const MAX_ENTRIES_FOR_LLM = 200;
    const truncated = entries.length > MAX_ENTRIES_FOR_LLM;
    const batch = truncated ? entries.slice(-MAX_ENTRIES_FOR_LLM) : entries;

    const entryList = batch.map((e, i) => {
      const tags = Array.isArray(e.metadata?.tags) ? ` [tags: ${(e.metadata!.tags as string[]).join(', ')}]` : '';
      return `[${i}] id=${e.id} type=${e.type} date=${e.timestamp?.slice(0, 10) ?? '?'}${tags}\n${e.content.slice(0, 200)}`;
    }).join('\n\n');

    log.info('Dream cycle starting', {
      agentId: this.id,
      totalEntries: entries.length,
      batchSize: batch.length,
      truncated,
    });

    const existingKnowledge = this.memory.getLongTermMemory();
    const knowledgePreview = existingKnowledge ? existingKnowledge.slice(0, 1500) : '';

    const prompt = [
      '[MEMORY CONSOLIDATION — Dream Cycle]',
      '',
      `You have ${batch.length} memory entries${truncated ? ` (showing most recent ${MAX_ENTRIES_FOR_LLM} of ${entries.length} total)` : ''}. Review them and:`,
      '',
      '**Phase 1 — Clean up:**',
      '1. **Duplicates**: entries saying essentially the same thing → remove',
      '2. **Outdated**: entries superseded by newer information → remove',
      '3. **Merge candidates**: multiple entries about the same topic → combine into one',
      '',
      '**Phase 2 — Promote recurring patterns:**',
      '4. **Pattern promotion**: If 3+ entries share a common theme (e.g., same type of mistake, same tool approach),',
      '   synthesize them into a consolidated insight and mark the source entries for removal.',
      '   Use the `section` field to specify which MEMORY.md section the promoted content belongs to.',
      '   The agent organizes their own sections — use whatever section name fits the content.',
      '',
      knowledgePreview ? `## Existing MEMORY.md Knowledge (for reference — avoid duplicating)\n${knowledgePreview}\n` : '',
      '',
      'Respond with ONLY a JSON object (no markdown fences):',
      '{',
      '  "remove": ["id1", "id2"],',
      '  "merge": [',
      '    { "removeIds": ["id3", "id4"], "mergedContent": "combined text", "tags": ["insight"] }',
      '  ],',
      '  "promote": [',
      '    { "sourceIds": ["id5", "id6", "id7"], "section": "procedures", "content": "synthesized insight" }',
      '  ]',
      '}',
      '',
      'Rules:',
      '- Be conservative. Only remove entries you are confident are redundant or outdated.',
      '- When merging, preserve all unique information from the originals.',
      '- Promote only when 3+ entries point to the same pattern.',
      '- The `section` field uses the agent\'s own MEMORY.md section names (agent-organized, not fixed).',
      '- If nothing needs consolidation, return { "remove": [], "merge": [], "promote": [] }',
      '',
      '## Current Memory Entries',
      '',
      entryList,
    ].join('\n');

    try {
      const response = await this.sendMessage(prompt, undefined, undefined, {
        sourceType: 'memory_consolidation',
        sessionId: `sys_${this.id}_${Date.now()}`,
        scenario: 'memory_consolidation',
        allowedTools: new Set<string>(),
      });

      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        log.debug('Dream cycle: no valid JSON in response, skipping');
        return;
      }

      const rawPlan = JSON.parse(jsonMatch[0]) as {
        remove?: string[];
        merge?: Array<{ removeIds: string[]; mergedContent: string; tags?: string[] }>;
        promote?: Array<{ sourceIds: string[]; section: string; content: string }>;
      };

      // Guardrails: cap operations and validate IDs
      const MAX_REMOVE_PER_CYCLE = 10;
      const MAX_MERGE_PER_CYCLE = 5;
      const entryIds = new Set(batch.map(e => e.id));

      const plan = {
        remove: (rawPlan.remove ?? []).filter(id => entryIds.has(id)).slice(0, MAX_REMOVE_PER_CYCLE),
        merge: (rawPlan.merge ?? []).filter(m =>
          m.removeIds.every(id => entryIds.has(id)) && m.mergedContent?.length > 0
        ).slice(0, MAX_MERGE_PER_CYCLE),
        promote: (rawPlan.promote ?? []).filter(p =>
          p.sourceIds.every(id => entryIds.has(id)) && p.content?.length > 0 && p.section?.length > 0
        ).slice(0, MAX_MERGE_PER_CYCLE),
      };

      if ((rawPlan.remove?.length ?? 0) > MAX_REMOVE_PER_CYCLE) {
        log.warn('Dream cycle: remove list truncated', {
          requested: rawPlan.remove!.length, cap: MAX_REMOVE_PER_CYCLE,
        });
      }

      // Audit log: full plan before application
      log.info('Dream cycle plan (audited)', {
        agentId: this.id,
        toRemove: plan.remove.length,
        toMerge: plan.merge.length,
        toPromote: plan.promote.length,
        removeIds: plan.remove,
        mergeGroups: plan.merge.map(g => ({ removeIds: g.removeIds, contentPreview: g.mergedContent.slice(0, 80) })),
        promoteGroups: plan.promote.map(p => ({ sourceIds: p.sourceIds, section: p.section, contentPreview: p.content.slice(0, 80) })),
      });

      let removedCount = 0;
      let mergedCount = 0;
      let promotedCount = 0;

      if (plan.remove.length > 0) {
        removedCount = this.memory.removeEntries(plan.remove);
        if (this.semanticSearch?.isEnabled()) {
          for (const id of plan.remove) {
            this.semanticSearch.deleteMemory(id).catch(() => {});
          }
        }
      }

      if (plan.merge?.length) {
        for (const group of plan.merge) {
          if (!group.removeIds?.length || !group.mergedContent) continue;
          const newEntry = {
            id: `merged_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            timestamp: new Date().toISOString(),
            type: 'note' as const,
            content: group.mergedContent,
            metadata: { tags: group.tags ?? ['consolidated'], dreamCycle: true },
          };
          this.memory.replaceEntries(group.removeIds, newEntry);
          if (this.semanticSearch?.isEnabled()) {
            for (const id of group.removeIds) {
              this.semanticSearch.deleteMemory(id).catch(() => {});
            }
            this.semanticSearch.indexMemory(newEntry, this.id).catch(() => {});
          }
          mergedCount++;
        }
      }

      // Phase 2: Promote recurring patterns to MEMORY.md and prune source entries
      if (plan.promote?.length) {
        for (const promo of plan.promote) {
          if (!promo.sourceIds?.length || !promo.content || !promo.section) continue;
          const section = promo.section.toLowerCase().replace(/[^a-z0-9-]/g, '-');
          const existing = this.memory.getLongTermSection(section);
          const merged = existing ? `${existing}\n${promo.content}` : promo.content;
          this.memory.addLongTermMemory(section, merged);

          // Remove source entries from intake buffer
          const removed = this.memory.removeEntries(promo.sourceIds);
          if (this.semanticSearch?.isEnabled()) {
            for (const id of promo.sourceIds) {
              this.semanticSearch.deleteMemory(id).catch(() => {});
            }
          }
          promotedCount++;
          log.debug('Dream cycle: promoted pattern to MEMORY.md', {
            section, sourceCount: promo.sourceIds.length, removed,
            contentPreview: promo.content.slice(0, 100),
          });
        }
      }

      if (removedCount > 0 || mergedCount > 0 || promotedCount > 0) {
        log.info('Dream cycle completed', {
          agentId: this.id,
          entriesBefore: entries.length,
          removed: removedCount,
          merged: mergedCount,
          promoted: promotedCount,
          entriesAfter: this.memory.getEntries().length,
        });
      } else {
        log.debug('Dream cycle: no changes needed', { agentId: this.id });
      }
    } catch (error) {
      log.warn('Dream cycle failed', { agentId: this.id, error: String(error) });
    }
  }

  /**
   * Enforce MEMORY.md hygiene: remove daily-report sections (they belong in
   * daily-logs/), strip leaked LLM <think> blocks, and enforce section size limits.
   */
  private pruneMemoryMd(): void {
    const content = this.memory.getLongTermMemory();
    if (!content) return;

    // Pass 1: remove ## daily-report-* sections (they belong in daily-logs/)
    const lines = content.split('\n');
    const afterSectionPrune: string[] = [];
    let inDailyReport = false;

    for (const line of lines) {
      if (line.startsWith('## daily-report-')) {
        inDailyReport = true;
        continue;
      }
      if (inDailyReport && line.startsWith('## ')) {
        inDailyReport = false;
      }
      if (!inDailyReport) afterSectionPrune.push(line);
    }

    // Pass 2: strip <think>...</think> blocks leaked from LLM output
    const outputLines: string[] = [];
    let inThinkBlock = false;

    for (const line of afterSectionPrune) {
      if (line.trim() === '<think>') {
        inThinkBlock = true;
        continue;
      }
      if (inThinkBlock && line.trim() === '</think>') {
        inThinkBlock = false;
        continue;
      }
      if (!inThinkBlock) outputLines.push(line);
    }

    const pruned = outputLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (pruned !== content.trim()) {
      const memoryMdPath = join(this.dataDir, 'MEMORY.md');
      writeFileSync(memoryMdPath, pruned + '\n');
      log.info('Pruned MEMORY.md: removed daily-report sections and LLM artifacts', { agentId: this.id });
    }
  }
}
