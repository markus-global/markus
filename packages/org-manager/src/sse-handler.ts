/**
 * SSEHandler — the single canonical handler for Server-Sent Events streaming
 * from agent message processing to the web UI.
 *
 * Responsibilities:
 * - Manages the SSE connection lifecycle (open → stream → close)
 * - Buffers text/tool events via SSEBuffer for reliable delivery
 * - Persists user/assistant messages and execution stream entries
 * - Handles WS fallback broadcast on disconnect
 * - Coordinates with AgentMailbox via deferred session restore
 * - Safety timeout to force-stop agents if SSE disconnects mid-processing
 */
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
  fileNames?: string[];
  senderId?: string;
  sessionId?: string;
  senderInfo?: { name: string; role: string; isFirstConversation?: boolean };
  wsBroadcaster?: {
    broadcastChat: (agentId: string, message: string, sender: 'agent' | 'user') => void;
    broadcastAgentUpdate?: (agentId: string, status: string) => void;
    broadcastProactiveMessage?: (agentId: string, agentName: string, sessionId: string, messageId: string, message: string, metadata?: Record<string, unknown>, targetUserId?: string) => void;
  };
  persistUserMessage?: (agentId: string, text: string, senderId?: string, images?: string[], sessionId?: string) => Promise<string | null>;
  persistAssistantMessage?: (sessionId: string | null, agentId: string, reply: string, tokensUsed: number, meta?: unknown) => Promise<void>;
  onTextDelta?: (text: string) => void;
  onToolEvent?: (event: AgentStreamEvent) => void;
  onComplete?: (reply: string, segments: Array<{type: string; content?: string; tool?: string; status?: string}>, tokensUsed: number) => Promise<void>;
  onError?: (error: unknown, segments: Array<{type: string; content?: string; tool?: string; status?: string}>) => Promise<void>;
  executionStreamRepo?: { append(data: { sourceType: string; sourceId: string; agentId: string; seq: number; type: string; content: string; metadata?: unknown }): unknown };
  messageId?: string;
  isResume?: boolean;
  /** Deferred session restore data — applied when the mailbox item is processed, not at HTTP request time */
  sessionRestore?: { dbSessionId: string; messages: Array<{ role: string; content: string }>; isRetry?: boolean } | null;
}

/**
 * 处理SSE流式响应的统一处理器
 */
export class SSEHandler {
  private options: SSEMessageHandlerOptions;
  private sseBuffer: SSEBuffer | null = null;
  private msgSegments: Array<{type: 'text'; content: string; thinking?: string; createdAt?: string} | {type: 'tool'; tool: string; status: 'done' | 'error' | 'stopped'; arguments?: unknown; result?: string; error?: string; durationMs?: number; createdAt?: string}> = [];
  private textBuf = '';
  private thinkingBuf = '';
  private runningTools: Array<{tool: string; arguments?: unknown; startedAt: number}> = [];
  private totalTokens = 0;
  private processedTokens = 0;
  private isProcessing = false;
  private isComplete = false;
  private sseDisconnected = false;
  private cancelToken: { cancelled: boolean; userStopped?: boolean } = { cancelled: false };
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
          // Persist partial content immediately so it survives a page refresh.
          // The final persistence after agent completion will overwrite this.
          void this.persistPartialOnDisconnect();

