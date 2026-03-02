import type {
  AgentConfig,
  AgentState,
  RoleTemplate,
  LLMMessage,
  LLMTool,
  LLMToolCall,
  LLMStreamEvent,
  IdentityContext,
} from '@markus/shared';
import { createLogger, agentId as genAgentId } from '@markus/shared';
import { EventBus } from './events.js';
import { HeartbeatScheduler } from './heartbeat.js';
import { LLMRouter } from './llm/router.js';
import { MemoryStore } from './memory/store.js';
import { ContextEngine, type OrgContext } from './context-engine.js';
import { TaskExecutor, AgentStateManager } from './concurrent/index.js';
import { TaskPriority, TaskType, TaskStatus } from './concurrent/task-queue.js';

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

export interface AgentToolHandler {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<string>;
}

export interface SandboxHandle {
  exec(command: string, options?: { cwd?: string; timeoutMs?: number }): Promise<{ exitCode?: number; stdout: string; stderr: string }>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
  stop(): Promise<void>;
  destroy(): Promise<void>;
}

export interface AgentOptions {
  config: AgentConfig;
  role: RoleTemplate;
  llmRouter: LLMRouter;
  dataDir: string;
  tools?: AgentToolHandler[];
  sandbox?: SandboxHandle;
  orgContext?: OrgContext;
  contextMdPath?: string;
}

export class Agent {
  readonly id: string;
  readonly config: AgentConfig;
  readonly role: RoleTemplate;

  private state: AgentState;
  private eventBus: EventBus;
  private heartbeat: HeartbeatScheduler;
  private llmRouter: LLMRouter;
  private memory: MemoryStore;
  private contextEngine: ContextEngine;
  private tools: Map<string, AgentToolHandler>;
  private currentSessionId?: string;
  private sandbox?: SandboxHandle;
  private orgContext?: OrgContext;
  private contextMdPath?: string;
  private identityContext?: IdentityContext;
  private auditCallback?: (event: { type: string; action: string; tokensUsed?: number; durationMs?: number; success: boolean; detail?: string }) => void;
  private escalationCallback?: (agentId: string, reason: string) => void;
  private tasksFetcher?: () => Array<{ id: string; title: string; description: string; status: string; priority: string }>;
  private consecutiveFailures = 0;
  /** Tracks concurrently executing task IDs */
  private activeTasks = new Set<string>();
  /** Task executor for concurrent task management */
  private taskExecutor?: TaskExecutor;
  /** State manager for synchronizing task and agent states */
  private stateManager?: AgentStateManager;
  private static readonly MAX_CONCURRENT_TASKS = 5;
  private static readonly MAX_CONSECUTIVE_FAILURES = 3;
  private static readonly TOOL_RETRY_MAX = 2;
  private static readonly TOOL_RETRY_BASE_MS = 500;

  constructor(options: AgentOptions) {
    this.id = options.config.id || genAgentId();
    this.config = { ...options.config, id: this.id };
    this.role = options.role;
    this.llmRouter = options.llmRouter;
    this.sandbox = options.sandbox;
    this.orgContext = options.orgContext;
    this.contextMdPath = options.contextMdPath;

    this.state = {
      agentId: this.id,
      status: 'idle',
      activeTaskCount: 0,
      activeTaskIds: [],
      tokensUsedToday: 0,
    };

    this.eventBus = new EventBus();
    this.memory = new MemoryStore(options.dataDir);
    this.contextEngine = new ContextEngine();
    this.heartbeat = new HeartbeatScheduler(
      this.id,
      this.eventBus,
      this.config.heartbeatIntervalMs,
    );

    this.tools = new Map();
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

    // If sandbox is provided, replace shell/file tools with sandboxed versions
    if (this.sandbox) {
      this.registerSandboxedTools(this.sandbox);
    }

    this.eventBus.on('heartbeat:trigger', (ctx) => {
      this.handleHeartbeat(ctx as { agentId: string; task: { name: string; description: string }; triggeredAt: string }).catch((e) =>
        log.error('Heartbeat handler failed', { error: String(e) }),
      );
    });

    log.info(`Agent created: ${this.id}`, { name: this.config.name, role: this.role.name });
  }

