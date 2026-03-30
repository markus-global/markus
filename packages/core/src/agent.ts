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

/**
 * Per-task async context — propagates the executing taskId and task-local
 * tool overrides through the async call chain of _executeTaskInternal,
 * so concurrent tasks each resolve their own taskId and use their own
 * tool bindings (e.g. worktree-scoped tools) without cross-contamination.
 */
interface TaskAsyncContext {
  taskId: string;
  /** When set, executeTool/buildToolDefinitions use this instead of this.tools */
  tools?: Map<string, AgentToolHandler>;
}
const taskAsyncContext = new AsyncLocalStorage<TaskAsyncContext>();
import { TaskExecutor, AgentStateManager } from './concurrent/index.js';
import { TaskPriority, TaskStatus } from './concurrent/task-queue.js';
import { ToolLoopDetector } from './tool-loop-detector.js';

const log = createLogger('agent');

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
}) => Promise<boolean>;

export interface TaskWorkspace {
  worktreePath: string;
  branch: string;
  baseBranch: string;
  projectContext?: {
    project: { id: string; name: string; description: string; status: string };
    repositories?: Array<{ localPath: string; defaultBranch: string; role: string }>;
  };
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
  private userMessageSender?: (message: string) => Promise<{ sessionId: string; messageId: string }>;
  private semanticSearch?: SemanticMemorySearch;
  private currentSessionId?: string;
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
  private activeStreamToken?: { cancelled: boolean };
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
  private onActivityLogCb?: (data: { activityId: string; seq: number; type: string; content: string; metadata?: Record<string, unknown> }) => void;
  private onActivityEndCb?: (activityId: string, summary: { endedAt: string; totalTokens: number; totalTools: number; success: boolean }) => void;
  private dynamicContextProviders = new Map<string, () => string>();
  private static readonly MAX_ACTIVITY_LOG_ENTRIES = 200;
  private static readonly MAX_ACTIVITY_LOGS_KEPT = 10;
  private static readonly MAX_CONCURRENT_TASKS = 5;
  private static readonly MAX_CONSECUTIVE_FAILURES = 3;
  private static readonly TOOL_RETRY_MAX = 2;
  private static readonly TOOL_RETRY_BASE_MS = 500;
  private static readonly NETWORK_RETRY_MAX = 3;
  private static readonly NETWORK_RETRY_BASE_MS = 2000;
  private static readonly MEMORY_CONSOLIDATION_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

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
    this.eventBus = new EventBus();
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

    // Initialize task executor
    this.taskExecutor = new TaskExecutor({
      agentId: this.id,
      maxConcurrentTasks: Agent.MAX_CONCURRENT_TASKS,
      defaultPriority: TaskPriority.MEDIUM,
    });

    // Initialize state manager
    this.stateManager = new AgentStateManager(this.id, this.taskExecutor);

    this.eventBus.on('heartbeat:trigger', ctx => {
      this.handleHeartbeat(
        ctx as { agentId: string; triggeredAt: string }
      ).catch(e => log.error('Heartbeat handler failed', { error: String(e) }));
    });