          // Safety timeout: if the agent hasn't completed within 120s after
          // disconnect, force-stop it to avoid indefinite resource usage.
          setTimeout(() => {
            if (!this.isComplete) {
              log.warn('Force-stopping agent after SSE disconnect timeout', {
                agentId: this.options.agentId,
              });
              this.cancelToken.userStopped = true;
            }
          }, 120_000);
        }
      });

      if (this.options.persistUserMessage && !this.options.isResume) {
        this.sessionId = await this.options.persistUserMessage(
          this.options.agentId,
          this.options.userText,
          this.options.senderId,
          this.options.images,
          this.options.sessionId,
        );
      } else if (this.options.isResume) {
        this.sessionId = this.options.sessionId ?? null;
      }

      // Deliver sessionId early so the client can persist it even if the stream
      // is aborted before the final 'done' event arrives.
      if (this.sessionId && this.sseBuffer && !this.sseDisconnected) {
        this.sseBuffer.send({ type: 'session_start', sessionId: this.sessionId });
      }

      const reply = await this.options.agent.sendMessageStream(
        this.options.userText,
        (event) => this.handleStreamEvent(event),
        this.options.senderId,
        this.options.senderInfo,
        this.cancelToken,
        this.options.images,
        this.options.fileNames,
        {
          ...(this.options.isResume ? { isResume: true } : {}),
          ...(this.options.sessionRestore !== undefined ? { sessionRestore: this.options.sessionRestore } : {}),
        },
      );

      if (reply === '[merged]') {
        log.info('Message was merged into active processing — closing SSE without persisting', {
          agentId: this.options.agentId,
        });
        if (this.sseBuffer && !this.sseDisconnected) {
          this.sseBuffer.send({ type: 'done', content: '', merged: true, sessionId: this.sessionId, segments: [] });
          setTimeout(() => { if (this.sseBuffer) this.sseBuffer.close(); }, 100);
        }
        this.isComplete = true;
        return;
      }

      const finalNow = new Date().toISOString();
      let finalThinking: string | undefined;
      if (this.thinkingBuf) {
        if (this.sseBuffer && !this.sseDisconnected) {
          this.sseBuffer.send({ type: 'thinking_commit', thinking: this.thinkingBuf, createdAt: finalNow });
        }
        finalThinking = this.thinkingBuf;
        this.thinkingBuf = '';
      }
      if (this.textBuf) {
        if (this.sseBuffer && !this.sseDisconnected) {
          this.sseBuffer.send({ type: 'text_commit', text: this.textBuf, createdAt: finalNow });
        }
        const seg: typeof this.msgSegments[number] = { type: 'text' as const, content: this.textBuf, createdAt: finalNow };
        if (finalThinking) (seg as { thinking?: string }).thinking = finalThinking;
        this.msgSegments.push(seg);
        this.textBuf = '';
      } else if (finalThinking) {
        this.msgSegments.push({ type: 'text', content: '', thinking: finalThinking, createdAt: finalNow });
      }

      const wasCancelled = !!this.cancelToken.userStopped;
      this.finalizeRunningTools();

      // Build the best available reply content for persistence.
      // If the agent returned empty/cancelled, reconstruct from accumulated segments.
      const isCancelledReply = !reply || reply === '[Stream cancelled]' || reply === '[cancelled]';
      let persistReply = reply;
      if (isCancelledReply) {
        const segText = this.msgSegments
          .filter(s => s.type === 'text')
          .map(s => (s as { content: string }).content)
          .join('');
        persistReply = segText || '';
      }
      // Strip completion marker from persisted/displayed reply
      persistReply = persistReply.replaceAll(COMPLETION_MARKER, '').trim() || persistReply;

      if (this.sseDisconnected) {
        // Only send WS fallback if there is real content — don't broadcast
        // empty/cancelled markers when the user aborted the stream.
        if (persistReply && !isCancelledReply) {
          log.info('Agent finished but SSE was disconnected — delivering reply via WebSocket fallback', {
            agentId: this.options.agentId,
            replyLength: persistReply.length,
          });
          if (this.options.wsBroadcaster) {
            if (this.options.wsBroadcaster.broadcastProactiveMessage && this.sessionId) {
              const agentName = this.options.agent.config?.name ?? this.options.agentId;
              this.options.wsBroadcaster.broadcastProactiveMessage(
                this.options.agentId, agentName, this.sessionId,
                `ws_fallback_${Date.now()}`, persistReply,
                { isMainSession: true, isWsFallback: true, sessionId: this.sessionId },
                this.options.senderId,
              );
            } else {
              this.options.wsBroadcaster.broadcastChat(this.options.agentId, persistReply, 'agent');
            }
          }
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

      const hasSegments = this.msgSegments.length > 0 && this.msgSegments.some(s =>
        (s.type === 'text' && ((s as { content?: string }).content || (s as { thinking?: string }).thinking)) || s.type === 'tool'
      );
      if (this.options.persistAssistantMessage && this.sessionId && (persistReply || hasSegments)) {
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
        this.msgSegments.push({ type: 'text', content: this.textBuf, createdAt: new Date().toISOString() });
        this.textBuf = '';
      }
      this.msgSegments.push({ type: 'text', content: errSuffix.trim(), createdAt: new Date().toISOString() });

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
   * Persist whatever content has been accumulated so far when the SSE
   * connection drops.  This is a best-effort snapshot — the final
   * persistence after agent completion will overwrite it with the
   * authoritative result.
   */
  private async persistPartialOnDisconnect(): Promise<void> {
    if (!this.options.persistAssistantMessage || !this.sessionId) return;

    const segments = [...this.msgSegments];
    // Snapshot running tools as stopped
    for (const rt of this.runningTools) {
      segments.push({
        type: 'tool',
        tool: rt.tool,
        status: 'stopped',
        arguments: rt.arguments,
        durationMs: Date.now() - rt.startedAt,
        createdAt: new Date().toISOString(),
      });
    }
    // Include any buffered text
    if (this.textBuf) {
      segments.push({ type: 'text', content: this.textBuf, createdAt: new Date().toISOString() });
    }

    const partialText = segments
      .filter(s => s.type === 'text')
      .map(s => (s as { content: string }).content)
      .join('');

    if (!partialText && segments.length === 0) return;

    const meta: Record<string, unknown> = { isStopped: true };
    if (segments.length > 0) meta.segments = segments;

    try {
      await this.options.persistAssistantMessage(
        this.sessionId, this.options.agentId, partialText, 0, meta,
      );
      log.info('Persisted partial content on SSE disconnect', {
        agentId: this.options.agentId,
        segmentCount: segments.length,
        textLength: partialText.length,
      });
    } catch (e) {
      log.error('Failed to persist partial content on disconnect', {
        agentId: this.options.agentId, error: String(e),
      });
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
        createdAt: new Date().toISOString(),
      });
    }
    this.runningTools = [];
  }

  /**
   * 处理流式事件
   */
  private handleStreamEvent(event: AgentStreamEvent): void {
    if (!this.sseBuffer || this.sseDisconnected) return;

    // Delay agent_tool start events until AFTER thinking_commit/text_commit
    // flushes, so the client receives them in correct order.
    if (!(event.type === 'agent_tool' && event.phase === 'start')) {
      this.sseBuffer.send({ ...event });
    }
    
    if (event.type === 'thinking_delta' && event.thinking) {
      this.thinkingBuf += event.thinking;
    }

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
        const now = new Date().toISOString();
        let turnThinking: string | undefined;
        if (this.thinkingBuf) {
          this.sseBuffer.send({ type: 'thinking_commit', thinking: this.thinkingBuf, createdAt: now });
          turnThinking = this.thinkingBuf;
          this.thinkingBuf = '';
        }
        if (this.textBuf) { 
          const seg: typeof this.msgSegments[number] = { type: 'text' as const, content: this.textBuf, createdAt: now };
          if (turnThinking) (seg as { thinking?: string }).thinking = turnThinking;
          this.msgSegments.push(seg); 
          this.sseBuffer.send({ type: 'text_commit', text: this.textBuf, createdAt: now });
          this.textBuf = ''; 
        } else if (turnThinking) {
          this.msgSegments.push({ type: 'text', content: '', thinking: turnThinking, createdAt: now });
        }
        // Send agent_tool start AFTER thinking/text commits
        this.sseBuffer.send({ ...event });
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
          createdAt: new Date().toISOString(),
        });
        this.sseBuffer.sendProgress(this.processedTokens, this.totalTokens, `工具执行完成: ${event.tool}`);
      }
    } else if (event.type === 'message_end') {
      // Do NOT flush textBuf/thinkingBuf here.  The agent's
      // streamMarkerDelta buffers the last N characters to strip completion
      // markers, so textBuf is still incomplete at this point.  The
      // remaining chars arrive via text_delta after streamMarkerDelta.flush()
      // (which runs after chatStream returns).  The complete text is then
      // flushed at the next agent_tool start or at stream end.
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
    this.cancelToken.userStopped = true;
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
