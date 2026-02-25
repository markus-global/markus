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

const log = createLogger('agent');

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
  private consecutiveFailures = 0;
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

  async start(): Promise<void> {
    this.state.status = 'idle';

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
    this.state.status = 'offline';
    this.eventBus.emit('agent:stopped', { agentId: this.id });
    log.info(`Agent stopped: ${this.config.name}`);
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
      `Your status: ${state.status}, tokens used today: ${state.tokensUsedToday}`,
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
    this.state.status = 'working';

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
      this.state.tokensUsedToday += tokensThisCall;
      this.auditCallback?.({ type: 'llm_request', action: 'chat', tokensUsed: tokensThisCall, durationMs: Date.now() - llmStart, success: true });

      let iterations = 0;
      const maxIterations = 20;

      while (response.finishReason === 'tool_use' && response.toolCalls?.length && iterations < maxIterations) {
        iterations++;

        this.memory.appendMessage(this.currentSessionId, {
          role: 'assistant',
          content: response.content,
          toolCalls: response.toolCalls,
        });

        for (const tc of response.toolCalls) {
          const toolStart = Date.now();
          try {
            const result = await this.executeTool(tc);
            this.auditCallback?.({ type: 'tool_call', action: tc.name, durationMs: Date.now() - toolStart, success: true, detail: JSON.stringify(tc.arguments).slice(0, 200) });
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
        this.state.tokensUsedToday += tokens2;
        this.auditCallback?.({ type: 'llm_request', action: 'chat', tokensUsed: tokens2, durationMs: Date.now() - llmStart2, success: true });
      }

      if (iterations >= maxIterations) {
        log.warn('Tool loop hit max iterations', { agentId: this.id, iterations });
      }

      const reply = response.content;
      this.memory.appendMessage(this.currentSessionId, { role: 'assistant', content: reply });
      this.state.status = 'idle';

      this.eventBus.emit('agent:message', {
        agentId: this.id,
        senderId,
        userMessage,
        reply,
        tokensUsed: this.state.tokensUsedToday,
      });

      return reply;
    } catch (error) {
      this.state.status = 'error';
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
    this.state.status = 'working';

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
      this.state.tokensUsedToday += tokensThisCall;
      this.auditCallback?.({ type: 'llm_request', action: 'chat_stream', tokensUsed: tokensThisCall, durationMs: Date.now() - llmStart, success: true });

      let iterations = 0;
      const maxIterations = 20;

      while (response.finishReason === 'tool_use' && response.toolCalls?.length && iterations < maxIterations) {
        iterations++;

        this.memory.appendMessage(this.currentSessionId, {
          role: 'assistant',
          content: response.content,
          toolCalls: response.toolCalls,
        });

        for (const tc of response.toolCalls) {
          const toolStart = Date.now();
          try {
            const result = await this.executeTool(tc);
            this.auditCallback?.({ type: 'tool_call', action: tc.name, durationMs: Date.now() - toolStart, success: true, detail: JSON.stringify(tc.arguments).slice(0, 200) });
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
        response = await this.llmRouter.chatStream(
          { messages: updatedMessages, tools: llmTools.length > 0 ? llmTools : undefined },
          onEvent,
        );
        const tokens2 = response.usage.inputTokens + response.usage.outputTokens;
        this.state.tokensUsedToday += tokens2;
        this.auditCallback?.({ type: 'llm_request', action: 'chat_stream', tokensUsed: tokens2, durationMs: Date.now() - llmStart2, success: true });
      }

      const reply = response.content;
      this.memory.appendMessage(this.currentSessionId, { role: 'assistant', content: reply });
      this.state.status = 'idle';

      this.eventBus.emit('agent:message', {
        agentId: this.id,
        senderId,
        userMessage,
        reply,
        tokensUsed: this.state.tokensUsedToday,
      });

      return reply;
    } catch (error) {
      this.state.status = 'error';
      this.auditCallback?.({ type: 'error', action: 'handle_message_stream', success: false, detail: String(error).slice(0, 200) });
      log.error('Failed to handle stream message', { error: String(error) });
      throw error;
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
    if (this.state.status === 'working') {
      log.debug('Skipping heartbeat — agent is busy', { task: ctx.task.name });
      return;
    }

    log.info(`Processing heartbeat task: ${ctx.task.name}`);
    const prompt = `[HEARTBEAT TASK] ${ctx.task.name}\n\n${ctx.task.description}\n\nBriefly check status. If no actionable items found, just report "No action needed." Do NOT run excessive commands — at most 2-3 tool calls.`;

    try {
      await this.handleMessage(prompt);
    } catch (error) {
      log.error('Heartbeat task failed', { task: ctx.task.name, error: String(error) });
    }
  }
}
