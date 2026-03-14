import type { ServerResponse } from 'node:http';
import type { Agent } from '@markus/core';
import { createLogger, type LLMStreamEvent } from '@markus/shared';
import { SSEBuffer } from './sse-buffer.js';

const log = createLogger('sse-handler');

type AgentStreamEvent = LLMStreamEvent & { agentEvent?: string };

export interface SSEMessageHandlerOptions {
  agentId: string;
  agent: Agent;
  userText: string;
  images?: string[];
  senderId?: string;
  sessionId?: string;
  senderInfo?: { name: string; role: string };
  wsBroadcaster?: {
    broadcastChat: (agentId: string, message: string, sender: 'agent' | 'user') => void;
    broadcastAgentUpdate?: (agentId: string, status: string) => void;
  };
  persistUserMessage?: (agentId: string, text: string, senderId?: string, images?: string[], sessionId?: string) => Promise<string | null>;
  persistAssistantMessage?: (sessionId: string | null, agentId: string, reply: string, tokensUsed: number, meta?: unknown) => Promise<void>;
  onTextDelta?: (text: string) => void;
  onToolEvent?: (event: AgentStreamEvent) => void;
  onComplete?: (reply: string, segments: Array<{type: string; content?: string; tool?: string; status?: string}>, tokensUsed: number) => Promise<void>;
  onError?: (error: unknown, segments: Array<{type: string; content?: string; tool?: string; status?: string}>) => Promise<void>;
}

/**
 * 处理SSE流式响应的统一处理器
 */
export class SSEHandler {
  private options: SSEMessageHandlerOptions;
  private sseBuffer: SSEBuffer | null = null;
  private msgSegments: Array<{type: 'text'; content: string} | {type: 'tool'; tool: string; status: 'done' | 'error'; arguments?: unknown; result?: string; error?: string; durationMs?: number}> = [];
  private textBuf = '';
  private totalTokens = 0;
  private processedTokens = 0;
  private isProcessing = false;
  private isComplete = false;
  private sseDisconnected = false;
  private cancelToken = { cancelled: false };
  private sessionId: string | null = null;

  constructor(options: SSEMessageHandlerOptions) {
    this.options = options;
  }