    // Auto-reload role when agent modifies its own ROLE.md
    const roleFilePath = join(this.dataDir, 'role', 'ROLE.md');
    this.toolHooks.register({
      name: 'role-auto-reload',
      after: async (ctx) => {
        if ((ctx.toolName === 'file_edit' || ctx.toolName === 'file_write') && ctx.success) {
          const targetPath = (ctx.arguments['path'] ?? ctx.arguments['filePath'] ?? '') as string;
          if (targetPath === roleFilePath || targetPath.endsWith('/role/ROLE.md')) {
            log.info('Agent modified its own ROLE.md — reloading role definition');
            this.reloadRole();
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
    } else {
      this.state.lastError = undefined;
      this.state.lastErrorAt = undefined;
    }

    if (this.stateManager) {
      this.stateManager.updateState({ status });
    }

    this.notifyStateChange();

    this.eventBus.emit('agent:status-changed', {
      agentId: this.id,
      oldStatus,
      newStatus: status,
      state: this.getState(),
    });
  }

  async start(): Promise<void> {
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

    this.heartbeat.start();

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
    this.heartbeat.stop();
    if (this.memoryConsolidationTimer) {
      clearInterval(this.memoryConsolidationTimer);
      this.memoryConsolidationTimer = undefined;
    }
    this.metricsCollector.flush();
    this.setStatus('offline');
    this.eventBus.emit('agent:stopped', { agentId: this.id });
    log.info(`Agent stopped: ${this.config.name}`);
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
   */
  restoreSessionFromHistory(
    dbSessionId: string,
    dbMessages: Array<{ role: string; content: string }>,
  ): void {
    const existingMemorySessionId = this.dbSessionMap.get(dbSessionId);
    if (existingMemorySessionId) {
      const session = this.memory.getSession(existingMemorySessionId);
      if (session) {
        this.currentSessionId = existingMemorySessionId;
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
    if (this.state.status === 'offline') return;
    this.pauseReason = reason;
    this.setStatus('paused');
    this.eventBus.emit('agent:paused', { agentId: this.id, reason });
    log.info(`Agent paused: ${this.config.name}`, { reason });
  }

  resume(): void {
    if (this.state.status !== 'paused') return;
    this.pauseReason = undefined;
    this.setStatus(this.activeTasks.size > 0 ? 'working' : 'idle');
    this.eventBus.emit('agent:resumed', { agentId: this.id });
    log.info(`Agent resumed: ${this.config.name}`);
  }

  getPauseReason(): string | undefined {
    return this.pauseReason;
  }

  /**
   * Inject a user message into a specific session (e.g. live comments during task execution).
   * The message will be seen by the LLM on its next turn.
   */
  injectUserMessage(sessionId: string, content: string): void {
    let session = this.memory.getSession?.(sessionId);
    if (!session) {
      // Session may not exist yet (e.g. feedback injection before task execution creates it).
      // Create it now so the message is available when the task loop starts.
      session = this.memory.getOrCreateSession(this.id, sessionId);
    }
    this.memory.appendMessage(sessionId, { role: 'user', content });
    log.debug('Injected user message into session', { sessionId, contentLength: content.length });
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

  /**
   * Externally remove a task from the activeTasks set.
   * Used when a task reaches a terminal state outside of the executeTask finally block
   * (e.g. reviewer completes the task while the execution is already winding down).
   */
  removeActiveTask(taskId: string): void {
    this.activeTasks.delete(taskId);
    this.activeTaskGen.delete(taskId);
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

  private updateTokensUsed(tokens: number): void {
    this.state.tokensUsedToday += tokens;
    if (this.stateManager) {
      this.stateManager.updateTokensUsed(tokens);
    }
    this.notifyStateChange();
    // Enforce daily token budget — pause agent if exceeded
    const profile = this.config.profile;
    if (
      profile?.maxTokensPerDay !== undefined &&
      profile.maxTokensPerDay !== null &&
      this.state.tokensUsedToday >= profile.maxTokensPerDay
    ) {
      this.setStatus('paused');
      log.warn('Agent paused: daily token budget exceeded', {
        agentId: this.id,
        tokensUsedToday: this.state.tokensUsedToday,
        maxTokensPerDay: profile.maxTokensPerDay,
      });
    }
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
   * If agent was paused due to budget exceeded, resume to idle.
   */
  resetDailyTokens(): void {
    const wasPausedByBudget =
      this.state.status === 'paused' &&
      this.config.profile?.maxTokensPerDay !== undefined &&
      this.config.profile.maxTokensPerDay !== null &&
      this.state.tokensUsedToday >= this.config.profile.maxTokensPerDay;

    this.state.tokensUsedToday = 0;
    if (this.stateManager) {
      this.stateManager.resetTokensUsed();
    }
    this.notifyStateChange();

    if (wasPausedByBudget) {
      this.setStatus('idle');
      log.info('Agent resumed after daily token reset', { agentId: this.id });
    }
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

  setUserMessageSender(cb: (message: string) => Promise<{ sessionId: string; messageId: string }>): void {
    this.userMessageSender = cb;
  }

  private getDynamicContext(): string | undefined {
    const parts = [...this.dynamicContextProviders.values()].map(p => p()).filter(Boolean);
    for (const [name, instructions] of this.activatedSkillInstructions) {
      parts.push(`<skill name="${name}">\n${instructions}\n</skill>`);
    }
    return parts.length > 0 ? parts.join('\n\n') : undefined;
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
    if (actId) {
      const logType: AgentActivityLogEntry['type'] =
        event.type === 'llm_request' ? 'llm_request' :
        event.type === 'tool_call' ? 'tool_end' :
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
    onLog?: (data: { activityId: string; seq: number; type: string; content: string; metadata?: Record<string, unknown> }) => void;
    onEnd?: (activityId: string, summary: { endedAt: string; totalTokens: number; totalTools: number; success: boolean }) => void;
  }): void {
    this.onActivityStartCb = cbs.onStart;
    this.onActivityLogCb = cbs.onLog;
    this.onActivityEndCb = cbs.onEnd;
  }

  // ─── Activity Tracking ───────────────────────────────────────────────────────

  private startActivity(type: AgentActivity['type'], label: string, extra?: Partial<AgentActivity>): string {
    const id = `act-${this.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const activity = { id, type, label, startedAt: new Date().toISOString(), ...extra };
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

      try {
        this.onActivityEndCb?.(aid, {
          endedAt: new Date().toISOString(),
          totalTokens,
          totalTools,
          success: opts?.success !== false,
        });
      } catch { /* best effort */ }

      this.activityLogs.delete(aid);
      this.activitySeqCounters.delete(aid);
    }
    this.state.currentActivity = undefined;
    this.notifyStateChange();
  }

  private emitActivityLog(activityId: string, type: AgentActivityLogEntry['type'], content: string, metadata?: Record<string, unknown>): void {
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
      content,
      metadata,
      createdAt: new Date().toISOString(),
    };
    logs.push(entry);

    if (logs.length > Agent.MAX_ACTIVITY_LOG_ENTRIES) {
      logs.splice(0, logs.length - Agent.MAX_ACTIVITY_LOG_ENTRIES);
    }

    try { this.onActivityLogCb?.({ activityId, seq, type, content, metadata }); } catch { /* best effort */ }

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
      const report = await this.handleMessage(prompt, undefined, undefined, {
        ephemeral: true,
        maxHistory: 5,
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
      ephemeral?: boolean;
      /** Resume a specific session instead of using the current or ephemeral one */
      sessionId?: string;
      maxHistory?: number;
      channelContext?: Array<{ role: string; content: string }>;
      images?: string[];
      allowedTools?: Set<string>;
      scenario?: 'chat' | 'task_execution' | 'heartbeat' | 'a2a';
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

    // Track chat activity (only if not already in a heartbeat or other activity)
    const isEphemeral = options?.ephemeral ?? false;
    let chatActivityId: string | undefined;
    if (!this.state.currentActivity) {
      let actType: AgentActivity['type'] = 'chat';
      let actLabel: string;
      if (isEphemeral && senderId) {
        actType = 'a2a';
        actLabel = `A2A: Chat with ${senderInfo?.name ?? senderId}`;
      } else if (isEphemeral && !senderId) {
        if (userMessage.includes('DAILY REPORT')) {
          actType = 'internal';
          actLabel = 'Daily Report';
        } else if (userMessage.includes('MEMORY FLUSH')) {
          actType = 'internal';
          actLabel = 'Memory Flush';
        } else {
          actType = 'internal';
          actLabel = 'Internal Operation';
        }
      } else {
        actLabel = `Chat with ${senderInfo?.name ?? senderId ?? 'user'}`;
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

    const maxHistory = options?.maxHistory ?? 200; // load generously; context engine will trim intelligently

    // Session resolution: explicit sessionId > ephemeral > current main session
    let sessionId: string;
    if (options?.sessionId) {
      sessionId = options.sessionId;
      const userContent = this.buildUserContent(userMessage, options?.images);
      this.memory.appendMessage(sessionId, { role: 'user', content: userContent });
    } else if (isEphemeral) {
      sessionId = `ephemeral_${Date.now()}`;
    } else {
      if (!this.currentSessionId) {
        const session = this.memory.createSession(this.id);
        this.currentSessionId = session.id;
      }
      sessionId = this.currentSessionId;
      const userContent = this.buildUserContent(userMessage, options?.images);
      this.memory.appendMessage(sessionId, { role: 'user', content: userContent });
    }

    // Set active model on token counter and ensure tiktoken encoder is loaded
    const effectiveModelName = this.llmRouter.getActiveModelName(this.getEffectiveProvider());
    if (effectiveModelName) {
      const { getDefaultTokenCounter } = await import('./token-counter.js');
      const counter = getDefaultTokenCounter();
      counter.setActiveModel(effectiveModelName);
      await counter.ensureReady();
    }

    const scenario = options?.scenario ?? (isEphemeral && senderId ? 'a2a' : 'chat');
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
      assignedTasks: isEphemeral ? undefined : this.tasksFetcher?.(),
      deliverableContext: isEphemeral ? undefined : this.getDeliverableContext(effectiveMessage),
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
      ...this.getTeamContextParams(),
    });

    let llmTools = this.buildToolDefinitions({ userMessage: effectiveMessage });
    if (options?.allowedTools) {
      llmTools = llmTools.filter(t => options.allowedTools!.has(t.name));
    }

    let messages: LLMMessage[];
    if (isEphemeral) {
      const channelMsgs = (options?.channelContext ?? []).map(m => ({
        role: (m.role === 'assistant' ? 'assistant' : 'user') as LLMMessage['role'],
        content: m.content,
      }));
      messages = [
        { role: 'system' as const, content: systemPrompt },
        ...channelMsgs.slice(-maxHistory),
        { role: 'user' as const, content: effectiveMessage },
      ];
    } else {
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
      messages = prepared.messages;
      log.debug('Context usage for chat', { usagePercent: prepared.usage.usagePercent, totalUsed: prepared.usage.totalUsed });
    }

    const useCompaction = this.llmRouter.isCompactionSupported(this.getEffectiveProvider());
    try {
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

      const MAX_TOOL_ITERATIONS = 200;
      let toolIterations = 0;

      while (
        (response.finishReason === 'tool_use' && response.toolCalls?.length) ||
        response.finishReason === 'max_tokens'
      ) {
        if (++toolIterations > MAX_TOOL_ITERATIONS) {
          log.warn('Tool loop hit max iterations', {
            agentId: this.id,
            iterations: toolIterations,
          });
          break;
        }

        // Handle max_tokens continuation (model was cut off mid-response)
        if (response.finishReason === 'max_tokens' && !response.toolCalls?.length) {
          if (!isEphemeral) {
            this.memory.appendMessage(sessionId, { role: 'assistant', content: response.content });
          } else {
            messages.push({ role: 'assistant', content: response.content });
          }
          // Continue generation from where it left off
          const contMsg: LLMMessage = {
            role: 'user',
            content: '[Continue from where you left off. Do not repeat what you already said.]',
          };
          if (!isEphemeral) {
            this.memory.appendMessage(sessionId, contMsg);
          } else {
            messages.push(contMsg);
          }
        } else {
          // Normal tool_use flow
          if (!isEphemeral) {
            this.memory.appendMessage(sessionId, {
              role: 'assistant',
              content: response.content,
              toolCalls: response.toolCalls,
            });
          } else {
            messages.push({
              role: 'assistant',
              content: response.content,
              toolCalls: response.toolCalls,
            });
          }

          // Execute all tool calls in parallel
          const currentActId = this.state.currentActivity?.id;
          const toolResults = await Promise.all(
            response.toolCalls!.map(async tc => {
              const toolStart = Date.now();
              if (currentActId) {
                this.emitActivityLog(currentActId, 'tool_start', tc.name, { arguments: tc.arguments });
              }
              try {
                let result = await this.executeTool(tc);
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
            if (!isEphemeral) {
              this.memory.appendMessage(sessionId, {
                role: 'tool',
                content: tr.content,
                toolCallId: tr.toolCallId,
              });
            } else {
              messages.push({ role: 'tool', content: tr.content, toolCallId: tr.toolCallId });
            }
          }

          // Record calls for loop detection
          for (let i = 0; i < response.toolCalls!.length; i++) {
            const tc = response.toolCalls![i]!;
            this.loopDetector.record(tc.name, tc.arguments ?? {}, toolResults[i]?.content ?? '');
          }
          const loopCheck = this.loopDetector.check();
          if (loopCheck.detected) {
            if (loopCheck.severity === 'critical') {
              log.warn('Loop detector: critical pattern — breaking', {
                agentId: this.id,
                pattern: loopCheck.pattern,
              });
              // Inject a warning message so the model can self-correct
              const warningMsg = `[SYSTEM] Loop detected: ${loopCheck.message}. You are repeating the same actions without progress. Try a different approach or stop.`;
              if (!isEphemeral) {
                this.memory.appendMessage(sessionId, { role: 'user', content: warningMsg });
              } else {
                messages.push({ role: 'user', content: warningMsg });
              }
            }
          }
        }

        let updatedMessages: typeof messages;
        if (isEphemeral) {
          updatedMessages = this.contextEngine.shrinkEphemeralMessages(
            messages,
            this.llmRouter.getModelContextWindow(this.getEffectiveProvider()),
          );
        } else {
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
          updatedMessages = prepared2.messages;
        }

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

      const reply = response.content;
      const outputCheck = await this.guardrails.checkOutput(reply, { agentId: this.id });
      if (!outputCheck.passed) {
        const filtered = `[Response filtered: ${outputCheck.reason}]`;
        if (!isEphemeral) {
          this.memory.appendMessage(sessionId, { role: 'assistant', content: filtered });
        }
        return filtered;
      }
      if (!isEphemeral) {
        this.memory.appendMessage(sessionId, { role: 'assistant', content: reply });
        // Post-interaction: write to daily log for medium-term memory
        if (reply.length > 50 && senderId) {
          this.memory.writeDailyLog(
            this.id,
            `[Chat with ${senderInfo?.name ?? senderId}] Q: ${userMessage.slice(0, 150)}... A: ${reply.slice(0, 300)}`
          );
        }
      }
      if (chatActivityId) this.endActivity(chatActivityId);
      if (this.activeTasks.size === 0) this.setStatus('idle');

      this.eventBus.emit('agent:message', {
        agentId: this.id,
        senderId,
        userMessage,
        reply,
        tokensUsed: this.getTokensUsed(),
      });

      return reply;
    } catch (error) {
      if (chatActivityId) this.endActivity(chatActivityId);

      // Append error as assistant message so the next conversation turn has full context
      if (!isEphemeral && this.currentSessionId) {
        const errContent = `[Error: ${String(error).slice(0, 300)}]`;
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

    const userContent = this.buildUserContent(userMessage, images);
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
    try {
      const llmStart = Date.now();
      let response = await this.withNetworkRetry(
        () => this.llmRouter.chatStream(
          { messages, tools: llmTools.length > 0 ? llmTools : undefined, metadata: this.getLLMMetadata(this.currentSessionId), compaction: useCompaction },
          onEvent,
          this.getEffectiveProvider(),
          abortController.signal,
        ),
        'Stream LLM call',
      );
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

      const MAX_STREAM_TOOL_ITERATIONS = 200;
      let streamToolIterations = 0;

      while (
        (response.finishReason === 'tool_use' && response.toolCalls?.length) ||
        response.finishReason === 'max_tokens'
      ) {
        if (++streamToolIterations > MAX_STREAM_TOOL_ITERATIONS) {
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
          });

          // Execute all tool calls in parallel
          const toolResults = await Promise.all(
            response.toolCalls!.map(async tc => {
              const toolStart = Date.now();
              onEvent({ type: 'agent_tool', tool: tc.name, phase: 'start', arguments: tc.arguments });
              const toolOutputCb: ToolOutputCallback = (chunk) => {
                onEvent({ type: 'tool_output', tool: tc.name, text: chunk });
              };
              try {
                let result = await this.executeTool(tc, toolOutputCb);
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
          if (loopCheck.detected && loopCheck.severity === 'critical') {
            log.warn('Stream loop detector: critical pattern — injecting warning', {
              agentId: this.id, pattern: loopCheck.pattern,
            });
            const warningMsg = `[SYSTEM] Loop detected: ${loopCheck.message}. You are repeating the same actions without progress. Try a different approach or stop.`;
            this.memory.appendMessage(this.currentSessionId, { role: 'user', content: warningMsg });
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
            onEvent,
            this.getEffectiveProvider(),
            abortController.signal,
          ),
          'Stream LLM continuation',
        );
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

      const reply = response.content;
      const outputCheck = await this.guardrails.checkOutput(reply, { agentId: this.id });
      if (!outputCheck.passed) {
        const filtered = `[Response filtered: ${outputCheck.reason}]`;
        this.memory.appendMessage(this.currentSessionId, { role: 'assistant', content: filtered });
        return filtered;
      }
      this.memory.appendMessage(this.currentSessionId, { role: 'assistant', content: reply });
      if (streamChatActivityId) this.endActivity(streamChatActivityId);
      if (this.activeTasks.size === 0) this.setStatus('idle');

      this.eventBus.emit('agent:message', {
        agentId: this.id,
        senderId,
        userMessage,
        reply,
        tokensUsed: this.getTokensUsed(),
      });

      return reply;
    } catch (error) {
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
    taskWorkspace?: TaskWorkspace,
    executionRound?: number
  ): Promise<void> {
    return this.executeTaskConcurrent(taskId, description, onLog, cancelToken, undefined, taskWorkspace, executionRound);
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
    taskWorkspace?: TaskWorkspace,
    executionRound?: number
  ): Promise<void> {
    if (!this.taskExecutor) {
      throw new Error('Task executor not initialized');
    }

    // 使用TaskExecutor执行任务
    // Wrap in AsyncLocalStorage context so concurrent task executions each
    // resolve their own taskId (prevents deliverable cross-contamination).
    const result = await this.taskExecutor.executeTaskTask(
      taskId,
      () => taskAsyncContext.run({ taskId }, () =>
        this._executeTaskInternal(taskId, description, onLog, cancelToken, taskWorkspace, executionRound)
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
    taskWorkspace?: TaskWorkspace,
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
    const emitDelta = (text: string) => {
      // text_delta: real-time streaming, not persisted individually
      onLog({ seq: -1, type: 'text_delta', content: text, persist: false });
    };

    emit('status', 'started', { agentId: this.id, agentName: this.config.name });

    // Rebind tools to worktree path for project-bound tasks.
    // Use task-local tools (stored in AsyncLocalStorage) instead of mutating
    // the shared this.tools — prevents concurrent worktree tasks from
    // overwriting each other's tool bindings.
    if (taskWorkspace) {
      const worktreePolicy: PathAccessPolicy = {
        primaryWorkspace: taskWorkspace.worktreePath,
        sharedWorkspace: this.pathPolicy?.sharedWorkspace,
        readOnlyPaths: [
          ...(this.pathPolicy?.readOnlyPaths ?? []),
          ...(taskWorkspace.projectContext?.repositories?.map(r => r.localPath) ?? []),
        ].filter(Boolean),
      };
      if (!worktreePolicy.readOnlyPaths?.length) worktreePolicy.readOnlyPaths = undefined;

      const worktreeTools = createBuiltinTools({
        agentId: this.id,
        workspacePath: taskWorkspace.worktreePath,
        pathPolicy: worktreePolicy,
      });
      const taskLocalTools = new Map(this.tools);
      for (const tool of worktreeTools) {
        taskLocalTools.set(tool.name, tool);
      }
      const ctx = taskAsyncContext.getStore();
      if (ctx) {
        ctx.tools = taskLocalTools;
      }
      log.info('Tools rebound to worktree workspace (task-local)', {
        taskId, agentId: this.id, worktreePath: taskWorkspace.worktreePath,
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
      ...(taskWorkspace ? {
        currentWorkspace: {
          branch: taskWorkspace.branch,
          worktreePath: taskWorkspace.worktreePath,
          baseBranch: taskWorkspace.baseBranch,
        },
        projectContext: taskWorkspace.projectContext,
      } : {}),
      agentWorkspace: this.pathPolicy ? {
        primaryWorkspace: this.pathPolicy.primaryWorkspace,
        sharedWorkspace: this.pathPolicy.sharedWorkspace,
        builderArtifactsDir: this.pathPolicy.builderArtifactsDir,
      } : undefined,
      dynamicContext: this.getDynamicContext(),
      agentDataDir: this.dataDir,
      availableSkills: this.availableSkillCatalog,
      ...this.getTeamContextParams(),
    });

    const llmTools = this.buildToolDefinitions({ userMessage: taskPrompt, isTaskExecution: true });
    const useCompaction = this.llmRouter.isCompactionSupported(this.getEffectiveProvider());
    let textBuffer = '';
    let taskToolIterations = 0;

    const flushText = () => {
      if (textBuffer.trim()) {
        emit('text', textBuffer);
        textBuffer = '';
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
          event => {
            if (event.type === 'text_delta' && event.text) {
              textBuffer += event.text;
              emitDelta(event.text);
            }
          },
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
          this.memory.appendMessage(sessionId, { role: 'assistant', content: response.content });
          this.memory.appendMessage(sessionId, {
            role: 'user',
            content: '[Continue from where you left off. Do not repeat what you already said.]',
          });
        } else {
          this.memory.appendMessage(sessionId, {
            role: 'assistant',
            content: response.content,
            toolCalls: response.toolCalls,
          });

          for (const tc of response.toolCalls!) {
            if (cancelToken?.cancelled) break;
            emit('tool_start', tc.name, { arguments: tc.arguments });
            const toolStart = Date.now();
            try {
              let result = await this.executeTool(tc);
              result = this.offloadLargeResult(tc.name, result);
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
            } catch (toolErr) {
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
        }

        if (cancelToken?.cancelled) {
          emit('status', 'cancelled', { reason: 'Task execution was stopped externally' });
          log.info('Task execution cancelled externally after tools', { taskId, agentId: this.id });
          return;
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
            event => {
              if (event.type === 'text_delta' && event.text) {
                textBuffer += event.text;
                emitDelta(event.text);
              }
            },
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

      flushText();
      const finalReply = response.content;
      this.memory.appendMessage(sessionId, { role: 'assistant', content: finalReply });
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

      // Worktree tools are now task-local (stored in AsyncLocalStorage) and
      // automatically discarded when the async context ends — no restore needed.

      // Only remove from activeTasks if this execution is still the latest one.
      // A newer execution for the same taskId bumps the generation counter;
      // stale finally blocks must not clear it.
      if (this.activeTaskGen.get(taskId) === execGen) {
        this.activeTasks.delete(taskId);
        this.activeTaskGen.delete(taskId);
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
   * no activeTasks tracking, no worktree setup).
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
    const emitDelta = (text: string) => {
      onLog({ seq: -1, type: 'text_delta', content: text, persist: false });
    };

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
      ...this.getTeamContextParams(),
    });

    const llmTools = this.buildToolDefinitions({ userMessage });
    const useCompaction = this.llmRouter.isCompactionSupported(this.getEffectiveProvider());
    let textBuffer = '';
    const flushText = () => {
      if (textBuffer.trim()) {
        emit('text', textBuffer);
        textBuffer = '';
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
          event => {
            if (event.type === 'text_delta' && event.text) {
              textBuffer += event.text;
              emitDelta(event.text);
            }
          },
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
          this.memory.appendMessage(sessionId, { role: 'assistant', content: response.content });
          this.memory.appendMessage(sessionId, {
            role: 'user',
            content: '[Continue from where you left off. Do not repeat what you already said.]',
          });
        } else {
          this.memory.appendMessage(sessionId, {
            role: 'assistant',
            content: response.content,
            toolCalls: response.toolCalls,
          });

          for (const tc of response.toolCalls!) {
            emit('tool_start', tc.name, { arguments: tc.arguments });
            const toolStart = Date.now();
            try {
              let result = await this.executeTool(tc);
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
            event => {
              if (event.type === 'text_delta' && event.text) {
                textBuffer += event.text;
                emitDelta(event.text);
              }
            },
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
      const finalReply = response.content;
      this.memory.appendMessage(sessionId, { role: 'assistant', content: finalReply });
      return finalReply;
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

  /**
   * Mark tool names as permanently activated so they appear in every LLM call.
   * Used by skill MCP integration to ensure skill-provided tools are always visible.
   */
  activateTools(names: string[]): void {
    for (const name of names) {
      this.activatedExtraTools.add(name);
    }
  }

  /**
   * Dynamically add a read-only path to this agent's access policy and rebuild tools.
   * Used when assigning review tasks so the reviewer can read the worker's worktree.
   */
  grantReadOnlyAccess(path: string): void {
    if (!this.pathPolicy) return;
    const existing = this.pathPolicy.readOnlyPaths ?? [];
    if (existing.includes(path)) return;
    this.pathPolicy = {
      ...this.pathPolicy,
      readOnlyPaths: [...existing, path],
    };
    // Rebuild file/search tools with updated policy
    const updatedTools = createBuiltinTools({
      agentId: this.id,
      workspacePath: this.pathPolicy.primaryWorkspace,
      pathPolicy: this.pathPolicy,
    });
    for (const tool of updatedTools) {
      this.tools.set(tool.name, tool);
    }
    log.info('Granted read-only access', { agentId: this.id, path });
  }

  /**
   * Remove a previously granted read-only path and rebuild tools.
   */
  revokeReadOnlyAccess(path: string): void {
    if (!this.pathPolicy?.readOnlyPaths) return;
    const filtered = this.pathPolicy.readOnlyPaths.filter(p => p !== path);
    this.pathPolicy = {
      ...this.pathPolicy,
      readOnlyPaths: filtered.length ? filtered : undefined,
    };
    const updatedTools = createBuiltinTools({
      agentId: this.id,
      workspacePath: this.pathPolicy.primaryWorkspace,
      pathPolicy: this.pathPolicy,
    });
    for (const tool of updatedTools) {
      this.tools.set(tool.name, tool);
    }
    log.info('Revoked read-only access', { agentId: this.id, path });
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

  private buildUserContent(text: string, images?: string[]): string | LLMContentPart[] {
    if (!images?.length) return text;
    const parts: LLMContentPart[] = [{ type: 'text', text }];
    for (const img of images) {
      parts.push({ type: 'image_url', image_url: { url: img } });
    }
    return parts;
  }

  private buildToolDefinitions(context?: {
    userMessage?: string;
    isTaskExecution?: boolean;
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
      skillCatalog: this.skillRegistry?.list(),
    });

    return tools;
  }

  /**
   * Handle the discover_tools meta-tool. Supports:
   * - mode="list_skills": list all available skills (prompt-based instruction packages, optionally with MCP tools)
   * - tool_names with skill names: activate skill by injecting its instructions and connecting its MCP servers
   * - tool_names with tool names: activate individual tools already registered on the agent
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
        message: `${catalog.length} skills available. Use discover_tools with tool_names to activate a skill (loads its instructions and MCP tools into your context).`,
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

    // Install a skill from a remote registry
    if (mode === 'install') {
      const skillName = args.name as string;
      if (!skillName) {
        return JSON.stringify({ status: 'error', message: 'name is required for install mode.' });
      }
      if (!this.skillInstaller) {
        return JSON.stringify({ status: 'error', message: 'Skill installation is not available.' });
      }
      try {
        const result = await this.skillInstaller(args);
        log.info('Skill installed via discover_tools', { agentId: this.id, skill: skillName, method: result.method });
        return JSON.stringify({
          status: 'ok',
          installed: result.name,
          method: result.method,
          message: `Skill "${result.name}" installed successfully. Use discover_tools({ tool_names: ["${result.name}"] }) to activate it.`,
        });
      } catch (err) {
        return JSON.stringify({ status: 'error', message: `Install failed: ${String(err instanceof Error ? err.message : err)}` });
      }
    }

    // mode === 'activate' (default)
    const requested = (args.tool_names as string[]) ?? [];
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

  private async executeTool(toolCall: LLMToolCall, onOutput?: ToolOutputCallback): Promise<string> {
    // Handle the discover_tools meta-tool: activate requested tools, skills, and skill MCP servers
    if (toolCall.name === 'discover_tools') {
      return await this.handleDiscoverTools(toolCall.arguments);
    }

    // Handle send_user_message: proactively send a message to the user
    if (toolCall.name === 'send_user_message') {
      const message = (toolCall.arguments.message as string) ?? '';
      if (!message) {
        return JSON.stringify({ status: 'error', message: 'message is required' });
      }
      if (!this.userMessageSender) {
        return JSON.stringify({ status: 'error', message: 'User messaging is not available.' });
      }
      try {
        const result = await this.userMessageSender(message);
        log.info('Proactive message sent to user', { agentId: this.id, sessionId: result.sessionId });
        return JSON.stringify({ status: 'ok', sessionId: result.sessionId, messageId: result.messageId });
      } catch (err) {
        return JSON.stringify({ status: 'error', message: `Failed to send message: ${String(err)}` });
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
        const approved = await this.approvalCallback({
          agentId: this.id,
          agentName: this.config.name,
          toolName: toolCall.name,
          toolArgs: toolCall.arguments,
          reason: `Agent wants to execute '${toolCall.name}'`,
        });
        if (!approved) {
          log.info(`Tool ${toolCall.name} execution denied by human`, { agentId: this.id });
          return JSON.stringify({
            status: 'denied',
            error: `Execution of '${toolCall.name}' was denied by human reviewer`,
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
    const effectiveArgs = beforeResult.modifiedArgs ?? toolCall.arguments;

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
      this.escalationCallback?.(
        this.id,
        `Agent ${this.config.name} needs help: ${reason} (${this.consecutiveFailures} consecutive failures)`
      );
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
          ? `**Today's activity log (${todayDate})**:\n\`\`\`\n${todayLog.slice(0, 3000)}\n\`\`\``
          : `**Today's activity log**: No activity recorded for ${todayDate}.`,
        '',
        '**Report format** — create a deliverable via `deliverable_create`:',
        `- **title**: "Daily Report — ${todayDate}"`,
        '- **type**: "file"',
        '- **Content must be concise, clear, and accurate**:',
        '  1. **My work today**: What you personally accomplished (tasks reviewed, approved/rejected, decisions made)',
        '  2. **Team progress**: What each team member accomplished today (cross-reference with activity log)',
        '  3. **Blockers & risks**: Anything stalled or at risk',
        '  4. **Plan for tomorrow**: Top priorities for the next day',
        '- Keep it under 500 words. No filler. Every sentence must carry information.',
        '- If no meaningful activity happened today, say so honestly — do not fabricate work.',
        '- The system will automatically mark the report as created after this heartbeat.',
        '',
      ].join('\n');
    }

    // --- Self-evolution reflection section (all agents) ---
    const selfEvolutionSection = [
      '',
      '## Self-Evolution Reflection',
      'Before finishing, briefly reflect on your recent work since the last heartbeat.',
      'Follow your **self-evolution** skill instructions. Check each layer:',
      '',
      '1. **Lessons** — Did anything go wrong or get corrected? Save with `memory_save` using `tags: ["lesson", ...]` and the `[LESSON]` format.',
      '2. **Tool preferences** — Did you discover a better tool or parameter for a task? Save with `tags: ["lesson", "tool-preference", ...]` and the `[TOOL-PREF]` format.',
      '3. **SOPs** — Did you repeat a multi-step workflow that should be standardized? Update `memory_update_longterm({ section: "sops", ... })`.',
      '4. **Role evolution** — Do you have 3+ related lessons pointing to a fundamental behavioral change? If so, consider updating your ROLE.md.',
      '',
      'Quality bar: Only record insights that are **specific**, **actionable**, and **non-obvious**.',
      'Skip if nothing meaningful happened since last heartbeat.',
    ].join('\n');

    const prompt = [
      '[HEARTBEAT CHECK-IN]',
      '',
      '## Your Checklist',
      checklist,
      lastHeartbeatSummary,
      failedTaskRecoverySection,
      dailyReportSection,
      selfEvolutionSection,
      '',
      '## Rules',
      '- Compare against your last heartbeat summary above. Skip unchanged items.',
      '- For routine checks: max 5 tool calls. This is monitoring, not a work session.',
      '- **Exception — review duty**: If you find tasks in `review` where you are the reviewer, you MUST review them now. Reviews may require more tool calls (task_get, file_read, task_note, task_update). Complete the review fully.',
      '- **Exception — failed tasks**: If you find tasks assigned to you in `failed` status, retry them via `task_update(status: "in_progress")` with a note.',
      '- **Exception — daily report**: If the Daily Report Required section is present above, you MUST produce the report. This may require additional tool calls.',
      '- At the end, call `memory_save` with key `heartbeat:summary` — one line per finding.',
      '- If nothing needs attention and no daily report is due, respond with exactly: HEARTBEAT_OK',
    ].join('\n');

    const baseTools = [
      'task_list', 'task_update', 'task_get', 'task_note',
      'file_read', 'file_edit', 'agent_send_message',
      'requirement_propose', 'requirement_list',
      'memory_save', 'memory_search', 'memory_update_longterm',
      'discover_tools', 'send_user_message',
    ];
    if (isManager) {
      baseTools.push(
        'task_board_health', 'task_cleanup_duplicates', 'task_assign',
        'team_status', 'deliverable_create', 'deliverable_search',
      );
    }
    const HEARTBEAT_ALLOWED_TOOLS = new Set(baseTools);

    const HEARTBEAT_MAX_RETRIES = 3;
    const HEARTBEAT_RETRY_BASE_MS = 3000;
    let lastError: unknown;

    for (let attempt = 0; attempt <= HEARTBEAT_MAX_RETRIES; attempt++) {
      try {
        const reply = await this.handleMessage(prompt, undefined, undefined, {
          ephemeral: true,
          maxHistory: 30,
          allowedTools: HEARTBEAT_ALLOWED_TOOLS,
          scenario: 'heartbeat',
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

        const isOk = reply?.trim() === 'HEARTBEAT_OK';
        if (reply && !isOk && reply.length > 20) {
          this.emitActivityLog(activityId, 'text', reply);
          this.memory.writeDailyLog(this.id, `[Heartbeat] ${reply}`);
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
        ephemeral: true,
        maxHistory: 25,
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

      // 1. Compact main session if it exists and is large
      if (this.currentSessionId) {
        const session = this.memory.getSession(this.currentSessionId);
        if (session && session.messages.length > 30) {
          await this.memoryFlush(this.currentSessionId);
          const { flushedCount } = this.memory.compactSession(this.currentSessionId, 15);
          if (flushedCount > 0) {
            log.info('Memory consolidation: compacted main session', {
              agentId: this.id,
              flushedCount,
              remaining: session.messages.length,
            });
          }
        }
      }

      // 2. Memory dream: prune, deduplicate, merge — once per day when entries are large
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

    const prompt = [
      '[MEMORY CONSOLIDATION — Dream Cycle]',
      '',
      `You have ${batch.length} memory entries${truncated ? ` (showing most recent ${MAX_ENTRIES_FOR_LLM} of ${entries.length} total)` : ''}. Review them and identify:`,
      '1. **Duplicates**: entries saying essentially the same thing',
      '2. **Outdated**: entries superseded by newer information',
      '3. **Merge candidates**: multiple entries about the same topic that can be combined',
      '',
      'Respond with ONLY a JSON object (no markdown fences):',
      '{',
      '  "remove": ["id1", "id2"],       // IDs to delete (duplicates, outdated)',
      '  "merge": [                       // groups to merge into single entries',
      '    { "removeIds": ["id3", "id4"], "mergedContent": "combined text", "tags": ["tag1"] }',
      '  ]',
      '}',
      '',
      'Rules:',
      '- Be conservative. Only remove entries you are confident are redundant or outdated.',
      '- When merging, preserve all unique information from the originals.',
      '- If nothing needs consolidation, return { "remove": [], "merge": [] }',
      '- Keep lessons and best-practices entries unless truly duplicated.',
      '',
      '## Current Memory Entries',
      '',
      entryList,
    ].join('\n');

    try {
      const response = await this.handleMessage(prompt, undefined, undefined, {
        ephemeral: true,
        maxHistory: 5,
      });

      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        log.debug('Dream cycle: no valid JSON in response, skipping');
        return;
      }

      const plan = JSON.parse(jsonMatch[0]) as {
        remove?: string[];
        merge?: Array<{ removeIds: string[]; mergedContent: string; tags?: string[] }>;
      };

      log.info('Dream cycle plan', {
        agentId: this.id,
        toRemove: plan.remove?.length ?? 0,
        toMerge: plan.merge?.length ?? 0,
        removeIds: plan.remove?.slice(0, 10),
        mergeGroups: plan.merge?.map(g => ({ removeIds: g.removeIds, contentPreview: g.mergedContent.slice(0, 80) })).slice(0, 5),
      });

      let removedCount = 0;
      let mergedCount = 0;

      if (plan.remove?.length) {
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

      if (removedCount > 0 || mergedCount > 0) {
        log.info('Dream cycle completed', {
          agentId: this.id,
          entriesBefore: entries.length,
          removed: removedCount,
          merged: mergedCount,
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
