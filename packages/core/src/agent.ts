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
import type { IMemoryStore } from './memory/types.js';
import { EnhancedMemorySystem } from './enhanced-memory-system.js';
import { AgentMetricsCollector, type AgentMetricsSnapshot } from './agent-metrics.js';
import { ContextEngine, type OrgContext } from './context-engine.js';
import { detectEnvironment, type EnvironmentProfile } from './environment-profile.js';
import { ToolSelector } from './tool-selector.js';
import type { SkillRegistry } from './skills/types.js';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createBuiltinTools } from './tools/builtin.js';
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
    iteration?: { id: string; name: string; goal?: string; status: string; endDate?: string };
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
  private pathPolicy?: PathAccessPolicy;
  private skillRegistry?: SkillRegistry;
  private toolSelector: ToolSelector;
  private guardrails: GuardrailPipeline;
  private toolHooks: ToolHookRegistry;
  private recentToolNames: string[] = [];
  private activatedExtraTools = new Set<string>(); // tools activated via discover_tools
  private activatedSkillInstructions = new Map<string, string>(); // skill instructions injected into context
  private currentSessionId?: string;
  private orgContext?: OrgContext;
  private contextMdPath?: string;
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
  /** In-memory activity log buffer (keyed by activity ID) */
  private activityLogs = new Map<string, AgentActivityLogEntry[]>();
  private activitySeqCounters = new Map<string, number>();
  private dynamicContextProviders: Array<() => string> = [];
  private static readonly MAX_ACTIVITY_LOG_ENTRIES = 200;
  private static readonly MAX_ACTIVITY_LOGS_KEPT = 10;
  private static readonly MAX_CONCURRENT_TASKS = 5;
  private static readonly MAX_CONSECUTIVE_FAILURES = 3;
  private static readonly TOOL_RETRY_MAX = 2;
  private static readonly TOOL_RETRY_BASE_MS = 500;
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
   * Manus-inspired: offload large tool results to filesystem.
   * Keeps a compact reference in context, full data in a file the agent can re-read.
   * This prevents context bloat while preserving all information (restorable compression).
   */
  private offloadLargeResult(toolName: string, result: string): string {
    const OFFLOAD_THRESHOLD = 50_000;
    if (result.length <= OFFLOAD_THRESHOLD) return result;

    try {
      const offloadDir = join(this.dataDir, 'tool-outputs');
      mkdirSync(offloadDir, { recursive: true });
      const filename = `${toolName}_${++this.toolResultCounter}_${Date.now()}.txt`;
      const filepath = join(offloadDir, filename);
      writeFileSync(filepath, result);

      const PREVIEW_SIZE = 2000;
      const preview = result.slice(0, PREVIEW_SIZE);
      const lineCount = result.split('\n').length;
      return [
        `[FULL output (${result.length} chars, ${lineCount} lines) saved to: ${filepath}]`,
        `[NOTE: The content below is only the first ${PREVIEW_SIZE} chars. The complete, untruncated result is in the file above. Use file_read to access it if you need more.]`,
        ``,
        preview,
        ``,
        `[... remaining ${result.length - PREVIEW_SIZE} chars in file ...]`,
      ].join('\n');
    } catch {
      return result.slice(0, 8000) + `\n\n[... output truncated at 8000 of ${result.length} total chars due to file-save failure ...]`;
    }
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

  setIdentityContext(ctx: IdentityContext): void {
    this.identityContext = ctx;
  }

  addDynamicContextProvider(provider: () => string): void {
    this.dynamicContextProviders.push(provider);
  }

  injectSkillInstructions(skillName: string, instructions: string): void {
    this.activatedSkillInstructions.set(skillName, instructions);
  }

  private getDynamicContext(): string | undefined {
    const parts = this.dynamicContextProviders.map(p => p()).filter(Boolean);
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

  // ─── Activity Tracking ───────────────────────────────────────────────────────

  private startActivity(type: AgentActivity['type'], label: string, extra?: Partial<AgentActivity>): string {
    const id = `act-${this.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.state.currentActivity = { id, type, label, startedAt: new Date().toISOString(), ...extra };
    this.activityLogs.set(id, []);
    this.activitySeqCounters.set(id, 0);

    // Prune old activity logs if too many
    if (this.activityLogs.size > Agent.MAX_ACTIVITY_LOGS_KEPT) {
      const keys = [...this.activityLogs.keys()];
      for (let i = 0; i < keys.length - Agent.MAX_ACTIVITY_LOGS_KEPT; i++) {
        this.activityLogs.delete(keys[i]);
        this.activitySeqCounters.delete(keys[i]);
      }
    }

    this.emitActivityLog(id, 'status', `Started: ${label}`);
    this.notifyStateChange();
    return id;
  }

  private endActivity(activityId?: string): void {
    const aid = activityId ?? this.state.currentActivity?.id;
    if (aid) {
      this.emitActivityLog(aid, 'status', 'Completed');
    }
    this.state.currentActivity = undefined;
    this.notifyStateChange();
  }

  private emitActivityLog(activityId: string, type: AgentActivityLogEntry['type'], content: string, metadata?: Record<string, unknown>): void {
    const logs = this.activityLogs.get(activityId);
    if (!logs) return;

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

  /** Return summary of recent in-memory activities (heartbeat, chat, task) */
  getRecentActivities(): Array<{
    id: string;
    type: 'task' | 'heartbeat' | 'chat';
    label: string;
    taskId?: string;
    heartbeatName?: string;
    startedAt: string;
    logCount: number;
  }> {
    const result: Array<{
      id: string;
      type: 'task' | 'heartbeat' | 'chat';
      label: string;
      taskId?: string;
      heartbeatName?: string;
      startedAt: string;
      logCount: number;
    }> = [];

    for (const [actId, logs] of this.activityLogs.entries()) {
      // Parse metadata from activity ID: act-<agentId>-<timestamp>-<rand>
      const parts = actId.split('-');
      const tsStr = parts.length >= 3 ? parts[parts.length - 2] : undefined;
      const startedAt = tsStr && /^\d+$/.test(tsStr) ? new Date(Number(tsStr)).toISOString() : new Date().toISOString();

      // Infer type and label from the first "Started:" log entry
      let type: 'task' | 'heartbeat' | 'chat' = 'chat';
      let label = actId;
      let taskId: string | undefined;
      let heartbeatName: string | undefined;

      const startLog = logs.find(l => l.type === 'status' && l.content.startsWith('Started:'));
      if (startLog) {
        label = startLog.content.replace('Started: ', '');
        if (label.startsWith('Heartbeat:')) {
          type = 'heartbeat';
          heartbeatName = label.replace('Heartbeat: ', '').trim();
        } else if (label.startsWith('A2A:') || label.startsWith('Chat with')) {
          type = 'chat';
        } else {
          type = 'task';
        }
      }

      // Check if this is the current activity (has richer metadata)
      const current = this.state.currentActivity;
      if (current && current.id === actId) {
        type = current.type;
        label = current.label;
        taskId = current.taskId;
        heartbeatName = current.heartbeatName;
      }

      result.push({ id: actId, type, label, taskId, heartbeatName, startedAt, logCount: logs.length });
    }

    // Newest first
    return result.reverse();
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
      });
      this.memory.addLongTermMemory(
        `daily-report-${new Date().toISOString().split('T')[0]}`,
        report
      );
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
      maxHistory?: number;
      channelContext?: Array<{ role: string; content: string }>;
      images?: string[];
      allowedTools?: Set<string>;
      scenario?: 'chat' | 'task_execution' | 'heartbeat' | 'a2a';
    }
  ): Promise<string> {
    if (this.activeTasks.size === 0) {
      this.setStatus('working');
    }

    // Track chat activity (only if not already in a heartbeat or other activity)
    const isEphemeral = options?.ephemeral ?? false;
    let chatActivityId: string | undefined;
    if (!this.state.currentActivity) {
      const senderLabel = senderInfo?.name ?? senderId ?? 'user';
      const activityLabel = isEphemeral && senderId ? `A2A: Chat with ${senderLabel}` : `Chat with ${senderLabel}`;
      chatActivityId = this.startActivity('chat', activityLabel);
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

    // Ephemeral mode: don't pollute the agent's main session with channel messages.
    // Use a minimal context with only channel history provided by the caller.
    let sessionId: string;
    if (isEphemeral) {
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
      knowledgeContext: isEphemeral ? undefined : this.getKnowledgeContext(effectiveMessage),
      environment: this.environmentProfile,
      scenario,
      agentWorkspace: this.pathPolicy ? {
        primaryWorkspace: this.pathPolicy.primaryWorkspace,
        sharedWorkspace: this.pathPolicy.sharedWorkspace,
      } : undefined,
      dynamicContext: this.getDynamicContext(),
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
      messages = this.contextEngine.prepareMessages({
        systemPrompt,
        sessionMessages,
        memory: this.memory,
        sessionId,
        modelContextWindow: this.llmRouter.getActiveModelContextWindow(),
        modelMaxOutput: this.llmRouter.getActiveModelMaxOutput(),
        toolDefinitions: llmTools,
      });
    }

    try {
      const llmStart = Date.now();
      let response = await this.llmRouter.chat({
        messages,
        tools: llmTools.length > 0 ? llmTools : undefined,
      }, this.getEffectiveProvider());

      const tokensThisCall = response.usage.inputTokens + response.usage.outputTokens;
      this.updateTokensUsed(tokensThisCall);
      this.emitAudit({
        type: 'llm_request',
        action: 'chat',
        tokensUsed: tokensThisCall,
        durationMs: Date.now() - llmStart,
        success: true,
      });

      const MAX_TOOL_ITERATIONS = 25;
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
                this.emitActivityLog(currentActId, 'tool_start', tc.name, { args: JSON.stringify(tc.arguments) });
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
                  detail: JSON.stringify(tc.arguments).slice(0, 200),
                });
                if (currentActId) {
                  this.emitActivityLog(currentActId, 'tool_end', tc.name, {
                    durationMs: Date.now() - toolStart,
                    success: !isToolError,
                    result,
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
                  detail: String(toolErr).slice(0, 200),
                });
                if (currentActId) {
                  this.emitActivityLog(currentActId, 'error', `Tool ${tc.name} failed: ${String(toolErr)}`);
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
          updatedMessages = messages;
        } else {
          const updatedSessionMessages = this.memory.getRecentMessages(sessionId, maxHistory);
          updatedMessages = this.contextEngine.prepareMessages({
            systemPrompt,
            sessionMessages: updatedSessionMessages,
            memory: this.memory,
            sessionId,
            modelContextWindow: this.llmRouter.getActiveModelContextWindow(),
            modelMaxOutput: this.llmRouter.getActiveModelMaxOutput(),
            toolDefinitions: llmTools,
          });
        }

        const llmStart2 = Date.now();
        response = await this.llmRouter.chat({
          messages: updatedMessages,
          tools: llmTools.length > 0 ? llmTools : undefined,
        }, this.getEffectiveProvider());

        const tokens2 = response.usage.inputTokens + response.usage.outputTokens;
        this.updateTokensUsed(tokens2);
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

      if (this.activeTasks.size === 0) this.setStatus('error', String(error).slice(0, 500));
      this.emitAudit({
        type: 'error',
        action: 'handle_message',
        success: false,
        detail: String(error).slice(0, 200),
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
      knowledgeContext: this.getKnowledgeContext(effectiveMessage),
      environment: this.environmentProfile,
      scenario: 'chat',
      agentWorkspace: this.pathPolicy ? {
        primaryWorkspace: this.pathPolicy.primaryWorkspace,
        sharedWorkspace: this.pathPolicy.sharedWorkspace,
      } : undefined,
      dynamicContext: this.getDynamicContext(),
    });

    const llmTools = this.buildToolDefinitions({ userMessage: effectiveMessage });

    const sessionMessages = this.memory.getRecentMessages(this.currentSessionId, 200);
    const messages = this.contextEngine.prepareMessages({
      systemPrompt,
      sessionMessages,
      memory: this.memory,
      sessionId: this.currentSessionId,
      modelContextWindow: this.llmRouter.getActiveModelContextWindow(),
      modelMaxOutput: this.llmRouter.getActiveModelMaxOutput(),
      toolDefinitions: llmTools,
    });

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
      let response = await this.llmRouter.chatStream(
        { messages, tools: llmTools.length > 0 ? llmTools : undefined },
        onEvent,
        this.getEffectiveProvider(),
        abortController.signal,
      );
      const tokensThisCall = response.usage.inputTokens + response.usage.outputTokens;
      this.updateTokensUsed(tokensThisCall);
      lastResponseContent = response.content || '';
      this.emitAudit({
        type: 'llm_request',
        action: 'chat_stream',
        tokensUsed: tokensThisCall,
        durationMs: Date.now() - llmStart,
        success: true,
      });

      const MAX_STREAM_TOOL_ITERATIONS = 25;
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
          if (streamChatActivityId) this.endActivity(streamChatActivityId);
          if (this.activeTasks.size === 0) this.setStatus('idle');
          return response.content || '';
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
                  detail: JSON.stringify(tc.arguments).slice(0, 200),
                });
                onEvent({ type: 'agent_tool', tool: tc.name, phase: 'end', success: !isToolError, arguments: tc.arguments, result: result.slice(0, 2000), durationMs });
                return { toolCallId: tc.id, content: result };
              } catch (toolErr) {
                const durationMs = Date.now() - toolStart;
                this.emitAudit({
                  type: 'tool_call',
                  action: tc.name,
                  durationMs,
                  success: false,
                  detail: String(toolErr).slice(0, 200),
                });
                onEvent({ type: 'agent_tool', tool: tc.name, phase: 'end', success: false, arguments: tc.arguments, error: String(toolErr).slice(0, 500), durationMs });
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
        }

        const updatedSessionMessages = this.memory.getRecentMessages(this.currentSessionId, 200);
        const updatedMessages = this.contextEngine.prepareMessages({
          systemPrompt,
          sessionMessages: updatedSessionMessages,
          memory: this.memory,
          sessionId: this.currentSessionId,
          modelContextWindow: this.llmRouter.getActiveModelContextWindow(),
          modelMaxOutput: this.llmRouter.getActiveModelMaxOutput(),
          toolDefinitions: llmTools,
        });

        if (cancelToken?.cancelled) {
          log.info('Stream cancelled before LLM re-call', { agentId: this.id });
          if (streamChatActivityId) this.endActivity(streamChatActivityId);
          if (this.activeTasks.size === 0) this.setStatus('idle');
          return response.content || '';
        }

        const llmStart2 = Date.now();
        response = await this.llmRouter.chatStream(
          { messages: updatedMessages, tools: llmTools.length > 0 ? llmTools : undefined },
          onEvent,
          this.getEffectiveProvider(),
          abortController.signal,
        );
        const tokens2 = response.usage.inputTokens + response.usage.outputTokens;
        this.updateTokensUsed(tokens2);
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
      if (streamChatActivityId) this.endActivity(streamChatActivityId);
      // If abort was triggered by cancel, treat as cancellation not error
      // Preserve partial content from the last successful response
      if (cancelToken?.cancelled) {
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

      if (this.activeTasks.size === 0) this.setStatus('error', String(error).slice(0, 500));
      this.emitAudit({
        type: 'error',
        action: 'handle_message_stream',
        success: false,
        detail: String(error).slice(0, 200),
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
    taskWorkspace?: TaskWorkspace
  ): Promise<void> {
    return this.executeTaskConcurrent(taskId, description, onLog, cancelToken, undefined, taskWorkspace);
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
    taskWorkspace?: TaskWorkspace
  ): Promise<void> {
    if (!this.taskExecutor) {
      throw new Error('Task executor not initialized');
    }

    // 使用TaskExecutor执行任务
    const result = await this.taskExecutor.executeTaskTask(
      taskId,
      async () => {
        return this._executeTaskInternal(taskId, description, onLog, cancelToken, taskWorkspace);
      },
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
    taskWorkspace?: TaskWorkspace
  ): Promise<void> {
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
    // Track task activity for UI visibility
    const taskActId = this.startActivity('task', description.slice(0, 100), { taskId });
    this.notifyStateChange();
    const taskStartMs = Date.now();
    let taskFailed = '';

    let seq = 0;
    let submittedForReview = false;
    const emit = (type: string, content: string, metadata?: unknown) => {
      onLog({ seq: seq++, type, content, metadata, persist: true });
    };
    const emitDelta = (text: string) => {
      // text_delta: real-time streaming, not persisted individually
      onLog({ seq: -1, type: 'text_delta', content: text, persist: false });
    };

    emit('status', 'started', { agentId: this.id, agentName: this.config.name });

    // Rebind tools to worktree path for project-bound tasks
    let savedTools: Map<string, AgentToolHandler> | undefined;
    if (taskWorkspace) {
      savedTools = new Map(this.tools);
      // Build a worktree-specific path policy inheriting shared workspace and adding
      // the project repo as read-only (for referencing the base branch)
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
      for (const tool of worktreeTools) {
        this.tools.set(tool.name, tool);
      }
      log.info('Tools rebound to worktree workspace', {
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

    // Isolated session for this task — does NOT share with chat session
    const session = this.memory.createSession(this.id);
    const sessionId = session.id;

    const isResume = description.startsWith('## Previous Execution History');
    const taskPrompt = [
      `[TASK EXECUTION — Task ID: ${taskId}]`,
      '',
      description,
      '',
      isResume
        ? 'Review the previous execution history above, then continue and complete the remaining work. Skip steps already marked as completed (✓).\nIf this task has dependency tasks listed, review their notes and deliverables — they contain context and artifacts essential for your work.'
        : 'Execute this task completely using your available tools. When done, provide a concise summary of what was accomplished.\nIf this task has dependency tasks listed above, review their notes and deliverables first — they contain context and artifacts essential for your work.',
      '',
      '## Completion Requirements',
      'Before calling task_submit_review, you MUST update the task notes using task_update with a detailed note that includes:',
      '1. Key conclusions and results of your work',
      '2. File paths of all deliverables and artifacts you created or modified',
      '3. Any important decisions made and their rationale',
      '4. Known limitations or follow-up items',
      'This note serves as a permanent record for reviewers, other agents, and future reference.',
      '',
      '## File Deliverables',
      'When calling task_submit_review, you MUST include all file artifacts you created or modified in the `deliverables` parameter.',
      'Each deliverable is an object with `path` (absolute file path, string) and `summary` (brief description, string).',
      'Example tool call:',
      '```',
      'task_submit_review({',
      '  "task_id": "tsk_abc",',
      '  "summary": "Created the marketing copy as requested.",',
      '  "deliverables": [',
      '    { "path": "/home/user/.markus/workspace/output.md", "summary": "Final marketing copy document" },',
      '    { "path": "/home/user/.markus/workspace/research.md", "summary": "Background research notes" }',
      '  ]',
      '})',
      '```',
      'IMPORTANT: `deliverables` must be a JSON array of objects. Each object MUST have both `path` and `summary` as non-empty strings.',
      'Do NOT pass file paths as plain strings — always wrap them in objects with both fields.',
      '',
      '## Knowledge Contribution',
      'Before submitting, review what you learned during this task. If you discovered any of the following, use `knowledge_contribute` to share with the team:',
      '- Architectural decisions or patterns worth documenting',
      '- Coding conventions or best practices established',
      '- Gotchas, pitfalls, or troubleshooting steps that would save others time',
      '- API details, integration notes, or dependency quirks',
      'This is how your team builds collective intelligence. Skip if nothing novel was learned.',
    ].join('\n');

    this.memory.appendMessage(sessionId, { role: 'user', content: taskPrompt });

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
      knowledgeContext: this.getKnowledgeContext(taskPrompt),
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
      } : undefined,
      dynamicContext: this.getDynamicContext(),
    });

    const llmTools = this.buildToolDefinitions({ userMessage: taskPrompt, isTaskExecution: true });
    let textBuffer = '';

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

      const messages = this.contextEngine.prepareMessages({
        systemPrompt,
        sessionMessages: this.memory.getRecentMessages(sessionId, 200),
        memory: this.memory,
        sessionId,
        modelContextWindow: this.llmRouter.getActiveModelContextWindow(),
        modelMaxOutput: this.llmRouter.getActiveModelMaxOutput(),
        toolDefinitions: llmTools,
      });

      let response = await this.llmRouter.chatStream(
        { messages, tools: llmTools.length > 0 ? llmTools : undefined },
        event => {
          if (event.type === 'text_delta' && event.text) {
            textBuffer += event.text;
            emitDelta(event.text);
          }
        },
        this.getEffectiveProvider(),
        abortController.signal,
      );
      this.updateTokensUsed(response.usage.inputTokens + response.usage.outputTokens);

      while (response.finishReason === 'tool_use' && response.toolCalls?.length) {
        if (cancelToken?.cancelled) {
          flushText();
          emit('status', 'cancelled', { reason: 'Task execution was stopped externally' });
          log.info('Task execution cancelled externally', { taskId, agentId: this.id });
          return;
        }

        flushText();

        this.memory.appendMessage(sessionId, {
          role: 'assistant',
          content: response.content,
          toolCalls: response.toolCalls,
        });

        for (const tc of response.toolCalls) {
          if (cancelToken?.cancelled) break;
          emit('tool_start', tc.name, { arguments: tc.arguments });
          const toolStart = Date.now();
          try {
            const result = await this.executeTool(tc);
            const isErr = isErrorResult(result);
            const durationMs = Date.now() - toolStart;
            if (tc.name === 'task_submit_review' && !isErr) {
              submittedForReview = true;
            }
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

        if (cancelToken?.cancelled) {
          emit('status', 'cancelled', { reason: 'Task execution was stopped externally' });
          log.info('Task execution cancelled externally after tools', { taskId, agentId: this.id });
          return;
        }

        response = await this.llmRouter.chatStream(
          {
            messages: this.contextEngine.prepareMessages({
              systemPrompt,
              sessionMessages: this.memory.getRecentMessages(sessionId, 200),
              memory: this.memory,
              sessionId,
              modelContextWindow: this.llmRouter.getActiveModelContextWindow(),
              modelMaxOutput: this.llmRouter.getActiveModelMaxOutput(),
              toolDefinitions: llmTools,
            }),
            tools: llmTools.length > 0 ? llmTools : undefined,
          },
          event => {
            if (event.type === 'text_delta' && event.text) {
              textBuffer += event.text;
              emitDelta(event.text);
            }
          },
          this.getEffectiveProvider(),
          abortController.signal,
        );
        this.updateTokensUsed(response.usage.inputTokens + response.usage.outputTokens);
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
      if (submittedForReview) {
        emit('status', 'execution_finished', { submittedForReview: true });
        this.metricsCollector.recordTaskCompletion(taskId, 'completed', Date.now() - taskStartMs);
        log.info('Task execution finished (submitted for review)', { taskId, agentId: this.id });
      } else {
        emit('status', 'completed');
        this.metricsCollector.recordTaskCompletion(taskId, 'completed', Date.now() - taskStartMs);
        this.eventBus.emit('task:completed', { taskId, agentId: this.id });
        log.info('Task execution completed', { taskId, agentId: this.id });
      }
    } catch (error) {
      // If abort was triggered by cancel, treat as cancellation not error
      if (cancelToken?.cancelled) {
        flushText();
        emit('status', 'cancelled', { reason: 'Task execution was stopped externally' });
        log.info('Task execution cancelled (caught abort)', { taskId, agentId: this.id });
        return;
      }
      flushText();
      emit('error', String(error));
      this.metricsCollector.recordTaskCompletion(taskId, 'failed', Date.now() - taskStartMs);
      this.emitAudit({
        type: 'error',
        action: 'execute_task',
        success: false,
        detail: String(error).slice(0, 200),
      });
      log.error('Task execution failed', { taskId, agentId: this.id, error: String(error) });
      this.eventBus.emit('task:failed', { taskId, agentId: this.id, error: String(error) });
      taskFailed = String(error).slice(0, 500);
      throw error;
    } finally {
      if (cancelPollTimer) clearInterval(cancelPollTimer);

      // Restore original tools if they were rebound for a worktree
      if (savedTools) {
        this.tools = savedTools;
        log.info('Tools restored to agent default workspace', { taskId, agentId: this.id });
      }

      this.activeTasks.delete(taskId);
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

  private getKnowledgeContext(query?: string): string | undefined {
    if (this.memory instanceof EnhancedMemorySystem) {
      return this.memory.getAgentContext(this.id, query) || undefined;
    }
    return undefined;
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

    const tools = this.toolSelector.selectTools({
      allTools: this.tools,
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
   * - mode="list_skills": list all available skills (prompt-based instruction packages)
   * - tool_names with skill names: activate skill by injecting its instructions into context
   * - tool_names with tool names: activate individual tools already registered on the agent
   */
  private handleDiscoverTools(args: Record<string, unknown>): string {
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
      }));
      return JSON.stringify({
        status: 'ok',
        skills: catalog,
        message: `${catalog.length} skills available. Use discover_tools with tool_names to activate a skill (loads its instructions into your context).`,
      });
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

      // 2. Check if it's a skill name in the registry -- inject instructions
      if (this.skillRegistry) {
        const skill = this.skillRegistry.get(name);
        if (skill) {
          if (skill.manifest.instructions) {
            this.activatedSkillInstructions.set(name, skill.manifest.instructions);
            activated.push(`${name} (skill instructions loaded)`);
            log.info('Skill instructions activated via discover_tools', {
              agentId: this.id, skill: name,
            });
          } else {
            activated.push(`${name} (skill found but has no instructions)`);
          }
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
    // Handle the discover_tools meta-tool: activate requested tools and skills
    if (toolCall.name === 'discover_tools') {
      return this.handleDiscoverTools(toolCall.arguments);
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

    const handler = this.tools.get(toolCall.name);
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

  private async handleHeartbeat(ctx: {
    agentId: string;
    triggeredAt: string;
  }): Promise<void> {
    if (this.state.status === 'working' || this.activeTasks.size > 0) {
      log.debug('Skipping heartbeat — agent is busy', {
        activeTasks: this.activeTasks.size,
      });
      return;
    }

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

    const prompt = [
      '[HEARTBEAT CHECK-IN]',
      '',
      '## Your Checklist',
      checklist,
      lastHeartbeatSummary,
      '## Rules',
      '- Compare against your last heartbeat summary above. Skip unchanged items.',
      '- Max 5 tool calls. This is monitoring, not a work session.',
      '- At the end, call `memory_save` with key `heartbeat:summary` — one line per finding.',
      '- If nothing needs attention, respond with exactly: HEARTBEAT_OK',
    ].join('\n');

    const baseTools = [
      'task_list', 'task_update', 'requirement_propose', 'requirement_list',
      'memory_save', 'memory_search', 'discover_tools',
    ];
    if (this.config.agentRole === 'manager') {
      baseTools.push('task_board_health', 'task_cleanup_duplicates', 'task_assign');
    }
    const HEARTBEAT_ALLOWED_TOOLS = new Set(baseTools);

    try {
      const reply = await this.handleMessage(prompt, undefined, undefined, {
        ephemeral: true,
        maxHistory: 10,
        allowedTools: HEARTBEAT_ALLOWED_TOOLS,
        scenario: 'heartbeat',
      });
      this.state.lastHeartbeat = new Date().toISOString();
      this.metricsCollector.recordHeartbeat(true);

      const isOk = reply?.trim() === 'HEARTBEAT_OK';
      if (reply && !isOk && reply.length > 20) {
        this.emitActivityLog(activityId, 'text', reply);
        this.memory.writeDailyLog(this.id, `[Heartbeat] ${reply}`);
      }
      this.endActivity(activityId);
    } catch (error) {
      this.emitActivityLog(activityId, 'error', String(error));
      this.endActivity(activityId);
      this.metricsCollector.recordHeartbeat(false);
      log.error('Heartbeat failed', { error: String(error) });
    }
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
      });
      log.info('Memory flush completed before compaction', { agentId: this.id, sessionId });
    } catch (error) {
      log.warn('Memory flush failed, proceeding with compaction anyway', { error: String(error) });
    }
  }

  /**
   * Periodic memory consolidation:
   * 1. Compact main session if it has grown large
   * 2. Generate daily report (writes to MEMORY.md long-term store)
   * 3. Log the consolidation activity
   */
  private async consolidateMemory(): Promise<void> {
    try {
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

      // 2. Auto-generate daily report once per day
      const today = new Date().toISOString().slice(0, 10);
      const existingLongTerm = this.memory.getLongTermMemory();
      if (!existingLongTerm.includes(`daily-report-${today}`)) {
        this.generateDailyReport().catch(e =>
          log.warn('Auto daily report generation failed', { error: String(e) })
        );
      }

      log.debug('Memory consolidation completed', { agentId: this.id });
    } catch (error) {
      log.warn('Memory consolidation failed', { agentId: this.id, error: String(error) });
    }
  }
}