  /**
   * Set agent status and emit status change event
   */
  private setStatus(status: AgentState['status']): void {
    const oldStatus = this.state.status;
    if (oldStatus === status) return;
    
    this.state.status = status;
    
    // 同步状态到stateManager
    if (this.stateManager) {
      this.stateManager.updateState({ status });
    }
    
    this.eventBus.emit('agent:status-changed', {
      agentId: this.id,
      oldStatus,
      newStatus: status,
      state: this.getState(),
    });
  }

  async start(): Promise<void> {
    this.setStatus('idle');

    // Resume latest conversation session if available
    const latestSession = this.memory.getLatestSession(this.id);
    if (latestSession && latestSession.messages.length > 0) {
      this.currentSessionId = latestSession.id;
      log.info(`Resumed session ${latestSession.id} with ${latestSession.messages.length} messages`);
    }

    this.heartbeat.start(this.role.defaultHeartbeatTasks);
    this.eventBus.emit('agent:started', { agentId: this.id });
    log.info(`Agent started: ${this.config.name}`);
  }

  async stop(): Promise<void> {
    this.heartbeat.stop();
    this.setStatus('offline');
    this.eventBus.emit('agent:stopped', { agentId: this.id });
    log.info(`Agent stopped: ${this.config.name }`);
  }

