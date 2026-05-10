/**
 * SessionWorker - Lightweight concurrent session runner for external mode.
 *
 * Based on the runSubagentLoop pattern: runs independent LLM sessions
 * with fresh messages[], configurable tools, and shared LLMRouter.
 * No mailbox, no heartbeat, no task board — pure chat service.
 */
import { createLogger, type LLMMessage, type LLMTool, type LLMStreamEvent } from '@markus/shared';
import type { StreamCallback, SessionWorkerConfig } from './types.js';

const log = createLogger('session-worker');

const MAX_CONSECUTIVE_TOOL_ERRORS = 3;

export interface LLMRouterLike {
  chat(request: {
    messages: LLMMessage[];
    tools?: LLMTool[];
    stream?: boolean;
    metadata?: Record<string, unknown>;
  }, provider?: string): Promise<{ content: string; finishReason: string; toolCalls?: ToolCall[]; tokensUsed?: { input: number; output: number } }>;

  chatStream(request: {
    messages: LLMMessage[];
    tools?: LLMTool[];
    metadata?: Record<string, unknown>;
  }, onEvent: (event: LLMStreamEvent) => void, provider?: string): Promise<{ content: string; finishReason: string; toolCalls?: ToolCall[]; tokensUsed?: { input: number; output: number } }>;

  getModelContextWindow(provider?: string): number;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolHandler {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<string>;
}

export interface ContextEngineLike {
  shrinkMessages(messages: LLMMessage[], contextWindow: number): LLMMessage[];
}

export interface SessionMessageStore {
  loadMessages(sessionId: string): Promise<LLMMessage[]>;
  appendMessage(sessionId: string, message: LLMMessage, tokens?: number): Promise<void>;
  getMessageCount(sessionId: string): Promise<number>;
  getTokensUsed(sessionId: string): Promise<number>;
}

export class SessionWorker {
  private active = false;

  constructor(
    private config: SessionWorkerConfig,
    private llmRouter: LLMRouterLike,
    private contextEngine: ContextEngineLike,
    private tools: Map<string, ToolHandler>,
    private messageStore: SessionMessageStore,
  ) {}

  get sessionId(): string {
    return this.config.sessionId;
  }

  get isActive(): boolean {
    return this.active;
  }

  /**
   * Handle an incoming user message. Runs the LLM with tool loop.
   * Returns the assistant's final text response.
   */
  async handleMessage(userMessage: string, onStream?: StreamCallback): Promise<{
    response: string;
    tokensUsed: number;
    toolCalls: Array<{ name: string; input: unknown; output: unknown }>;
  }> {
    if (this.active) {
      throw new Error('SessionWorker is already processing a message');
    }

    this.active = true;
    const toolCallsLog: Array<{ name: string; input: unknown; output: unknown }> = [];
    let totalTokensUsed = 0;

    try {
      await this.messageStore.appendMessage(this.config.sessionId, {
        role: 'user',
        content: userMessage,
      });

      const messages = await this.messageStore.loadMessages(this.config.sessionId);
      const systemMessage: LLMMessage = { role: 'system', content: this.config.systemPrompt };
      let workingMessages: LLMMessage[] = [systemMessage, ...messages];

      const contextWindow = this.llmRouter.getModelContextWindow();
      workingMessages = this.contextEngine.shrinkMessages(workingMessages, contextWindow);

      const llmTools: LLMTool[] = [...this.tools.values()].map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));

      let response = onStream
        ? await this.llmRouter.chatStream(
            { messages: workingMessages, tools: llmTools.length > 0 ? llmTools : undefined, metadata: { sessionId: this.config.sessionId } },
            (event) => {
              if (event.type === 'text_delta' && event.text) {
                onStream({ type: 'text_delta', content: event.text });
              }
            },
          )
        : await this.llmRouter.chat(
            { messages: workingMessages, tools: llmTools.length > 0 ? llmTools : undefined, metadata: { sessionId: this.config.sessionId } },
          );

