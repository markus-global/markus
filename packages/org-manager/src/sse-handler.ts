import type { ServerResponse } from 'node:http';
import type { Agent } from '@markus/core';
import { createLogger, COMPLETION_MARKER, type LLMStreamEvent } from '@markus/shared';
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
  executionStreamRepo?: { append(data: { sourceType: string; sourceId: string; agentId: string; seq: number; type: string; content: string; metadata?: unknown }): unknown };
  messageId?: string;
}

/**
 * 处理SSE流式响应的统一处理器
 */
export class SSEHandler {
  private options: SSEMessageHandlerOptions;
  private sseBuffer: SSEBuffer | null = null;
  private msgSegments: Array<{type: 'text'; content: string} | {type: 'tool'; tool: string; status: 'done' | 'error' | 'stopped'; arguments?: unknown; result?: string; error?: string; durationMs?: number}> = [];
  private textBuf = '';
  private runningTools: Array<{tool: string; arguments?: unknown; startedAt: number}> = [];
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

      const reply = await this.options.agent.sendMessageStream(
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

      const wasCancelled = this.cancelToken.cancelled;
      this.finalizeRunningTools();

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
      // Strip completion marker from persisted/displayed reply
      persistReply = persistReply.replaceAll(COMPLETION_MARKER, '').trim() || persistReply;

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
        const msgMeta: Record<string, unknown> = {};
        if (this.msgSegments.length > 0) msgMeta.segments = this.msgSegments;
        if (wasCancelled) msgMeta.isStopped = true;
        try {
          await this.options.persistAssistantMessage(
            this.sessionId,
            this.options.agentId,
            persistReply,
            this.options.agent.getState().tokensUsedToday,
            Object.keys(msgMeta).length > 0 ? msgMeta : undefined,
          );
        } catch (e) {
          log.error('Failed to persist assistant message', { agentId: this.options.agentId, error: String(e) });
        }
      }

      if (this.options.onComplete) {
        await this.options.onComplete(reply, this.msgSegments, this.options.agent.getState().tokensUsedToday);
      }

      this.persistSegmentsToExecutionStream();

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

  private persistSegmentsToExecutionStream(): void {
    const repo = this.options.executionStreamRepo;
    if (!repo) return;
    const messageId = this.options.messageId ?? `chat_${this.options.agentId}_${Date.now()}`;

    let seq = 0;
    const agentId = this.options.agentId;
    try {
      for (const seg of this.msgSegments) {
        if (seg.type === 'tool') {
          const toolSeg = seg as { tool: string; arguments?: unknown; result?: string; error?: string; durationMs?: number; status: string };
          repo.append({ sourceType: 'chat', sourceId: messageId, agentId, seq: seq++, type: 'tool_start', content: toolSeg.tool, metadata: { arguments: toolSeg.arguments } });
          repo.append({ sourceType: 'chat', sourceId: messageId, agentId, seq: seq++, type: 'tool_end', content: toolSeg.tool, metadata: { arguments: toolSeg.arguments, result: toolSeg.result, error: toolSeg.error, durationMs: toolSeg.durationMs, success: toolSeg.status !== 'error' } });
        } else {
          const textSeg = seg as { content: string };
          if (textSeg.content) {
            repo.append({ sourceType: 'chat', sourceId: messageId, agentId, seq: seq++, type: 'text', content: textSeg.content });
          }
        }
      }
    } catch (err) {
      log.warn('Failed to persist chat segments to execution stream', { messageId, error: String(err) });
    }
  }

  /**
   * Convert any still-running tools into 'stopped' segments so they are persisted.
   */
  private finalizeRunningTools(): void {
    for (const rt of this.runningTools) {
      this.msgSegments.push({
        type: 'tool',
        tool: rt.tool,
        status: 'stopped',
        arguments: rt.arguments,
        durationMs: Date.now() - rt.startedAt,
      });
    }
    this.runningTools = [];
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
        if (event.tool) {
          this.runningTools.push({ tool: event.tool, arguments: event.arguments, startedAt: Date.now() });
        }
        this.sseBuffer.sendProgress(this.processedTokens, this.totalTokens, `正在执行工具: ${event.tool}`);
      } else if (event.phase === 'end' && event.tool) {
        this.runningTools = this.runningTools.filter(t => t.tool !== event.tool);
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

  getSegments(): Array<{type: 'text'; content: string} | {type: 'tool'; tool: string; status: 'done' | 'error' | 'stopped'}> {
    return [...this.msgSegments];
  }

  getTextBuffer(): string {
    return this.textBuf;
  }
}