  /**
   * 执行聊天任务（高优先级）
   */
  async executeChatTask(
    taskId: string,
    description: string,
    onLog: (entry: { seq: number; type: string; content: string; metadata?: unknown; persist: boolean }) => void,
    cancelToken?: { cancelled: boolean },
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
          onLog({ seq: -1, type: 'progress', content: JSON.stringify({ progress, currentStep }), persist: false });
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
  private updateTokensUsed(tokens: number): void {
    this.state.tokensUsedToday += tokens;
    if (this.stateManager) {
      this.stateManager.updateTokensUsed(tokens);
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

  setSandbox(sandbox: SandboxHandle): void {
    this.sandbox = sandbox;
    this.registerSandboxedTools(sandbox);
    log.info(`Sandbox attached to agent ${this.id}`);
  }

  setOrgContext(ctx: OrgContext): void {
    this.orgContext = ctx;
  }

  setIdentityContext(ctx: IdentityContext): void {
    this.identityContext = ctx;
  }

  setAuditCallback(cb: (event: { type: string; action: string; tokensUsed?: number; durationMs?: number; success: boolean; detail?: string }) => void): void {
    this.auditCallback = cb;
  }

  setEscalationCallback(cb: (agentId: string, reason: string) => void): void {
    this.escalationCallback = cb;
  }

  /** Inject a function that returns this agent's currently assigned tasks for system prompt context */
  setTasksFetcher(fetcher: () => Array<{ id: string; title: string; description: string; status: string; priority: string }>): void {
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
      const report = await this.handleMessage(prompt, undefined, undefined);
      this.memory.addLongTermMemory(`daily-report-${new Date().toISOString().split('T')[0]}`, report);
      return report;
    } catch (error) {
      log.error('Failed to generate daily report', { error: String(error) });
      return `Unable to generate report: ${String(error)}`;
    }
  }

  getUptime(): number {
    return this.state.status !== 'offline' ? Date.now() - new Date(this.config.createdAt).getTime() : 0;
  }

  async handleMessage(userMessage: string, senderId?: string, senderInfo?: { name: string; role: string }): Promise<string> {
    // 只有在没有活动任务时才设置状态为working
    // 如果有任务在执行，状态应该已经是working
    if (this.activeTasks.size === 0) {
      this.setStatus('working');
    }

    if (!this.currentSessionId) {
      const session = this.memory.createSession(this.id);
      this.currentSessionId = session.id;
    }

    this.memory.appendMessage(this.currentSessionId, { role: 'user', content: userMessage });

    const systemPrompt = this.contextEngine.buildSystemPrompt({
      agentId: this.id,
      agentName: this.config.name,
      role: this.role,
      orgContext: this.orgContext,
      contextMdPath: this.contextMdPath,
      memory: this.memory,
      currentQuery: userMessage,
      identity: this.identityContext,
      senderIdentity: senderId && senderInfo ? { id: senderId, ...senderInfo } : undefined,
      assignedTasks: this.tasksFetcher?.(),
    });

    const sessionMessages = this.memory.getRecentMessages(this.currentSessionId, 100);
    const messages = this.contextEngine.prepareMessages({
      systemPrompt,
      sessionMessages,
      memory: this.memory,
      sessionId: this.currentSessionId,
    });

    const llmTools = this.buildToolDefinitions();

    try {
      const llmStart = Date.now();
      let response = await this.llmRouter.chat({
        messages,
        tools: llmTools.length > 0 ? llmTools : undefined,
      });

      const tokensThisCall = response.usage.inputTokens + response.usage.outputTokens;
      this.updateTokensUsed(tokensThisCall);
      this.auditCallback?.({ type: 'llm_request', action: 'chat', tokensUsed: tokensThisCall, durationMs: Date.now() - llmStart, success: true });

      while (response.finishReason === 'tool_use' && response.toolCalls?.length) {
        this.memory.appendMessage(this.currentSessionId, {
          role: 'assistant',
          content: response.content,
          toolCalls: response.toolCalls,
        });

        for (const tc of response.toolCalls) {
          const toolStart = Date.now();
          try {
            const result = await this.executeTool(tc);
            const isToolError = isErrorResult(result);
            this.auditCallback?.({ type: 'tool_call', action: tc.name, durationMs: Date.now() - toolStart, success: !isToolError, detail: JSON.stringify(tc.arguments).slice(0, 200) });
            this.memory.appendMessage(this.currentSessionId, {
              role: 'tool',
              content: result,
              toolCallId: tc.id,
            });
          } catch (toolErr) {
            this.auditCallback?.({ type: 'tool_call', action: tc.name, durationMs: Date.now() - toolStart, success: false, detail: String(toolErr).slice(0, 200) });
            this.memory.appendMessage(this.currentSessionId, {
              role: 'tool',
              content: `Error: ${String(toolErr)}`,
              toolCallId: tc.id,
            });
          }
        }

        const updatedSessionMessages = this.memory.getRecentMessages(this.currentSessionId, 100);
        const updatedMessages = this.contextEngine.prepareMessages({
          systemPrompt,
          sessionMessages: updatedSessionMessages,
          memory: this.memory,
          sessionId: this.currentSessionId,
        });

        const llmStart2 = Date.now();
        response = await this.llmRouter.chat({
          messages: updatedMessages,
          tools: llmTools.length > 0 ? llmTools : undefined,
        });

        const tokens2 = response.usage.inputTokens + response.usage.outputTokens;
        this.updateTokensUsed(tokens2);
        this.auditCallback?.({ type: 'llm_request', action: 'chat', tokensUsed: tokens2, durationMs: Date.now() - llmStart2, success: true });
      }

      const reply = response.content;
      this.memory.appendMessage(this.currentSessionId, { role: 'assistant', content: reply });
      // Only go idle if no tasks are concurrently executing
      // 注意：聊天任务不会添加到activeTasks中，所以这里只检查activeTasks
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
      if (this.activeTasks.size === 0) this.setStatus('error');
      this.auditCallback?.({ type: 'error', action: 'handle_message', success: false, detail: String(error).slice(0, 200) });
      log.error('Failed to handle message', { error: String(error) });
      throw error;
    }
  }

  async handleMessageStream(
    userMessage: string,
    onEvent: (event: LLMStreamEvent & { agentEvent?: string }) => void,
    senderId?: string,
    senderInfo?: { name: string; role: string },
  ): Promise<string> {
    // 只有在没有活动任务时才设置状态为working
    // 如果有任务在执行，状态应该已经是working
    if (this.activeTasks.size === 0) {
      this.setStatus('working');
    }

    if (!this.currentSessionId) {
      const session = this.memory.createSession(this.id);
      this.currentSessionId = session.id;
    }

    this.memory.appendMessage(this.currentSessionId, { role: 'user', content: userMessage });

    const systemPrompt = this.contextEngine.buildSystemPrompt({
      agentId: this.id,
      agentName: this.config.name,
      role: this.role,
      orgContext: this.orgContext,
      contextMdPath: this.contextMdPath,
      memory: this.memory,
      currentQuery: userMessage,
      identity: this.identityContext,
      senderIdentity: senderId && senderInfo ? { id: senderId, ...senderInfo } : undefined,
      assignedTasks: this.tasksFetcher?.(),
    });

    const sessionMessages = this.memory.getRecentMessages(this.currentSessionId, 100);
    const messages = this.contextEngine.prepareMessages({
      systemPrompt,
      sessionMessages,
      memory: this.memory,
      sessionId: this.currentSessionId,
    });

    const llmTools = this.buildToolDefinitions();

    try {
      const llmStart = Date.now();
      let response = await this.llmRouter.chatStream(
        { messages, tools: llmTools.length > 0 ? llmTools : undefined },
        onEvent,
      );
      const tokensThisCall = response.usage.inputTokens + response.usage.outputTokens;
      this.updateTokensUsed(tokensThisCall);
      this.auditCallback?.({ type: 'llm_request', action: 'chat_stream', tokensUsed: tokensThisCall, durationMs: Date.now() - llmStart, success: true });

      while (response.finishReason === 'tool_use' && response.toolCalls?.length) {
        this.memory.appendMessage(this.currentSessionId, {
          role: 'assistant',
          content: response.content,
          toolCalls: response.toolCalls,
        });

        for (const tc of response.toolCalls) {
          const toolStart = Date.now();
          onEvent({ type: 'agent_tool', tool: tc.name, phase: 'start' });
          try {
            const result = await this.executeTool(tc);
            const isToolError = isErrorResult(result);
            this.auditCallback?.({ type: 'tool_call', action: tc.name, durationMs: Date.now() - toolStart, success: !isToolError, detail: JSON.stringify(tc.arguments).slice(0, 200) });
            onEvent({ type: 'agent_tool', tool: tc.name, phase: 'end', success: !isToolError });
            this.memory.appendMessage(this.currentSessionId, {
              role: 'tool',
              content: result,
              toolCallId: tc.id,
            });
          } catch (toolErr) {
            this.auditCallback?.({ type: 'tool_call', action: tc.name, durationMs: Date.now() - toolStart, success: false, detail: String(toolErr).slice(0, 200) });
            onEvent({ type: 'agent_tool', tool: tc.name, phase: 'end', success: false });
            this.memory.appendMessage(this.currentSessionId, {
              role: 'tool',
              content: `Error: ${String(toolErr)}`,
              toolCallId: tc.id,
            });
          }
        }

        const updatedSessionMessages = this.memory.getRecentMessages(this.currentSessionId, 100);
        const updatedMessages = this.contextEngine.prepareMessages({
          systemPrompt,
          sessionMessages: updatedSessionMessages,
          memory: this.memory,
          sessionId: this.currentSessionId,
        });

        const llmStart2 = Date.now();
        response = await this.llmRouter.chatStream(
          { messages: updatedMessages, tools: llmTools.length > 0 ? llmTools : undefined },
          onEvent,
        );
        const tokens2 = response.usage.inputTokens + response.usage.outputTokens;
        this.updateTokensUsed(tokens2);
        this.auditCallback?.({ type: 'llm_request', action: 'chat_stream', tokensUsed: tokens2, durationMs: Date.now() - llmStart2, success: true });
      }

      const reply = response.content;
      this.memory.appendMessage(this.currentSessionId, { role: 'assistant', content: reply });
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
      if (this.activeTasks.size === 0) this.setStatus('error');
      this.auditCallback?.({ type: 'error', action: 'handle_message_stream', success: false, detail: String(error).slice(0, 200) });
      log.error('Failed to handle stream message', { error: String(error) });
      throw error;
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
    onLog: (entry: { seq: number; type: string; content: string; metadata?: unknown; persist: boolean }) => void,
    cancelToken?: { cancelled: boolean },
  ): Promise<void> {
    return this.executeTaskConcurrent(taskId, description, onLog, cancelToken);
  }

  /**
   * 并发执行任务（使用TaskExecutor）
   */
  async executeTaskConcurrent(
    taskId: string,
    description: string,
    onLog: (entry: { seq: number; type: string; content: string; metadata?: unknown; persist: boolean }) => void,
    cancelToken?: { cancelled: boolean },
    priority: TaskPriority = TaskPriority.MEDIUM,
  ): Promise<void> {
    if (!this.taskExecutor) {
      throw new Error('Task executor not initialized');
    }

    // 使用TaskExecutor执行任务
    const result = await this.taskExecutor.executeTaskTask(
      taskId,
      async () => {
        return this._executeTaskInternal(taskId, description, onLog, cancelToken);
      },
      {
        priority,
        onProgress: (progress: number, currentStep?: string) => {
          // 发送进度更新
          onLog({ seq: -1, type: 'progress', content: JSON.stringify({ progress, currentStep }), persist: false });
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
    onLog: (entry: { seq: number; type: string; content: string; metadata?: unknown; persist: boolean }) => void,
    cancelToken?: { cancelled: boolean },
  ): Promise<void> {
    // 更新状态（通过TaskExecutor管理）
    this.setStatus('working');
    this.activeTasks.add(taskId);

    let seq = 0;
    const emit = (type: string, content: string, metadata?: unknown) => {
      onLog({ seq: seq++, type, content, metadata, persist: true });
    };
    const emitDelta = (text: string) => {
      // text_delta: real-time streaming, not persisted individually
      onLog({ seq: -1, type: 'text_delta', content: text, persist: false });
    };

    emit('status', 'started', { agentId: this.id, agentName: this.config.name });

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
        ? 'Review the previous execution history above, then continue and complete the remaining work. Skip steps already marked as completed (✓).'
        : 'Execute this task completely using your available tools. When done, provide a concise summary of what was accomplished.',
    ].join('\n');

    this.memory.appendMessage(sessionId, { role: 'user', content: taskPrompt });

    const systemPrompt = this.contextEngine.buildSystemPrompt({
      agentId: this.id,
      agentName: this.config.name,
      role: this.role,
      orgContext: this.orgContext,
      contextMdPath: this.contextMdPath,
      memory: this.memory,
      currentQuery: taskPrompt,
      identity: this.identityContext,
      assignedTasks: this.tasksFetcher?.(),
    });

    const llmTools = this.buildToolDefinitions();
    let textBuffer = '';

    const flushText = () => {
      if (textBuffer.trim()) {
        emit('text', textBuffer);
        textBuffer = '';
      }
    };

    try {
      const messages = this.contextEngine.prepareMessages({
        systemPrompt,
        sessionMessages: this.memory.getRecentMessages(sessionId, 100),
        memory: this.memory,
        sessionId,
      });

      let response = await this.llmRouter.chatStream(
        { messages, tools: llmTools.length > 0 ? llmTools : undefined },
        (event) => {
          if (event.type === 'text_delta' && event.text) {
            textBuffer += event.text;
            emitDelta(event.text);
          }
        },
      );
      this.updateTokensUsed(response.usage.inputTokens + response.usage.outputTokens);

      while (response.finishReason === 'tool_use' && response.toolCalls?.length) {
        // Check for external cancellation (e.g., task paused or status changed away from in_progress)
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
            emit('tool_end', tc.name, { success: !isErr, durationMs, result: result.slice(0, 500) });
            this.auditCallback?.({ type: 'tool_call', action: tc.name, durationMs, success: !isErr });
            this.memory.appendMessage(sessionId, { role: 'tool', content: result, toolCallId: tc.id });
          } catch (toolErr) {
            const durationMs = Date.now() - toolStart;
            emit('tool_end', tc.name, { success: false, durationMs, error: String(toolErr) });
            this.auditCallback?.({ type: 'tool_call', action: tc.name, durationMs, success: false });
            this.memory.appendMessage(sessionId, { role: 'tool', content: `Error: ${String(toolErr)}`, toolCallId: tc.id });
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
              sessionMessages: this.memory.getRecentMessages(sessionId, 100),
              memory: this.memory,
              sessionId,
            }),
            tools: llmTools.length > 0 ? llmTools : undefined,
          },
          (event) => {
            if (event.type === 'text_delta' && event.text) {
              textBuffer += event.text;
              emitDelta(event.text);
            }
          },
        );
        this.updateTokensUsed(response.usage.inputTokens + response.usage.outputTokens);
      }

      flushText();
      const finalReply = response.content;
      this.memory.appendMessage(sessionId, { role: 'assistant', content: finalReply });
      emit('status', 'completed');
      this.eventBus.emit('task:completed', { taskId, agentId: this.id });
      log.info(`Task execution completed`, { taskId, agentId: this.id });
    } catch (error) {
      flushText();
      emit('error', String(error));
      this.auditCallback?.({ type: 'error', action: 'execute_task', success: false, detail: String(error).slice(0, 200) });
      log.error('Task execution failed', { taskId, agentId: this.id, error: String(error) });
      this.eventBus.emit('task:failed', { taskId, agentId: this.id, error: String(error) });
      throw error; // 重新抛出错误，让TaskExecutor处理
    } finally {
      // 从活动任务中移除
      this.activeTasks.delete(taskId);
      
      // 如果没有活动任务，设置状态为idle
      if (this.activeTasks.size === 0) {
        this.setStatus('idle');
      }
    }
  }

  private skillProficiency = new Map<string, { uses: number; successes: number; lastUsed: string }>();

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

  getState(): AgentState {
    return { ...this.state };
  }

  getEventBus(): EventBus {
    return this.eventBus;
  }

  getMemory(): MemoryStore {
    return this.memory;
  }

  private registerSandboxedTools(sandbox: SandboxHandle): void {
    this.tools.set('shell_execute', {
      name: 'shell_execute',
      description: 'Execute a shell command inside the agent\'s isolated sandbox container.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute' },
          cwd: { type: 'string', description: 'Working directory (optional)' },
          timeout_ms: { type: 'number', description: 'Timeout in ms (default: 60000)' },
        },
        required: ['command'],
      },
      execute: async (args) => {
        const result = await sandbox.exec(
          args['command'] as string,
          { cwd: args['cwd'] as string | undefined, timeoutMs: (args['timeout_ms'] as number) ?? 60_000 },
        );
        const parts: string[] = [];
        if (result.stdout?.trim()) parts.push(result.stdout.trim());
        if (result.stderr?.trim()) parts.push(`[stderr] ${result.stderr.trim()}`);
        if (result.exitCode !== undefined && result.exitCode !== 0) {
          parts.push(`[exit code: ${result.exitCode}]`);
        }
        return parts.join('\n') || '(no output)';
      },
    });

    this.tools.set('file_read', {
      name: 'file_read',
      description: 'Read a file from the agent\'s sandbox container.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File path to read' } },
        required: ['path'],
      },
      execute: async (args) => {
        try {
          return await sandbox.readFile(args['path'] as string);
        } catch (e) {
          return JSON.stringify({ error: String(e) });
        }
      },
    });

    this.tools.set('file_write', {
      name: 'file_write',
      description: 'Write content to a file in the agent\'s sandbox container.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to write' },
          content: { type: 'string', description: 'Content to write' },
        },
        required: ['path', 'content'],
      },
      execute: async (args) => {
        try {
          await sandbox.writeFile(args['path'] as string, args['content'] as string);
          return JSON.stringify({ success: true, path: args['path'] });
        } catch (e) {
          return JSON.stringify({ error: String(e) });
        }
      },
    });

    log.info(`Sandboxed tools registered for agent ${this.id}`);
  }

  private buildToolDefinitions(): LLMTool[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  private async executeTool(toolCall: LLMToolCall): Promise<string> {
    const handler = this.tools.get(toolCall.name);
    if (!handler) {
      this.recordToolUsage(toolCall.name, false);
      this.handleFailure(`Unknown tool: ${toolCall.name}`);
      return JSON.stringify({ error: `Unknown tool: ${toolCall.name}` });
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= Agent.TOOL_RETRY_MAX; attempt++) {
      try {
        if (attempt > 0) {
          const delay = Agent.TOOL_RETRY_BASE_MS * Math.pow(2, attempt - 1);
          log.info(`Retrying tool ${toolCall.name} (attempt ${attempt + 1})`, { delay });
          await new Promise(r => setTimeout(r, delay));
        }
        log.debug(`Executing tool: ${toolCall.name}`, { args: toolCall.arguments, attempt });
        const result = await handler.execute(toolCall.arguments);
        this.recordToolUsage(toolCall.name, true);
        this.consecutiveFailures = 0;
        return result;
      } catch (error) {
        lastError = error;
        log.error(`Tool execution failed: ${toolCall.name} (attempt ${attempt + 1})`, { error: String(error) });
      }
    }

    this.recordToolUsage(toolCall.name, false);
    this.handleFailure(`Tool ${toolCall.name} failed after ${Agent.TOOL_RETRY_MAX + 1} attempts: ${String(lastError)}`);
    return JSON.stringify({ error: String(lastError) });
  }

  private handleFailure(reason: string): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= Agent.MAX_CONSECUTIVE_FAILURES) {
      log.warn('Consecutive failure threshold reached, escalating to human', { agentId: this.id, failures: this.consecutiveFailures });
      this.escalationCallback?.(this.id, `Agent ${this.config.name} needs help: ${reason} (${this.consecutiveFailures} consecutive failures)`);
      this.consecutiveFailures = 0;
    }
  }

  private async handleHeartbeat(ctx: {
    agentId: string;
    task: { name: string; description: string };
    triggeredAt: string;
  }): Promise<void> {
    if (this.state.status === 'working' || this.activeTasks.size > 0) {
      log.debug('Skipping heartbeat — agent is busy', { task: ctx.task.name, activeTasks: this.activeTasks.size });
      return;
    }

    log.info(`Processing heartbeat task: ${ctx.task.name}`);
    const prompt = [
      `[HEARTBEAT TASK] ${ctx.task.name}`,
      '',
      ctx.task.description,
      '',
      '## Heartbeat Retrospective',
      'As part of this heartbeat, perform the following review (max 5 tool calls total):',
      '1. **Task Review**: Call `task_list` to see all your assigned tasks.',
      '2. **Start Pending Work**: For any task that is `assigned` (not yet started) and should be worked on, call `task_update` with status `in_progress`. The system will automatically launch a dedicated execution session for that task — you do NOT need to do the work yourself in this heartbeat.',
      '3. **Status Correction**: If any in_progress task has been completed or blocked, call `task_update` to reflect the correct status.',
      '4. **Orphaned Work**: If there is work you are doing with no corresponding task, call `task_create` to register it.',
      '',
      'IMPORTANT: Do NOT try to directly execute task work in this heartbeat. Your role here is only to review task statuses and trigger execution via `task_update(in_progress)`. Actual work happens in a separate dedicated session.',
    ].join('\n');

    try {
      await this.handleMessage(prompt);
      this.state.lastHeartbeat = new Date().toISOString();
    } catch (error) {
      log.error('Heartbeat task failed', { task: ctx.task.name, error: String(error) });
    }
  }
}
