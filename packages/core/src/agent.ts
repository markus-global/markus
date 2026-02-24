import type {
  AgentConfig,
  AgentState,
  RoleTemplate,
  LLMMessage,
  LLMTool,
  LLMToolCall,
} from '@markus/shared';
import { createLogger, agentId as genAgentId } from '@markus/shared';
import { EventBus } from './events.js';
import { HeartbeatScheduler } from './heartbeat.js';
import { LLMRouter } from './llm/router.js';
import { MemoryStore } from './memory/store.js';

const log = createLogger('agent');

export interface AgentToolHandler {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<string>;
}

export interface AgentOptions {
  config: AgentConfig;
  role: RoleTemplate;
  llmRouter: LLMRouter;
  dataDir: string;
  tools?: AgentToolHandler[];
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
  private tools: Map<string, AgentToolHandler>;
  private currentSessionId?: string;

  constructor(options: AgentOptions) {
    this.id = options.config.id || genAgentId();
    this.config = { ...options.config, id: this.id };
    this.role = options.role;
    this.llmRouter = options.llmRouter;

    this.state = {
      agentId: this.id,
      status: 'idle',
      tokensUsedToday: 0,
    };

    this.eventBus = new EventBus();
    this.memory = new MemoryStore(options.dataDir);
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

    this.eventBus.on('heartbeat:trigger', (ctx) => {
      this.handleHeartbeat(ctx as { agentId: string; task: { name: string; description: string }; triggeredAt: string }).catch((e) =>
        log.error('Heartbeat handler failed', { error: String(e) }),
      );
    });

    log.info(`Agent created: ${this.id}`, { name: this.config.name, role: this.role.name });
  }

  async start(): Promise<void> {
    this.state.status = 'idle';
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

  async handleMessage(userMessage: string, senderId?: string): Promise<string> {
    this.state.status = 'working';

    if (!this.currentSessionId) {
      const session = this.memory.createSession(this.id);
      this.currentSessionId = session.id;
    }

    const systemPrompt = this.buildSystemPrompt();
    this.memory.appendMessage(this.currentSessionId, { role: 'user', content: userMessage });

    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      ...this.memory.getRecentMessages(this.currentSessionId, 50),
    ];

    const llmTools = this.buildToolDefinitions();

    try {
      let response = await this.llmRouter.chat({
        messages,
        tools: llmTools.length > 0 ? llmTools : undefined,
      });

      this.state.tokensUsedToday += response.usage.inputTokens + response.usage.outputTokens;

      // Tool use loop
      while (response.finishReason === 'tool_use' && response.toolCalls?.length) {
        this.memory.appendMessage(this.currentSessionId, {
          role: 'assistant',
          content: response.content,
          toolCalls: response.toolCalls,
        });

        for (const tc of response.toolCalls) {
          const result = await this.executeTool(tc);
          this.memory.appendMessage(this.currentSessionId, {
            role: 'tool',
            content: result,
            toolCallId: tc.id,
          });
        }

        const updatedMessages: LLMMessage[] = [
          { role: 'system', content: systemPrompt },
          ...this.memory.getRecentMessages(this.currentSessionId, 50),
        ];

        response = await this.llmRouter.chat({
          messages: updatedMessages,
          tools: llmTools.length > 0 ? llmTools : undefined,
        });

        this.state.tokensUsedToday += response.usage.inputTokens + response.usage.outputTokens;
      }

      const reply = response.content;
      this.memory.appendMessage(this.currentSessionId, { role: 'assistant', content: reply });
      this.state.status = 'idle';

      this.eventBus.emit('agent:message', {
        agentId: this.id,
        senderId,
        userMessage,
        reply,
      });

      return reply;
    } catch (error) {
      this.state.status = 'error';
      log.error('Failed to handle message', { error: String(error) });
      throw error;
    }
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

  private buildSystemPrompt(): string {
    const parts: string[] = [];

    parts.push(this.role.systemPrompt);

    if (this.role.defaultPolicies.length > 0) {
      parts.push('\n## Policies');
      for (const policy of this.role.defaultPolicies) {
        parts.push(`### ${policy.name}`);
        for (const rule of policy.rules) {
          parts.push(`- ${rule}`);
        }
      }
    }

    const recentMemories = this.memory.getEntries('fact', 10);
    if (recentMemories.length > 0) {
      parts.push('\n## Relevant Memories');
      for (const mem of recentMemories) {
        parts.push(`- [${mem.timestamp}] ${mem.content}`);
      }
    }

    parts.push(`\n## Agent Identity`);
    parts.push(`- Name: ${this.config.name}`);
    parts.push(`- Role: ${this.role.name}`);
    parts.push(`- Agent ID: ${this.id}`);
    parts.push(`- Current time: ${new Date().toISOString()}`);

    return parts.join('\n');
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
      return JSON.stringify({ error: `Unknown tool: ${toolCall.name}` });
    }

    try {
      log.debug(`Executing tool: ${toolCall.name}`, { args: toolCall.arguments });
      const result = await handler.execute(toolCall.arguments);
      return result;
    } catch (error) {
      log.error(`Tool execution failed: ${toolCall.name}`, { error: String(error) });
      return JSON.stringify({ error: String(error) });
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
    const prompt = `[HEARTBEAT TASK] ${ctx.task.name}\n\n${ctx.task.description}\n\nCheck if there is anything that needs your attention and take appropriate action.`;

    try {
      await this.handleMessage(prompt);
    } catch (error) {
      log.error('Heartbeat task failed', { task: ctx.task.name, error: String(error) });
    }
  }
}