      if (response.tokensUsed) {
        totalTokensUsed += response.tokensUsed.input + response.tokensUsed.output;
      }

      let iterations = 0;
      let consecutiveErrors = 0;

      while (response.finishReason === 'tool_use' && response.toolCalls?.length) {
        if (++iterations > this.config.maxIterations) {
          log.warn('Session worker hit max iterations', { sessionId: this.config.sessionId, iterations });
          break;
        }

        if (totalTokensUsed > this.config.tokenBudget) {
          log.warn('Session worker hit token budget', { sessionId: this.config.sessionId, tokensUsed: totalTokensUsed });
          break;
        }

        const assistantMessage: LLMMessage = {
          role: 'assistant',
          content: response.content || '',
          toolCalls: response.toolCalls.map(tc => ({ id: tc.id, name: tc.name, arguments: tc.arguments })),
        };
        workingMessages.push(assistantMessage);

        await this.messageStore.appendMessage(this.config.sessionId, {
          role: 'assistant',
          content: JSON.stringify({ text: response.content || '', toolCalls: response.toolCalls.map(tc => ({ id: tc.id, name: tc.name })) }),
        });

        for (const tc of response.toolCalls) {
          const tool = this.tools.get(tc.name);
          let result: string;

          if (!tool) {
            result = JSON.stringify({ error: `Unknown tool: ${tc.name}` });
            consecutiveErrors++;
          } else {
            try {
              onStream?.({ type: 'tool_start', content: tc.name, metadata: { toolCallId: tc.id } });
              const args = tc.arguments;
              result = await tool.execute(args);
              consecutiveErrors = 0;
              onStream?.({ type: 'tool_end', content: tc.name, metadata: { toolCallId: tc.id } });
              toolCallsLog.push({ name: tc.name, input: args, output: result.slice(0, 500) });
            } catch (err) {
              result = JSON.stringify({ error: String(err) });
              consecutiveErrors++;
              onStream?.({ type: 'tool_end', content: tc.name, metadata: { toolCallId: tc.id, error: String(err) } });
            }
          }

          workingMessages.push({ role: 'tool', content: result, toolCallId: tc.id });

          if (consecutiveErrors >= MAX_CONSECUTIVE_TOOL_ERRORS) {
            log.warn('Too many consecutive tool errors, stopping', { sessionId: this.config.sessionId });
            break;
          }
        }

        if (consecutiveErrors >= MAX_CONSECUTIVE_TOOL_ERRORS) break;

        workingMessages = this.contextEngine.shrinkMessages(workingMessages, contextWindow);

        response = onStream
          ? await this.llmRouter.chatStream(
              { messages: workingMessages, tools: llmTools.length > 0 ? llmTools : undefined, metadata: { sessionId: this.config.sessionId } },
              (event) => {
                if (event.type === 'text_delta' && event.text) {
                  onStream({ type: 'text_delta', content: event.text });
                }
              },
            )
          : await this.llmRouter.chat(
              { messages: workingMessages, tools: llmTools.length > 0 ? llmTools : undefined, metadata: { sessionId: this.config.sessionId } },
            );

        if (response.tokensUsed) {
          totalTokensUsed += response.tokensUsed.input + response.tokensUsed.output;
        }
      }

      const finalText = response.content || '';

      await this.messageStore.appendMessage(this.config.sessionId, {
        role: 'assistant',
        content: finalText,
      }, totalTokensUsed);

      onStream?.({ type: 'done', content: finalText, metadata: { tokensUsed: totalTokensUsed } });

      log.debug('Session worker completed', {
        sessionId: this.config.sessionId,
        iterations,
        tokensUsed: totalTokensUsed,
        toolCalls: toolCallsLog.length,
      });

      return { response: finalText, tokensUsed: totalTokensUsed, toolCalls: toolCallsLog };
    } catch (error) {
      onStream?.({ type: 'error', content: String(error) });
      log.error('Session worker error', { sessionId: this.config.sessionId, error: String(error) });
      throw error;
    } finally {
      this.active = false;
    }
  }
}