  /**
   * 处理流式消息
   */
  async handle(res: ServerResponse): Promise<void> {
    if (this.isProcessing) {
      throw new Error('SSE handler is already processing');
    }

    this.isProcessing = true;
    
    try {
      this.sseBuffer = new SSEBuffer(res, {
        bufferSize: 4096,
        flushInterval: 30,
        heartbeatInterval: 15000,
      });

      this.sseBuffer.onClose(() => {
        if (!this.isComplete) {
          this.sseDisconnected = true;
          this.cancelToken.cancelled = true;
          log.warn('SSE client disconnected — cancelling agent', {
            agentId: this.options.agentId,
          });
          if (this.options.wsBroadcaster?.broadcastAgentUpdate) {
            this.options.wsBroadcaster.broadcastAgentUpdate(this.options.agentId, 'idle');
          }
        }
      });

      if (this.options.persistUserMessage) {
        this.sessionId = await this.options.persistUserMessage(
          this.options.agentId,
          this.options.userText,
          this.options.senderId,
          this.options.images,
          this.options.sessionId,
        );
      }

      const reply = await this.options.agent.handleMessageStream(
        this.options.userText,
        (event) => this.handleStreamEvent(event),
        this.options.senderId,
        this.options.senderInfo,
        this.cancelToken,
        this.options.images,
      );

      if (this.textBuf) {
        this.msgSegments.push({ type: 'text', content: this.textBuf });
        this.textBuf = '';
      }

      // Build the best available reply content for persistence.
      // If the agent returned empty/cancelled, reconstruct from accumulated segments.
      let persistReply = reply;
      if (!reply || reply === '[Stream cancelled]') {
        const segText = this.msgSegments
          .filter(s => s.type === 'text')
          .map(s => (s as { content: string }).content)
          .join('');
        if (segText) persistReply = segText;
      }

      if (this.sseDisconnected) {
        log.info('Agent finished but SSE was disconnected — delivering reply via WebSocket fallback', {
          agentId: this.options.agentId,
          replyLength: persistReply.length,
        });
        if (this.options.wsBroadcaster) {
          this.options.wsBroadcaster.broadcastChat(this.options.agentId, persistReply, 'agent');
        }
      } else {
        this.sseBuffer.send({ 
          type: 'done', 
          content: persistReply, 
          agentId: this.options.agentId,
          sessionId: this.sessionId,
          segments: this.msgSegments 
        });

        if (this.sseBuffer) {
          const buffer = this.sseBuffer as unknown as { flush?: () => void };
          if (buffer.flush) {
            buffer.flush();
          }
        }
      }

      if (this.options.persistAssistantMessage && this.sessionId) {
        const msgMeta = this.msgSegments.length > 0 ? { segments: this.msgSegments } : undefined;
        try {
          await this.options.persistAssistantMessage(
            this.sessionId,
            this.options.agentId,
            persistReply,
            this.options.agent.getState().tokensUsedToday,
            msgMeta
          );
        } catch (e) {
          log.error('Failed to persist assistant message', { agentId: this.options.agentId, error: String(e) });
        }
      }

      if (this.options.onComplete) {
        await this.options.onComplete(reply, this.msgSegments, this.options.agent.getState().tokensUsedToday);
      }

      this.isComplete = true;
      
      if (!this.sseDisconnected) {
        setTimeout(() => {
          if (this.sseBuffer) {
            this.sseBuffer.close();
          }
        }, 100);
      }

    } catch (error) {
      log.error('SSE handler error', { 
        agentId: this.options.agentId, 
        error: String(error) 
      });
      
      this.handleError(error, res);

      // Persist error as assistant message so it survives page reloads.
      // Include any partial text that was accumulated before the error.
      const errSuffix = `\n\n⚠ ${String(error).slice(0, 500)}`;
      if (this.textBuf) {
        this.msgSegments.push({ type: 'text', content: this.textBuf });
        this.textBuf = '';
      }
      this.msgSegments.push({ type: 'text', content: errSuffix.trim() });

      // Reconstruct reply from accumulated text segments so partial content is preserved
      const partialText = this.msgSegments
        .filter(s => s.type === 'text')
        .map(s => (s as { content: string }).content)
        .join('');
      const errReply = partialText || errSuffix.trim();
      const errMeta = { isError: true, segments: this.msgSegments };

      if (this.options.persistAssistantMessage && this.sessionId) {
        try {
          await this.options.persistAssistantMessage(
            this.sessionId, this.options.agentId, errReply, 0, errMeta,
          );
        } catch (e) {
          log.error('Failed to persist error message', { agentId: this.options.agentId, error: String(e) });
        }
      }
      if (this.options.onError) {
        void this.options.onError(error, this.msgSegments)
          .catch(e => log.warn('onError callback failed', { error: String(e) }));
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * 处理流式事件
   */
  private handleStreamEvent(event: AgentStreamEvent): void {
    if (!this.sseBuffer || this.sseDisconnected) return;

    this.sseBuffer.send({ ...event });
    
    if (event.type === 'text_delta' && event.text) {
      this.textBuf += event.text;

      if (this.options.onTextDelta) {
        this.options.onTextDelta(event.text);
      }
      
      const tokenEstimate = Math.ceil(event.text.length * 0.75);
      this.processedTokens += tokenEstimate;
      this.totalTokens = Math.max(this.totalTokens, this.processedTokens + 50);
      
      if (tokenEstimate >= 50 || this.processedTokens % 50 < tokenEstimate) {
        this.sseBuffer.sendProgress(this.processedTokens, this.totalTokens, '正在生成回复...');
      }
    } else if (event.type === 'agent_tool') {
      if (this.options.onToolEvent) {
        this.options.onToolEvent(event);
      }
      
      if (event.phase === 'start') {
        if (this.textBuf) { 
          this.msgSegments.push({ type: 'text', content: this.textBuf }); 
          this.textBuf = ''; 
        }
        this.sseBuffer.sendProgress(this.processedTokens, this.totalTokens, `正在执行工具: ${event.tool}`);
      } else if (event.phase === 'end' && event.tool) {
        this.msgSegments.push({ 
          type: 'tool', 
          tool: event.tool, 
          status: event.success === false ? 'error' : 'done',
          arguments: event.arguments,
          result: event.result,
          error: event.error,
          durationMs: event.durationMs,
        });
        this.sseBuffer.sendProgress(this.processedTokens, this.totalTokens, `工具执行完成: ${event.tool}`);
      }
    } else if (event.type === 'message_end') {
      if (this.textBuf) {
        this.msgSegments.push({ type: 'text', content: this.textBuf });
        this.textBuf = '';
      }
      if (event.usage?.outputTokens) {
        this.totalTokens = Math.max(this.totalTokens, event.usage.outputTokens);
        this.processedTokens = event.usage.outputTokens;
      }
      this.sseBuffer.sendProgress(this.processedTokens, this.totalTokens, '回复生成完成');
    }
  }

  /**
   * 处理错误
   */
  private handleError(error: unknown, res: ServerResponse): void {
    try {
      if (this.sseBuffer && !this.sseDisconnected) {
        const errMsg = typeof error === 'string' ? error : (error instanceof Error ? error.message : String(error));
        this.sseBuffer.send({
          type: 'error',
          error: errMsg,
          sessionId: this.sessionId,
          recoverable: false,
          timestamp: Date.now(),
        });
        setTimeout(() => {
          if (this.sseBuffer) {
            this.sseBuffer.close();
          }
        }, 100);
      } else if (!this.sseBuffer) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
        res.write(`data: ${JSON.stringify({ type: 'error', message: String(error), sessionId: this.sessionId })}\\n\\n`);
        res.end();
      }
    } catch (e) {
      log.error('Error handling SSE error', { error: String(e) });
    }
  }

  /**
   * 取消处理
   */
  cancel(): void {
    this.cancelToken.cancelled = true;
    if (this.sseBuffer) {
      this.sseBuffer.close();
      this.sseBuffer = null;
    }
    this.isProcessing = false;
  }

  isCompleted(): boolean {
    return this.isComplete;
  }

  getProgress(): { current: number; total: number; message: string } {
    return {
      current: this.processedTokens,
      total: this.totalTokens,
      message: this.isComplete ? '完成' : '处理中'
    };
  }

  getSegments(): Array<{type: 'text'; content: string} | {type: 'tool'; tool: string; status: 'done' | 'error'}> {
    return [...this.msgSegments];
  }

  getTextBuffer(): string {
    return this.textBuf;
  }
}
