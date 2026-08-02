/**
 * SSEHandler — the single canonical handler for Server-Sent Events streaming
 * from agent message processing to the web UI.
 *
 * Responsibilities:
 * - Manages the SSE connection lifecycle (open → stream → close / reattach)
 * - Buffers text/tool events via SSEBuffer for reliable delivery
 * - Accumulates events in ActiveStreamRegistry for refresh reattach
 * - Persists user/assistant messages and execution stream entries
 * - Soft-disconnect (refresh) does NOT cancel the agent; user Stop does
 * - Handles WS fallback broadcast on disconnect when reattach is unavailable
 */
import type { ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Agent } from '@markus/core';
import { createLogger, stripCompletionMarkerLeak, SSE_DISCONNECT_FORCE_STOP_MS, type LLMStreamEvent } from '@markus/shared';
import { SSEBuffer } from './sse-buffer.js';
import type { ActiveStreamRegistry, ActiveStreamSession } from './active-stream-registry.js';

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
  persistUserMessage?: (agentId: string, text: string, senderId?: string, images?: string[], sessionId?: string) => Promise<string | { sessionId: string; messageId?: string } | null>;
  /** Optional: remove a just-persisted user message when the turn was merged into an active one. */
  deleteUserMessage?: (messageId: string) => void;
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
  /** Registry for refresh reattach (optional — when omitted, soft-disconnect still avoids cancel). */
  activeStreams?: ActiveStreamRegistry;
}

/**
 * 处理SSE流式响应的统一处理器
 */
export class SSEHandler {
  private options: SSEMessageHandlerOptions;
  private sseBuffer: SSEBuffer | null = null;
  private msgSegments: Array<{type: 'text'; content: string; thinking?: string; createdAt?: string} | {type: 'tool'; tool: string; status: 'running' | 'done' | 'error' | 'stopped'; arguments?: unknown; result?: string; error?: string; durationMs?: number; createdAt?: string; subagentLogs?: Array<{ eventType: string; content: string; metadata?: Record<string, unknown> }>}> = [];
  private textBuf = '';
  private thinkingBuf = '';
  private runningTools: Array<{tool: string; arguments?: unknown; startedAt: number; subagentLogs?: Array<{ eventType: string; content: string; metadata?: Record<string, unknown> }>}> = [];
  private totalTokens = 0;
  private processedTokens = 0;
  private isProcessing = false;
  private isComplete = false;
  private sseDisconnected = false;
  private cancelToken: { cancelled: boolean; userStopped?: boolean } = { cancelled: false };
  private sessionId: string | null = null;
  private streamId = randomUUID();
  private assistantMessageId: string;
  private activeStream: ActiveStreamSession | null = null;
  private forceStopTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotSyncTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: SSEMessageHandlerOptions) {
    this.options = options;
    this.assistantMessageId = options.messageId ?? `cm_stream_${randomUUID()}`;
  }

  /** Coalesce high-frequency subagent progress into snapshot updates for reattach. */
  private scheduleUiSnapshotSync(immediate = false): void {
    if (immediate) {
      if (this.snapshotSyncTimer) {
        clearTimeout(this.snapshotSyncTimer);
        this.snapshotSyncTimer = null;
      }
      this.syncUiSnapshot();
      return;
    }
    if (this.snapshotSyncTimer) return;
    this.snapshotSyncTimer = setTimeout(() => {
      this.snapshotSyncTimer = null;
      this.syncUiSnapshot();
    }, 200);
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
          // Soft disconnect (refresh / nav): do NOT cancel the agent.
          // Only user Stop / force-stop sets cancelToken.
          log.info('SSE client disconnected — detaching (agent continues)', {
            agentId: this.options.agentId,
            streamId: this.streamId,
          });
          void this.persistPartialOnDisconnect();

          if (this.forceStopTimer) clearTimeout(this.forceStopTimer);
          this.forceStopTimer = setTimeout(() => {
            if (!this.isComplete && !this.cancelToken.userStopped) {
              log.warn('Force-stopping agent after SSE disconnect grace period', {
                agentId: this.options.agentId,
                graceMs: SSE_DISCONNECT_FORCE_STOP_MS,
              });
              this.cancelToken.cancelled = true;
              this.cancelToken.userStopped = true;
              this.activeStream?.cancel({
                type: 'done',
                content: '',
                cancelled: true,
                sessionId: this.sessionId,
              });
            }
          }, SSE_DISCONNECT_FORCE_STOP_MS);
        }
      });

      let persistedUserMessageId: string | undefined;
      if (this.options.persistUserMessage && !this.options.isResume) {
        const persisted = await this.options.persistUserMessage(
          this.options.agentId,
          this.options.userText,
          this.options.senderId,
          this.options.images,
          this.options.sessionId,
        );
        if (typeof persisted === 'string') {
          this.sessionId = persisted;
        } else if (persisted) {
          this.sessionId = persisted.sessionId;
          persistedUserMessageId = persisted.messageId;
        } else {
          this.sessionId = this.options.sessionId ?? null;
        }
      } else if (this.options.isResume) {
        this.sessionId = this.options.sessionId ?? null;
      } else {
        this.sessionId = this.options.sessionId ?? null;
      }

      if (this.sessionId && this.options.activeStreams) {
        this.activeStream = this.options.activeStreams.register({
          streamId: this.streamId,
          agentId: this.options.agentId,
          sessionId: this.sessionId,
          messageId: this.assistantMessageId,
        });
      }

      // Deliver sessionId early so the client can persist it even if the stream
      // is aborted before the final 'done' event arrives.
      if (this.sessionId) {
        this.emitEvent({
          type: 'session_start',
          sessionId: this.sessionId,
          streamId: this.streamId,
          messageId: this.assistantMessageId,
          userMessageId: persistedUserMessageId,
        });
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
        log.info('Message was merged into active processing — closing SSE without persisting assistant', {
          agentId: this.options.agentId,
        });
        // The follow-up was absorbed into the live turn. Drop the standalone DB
        // user row so reload does not show an extra bubble for the merged text.
        if (persistedUserMessageId && this.options.deleteUserMessage) {
          try {
            this.options.deleteUserMessage(persistedUserMessageId);
          } catch (err) {
            log.warn('Failed to delete merged user message', { error: String(err) });
          }
        }
        const mergedDone = {
          type: 'done' as const,
          content: '',
          merged: true,
          sessionId: this.sessionId,
          userMessageId: persistedUserMessageId,
          segments: [] as unknown[],
        };
        if (this.sseBuffer && !this.sseDisconnected) {
          this.sseBuffer.send(mergedDone);
        }
        this.activeStream?.complete(mergedDone);
        if (this.sseBuffer && !this.sseDisconnected) {
          setTimeout(() => { if (this.sseBuffer) this.sseBuffer.close(); }, 100);
        }
        this.isComplete = true;
        return;
      }

      const finalNow = new Date().toISOString();
      let finalThinking: string | undefined;
      if (this.thinkingBuf) {
        this.emitEvent({ type: 'thinking_commit', thinking: this.thinkingBuf, createdAt: finalNow });
        finalThinking = this.thinkingBuf;
        this.thinkingBuf = '';
      }
      if (this.textBuf) {
        this.emitEvent({ type: 'text_commit', text: this.textBuf, createdAt: finalNow });
        const seg: typeof this.msgSegments[number] = { type: 'text' as const, content: this.textBuf, createdAt: finalNow };
        if (finalThinking) (seg as { thinking?: string }).thinking = finalThinking;
        this.msgSegments.push(seg);
        this.textBuf = '';
      } else if (finalThinking) {
        this.msgSegments.push({ type: 'text', content: '', thinking: finalThinking, createdAt: finalNow });
      }

      const wasCancelled = !!this.cancelToken.userStopped;
      this.finalizeRunningTools();
      this.syncUiSnapshot();

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
      // Strip completion marker (and malformed variants) from persisted/displayed reply
      persistReply = stripCompletionMarkerLeak(persistReply).trim() || persistReply;

      // Empty assistant turn (cancel / failed start) — still a terminal outcome the
      // client must see as stopped/error so Retry is available after refresh.
      const isEmptyTerminal = !persistReply && this.msgSegments.every(s =>
        s.type !== 'tool' && !(s.type === 'text' && ((s as { content?: string }).content || (s as { thinking?: string }).thinking))
      );
      const treatAsStopped = wasCancelled || (isCancelledReply && isEmptyTerminal);

      const donePayload = {
        type: 'done' as const,
        content: persistReply,
        agentId: this.options.agentId,
        sessionId: this.sessionId,
        segments: this.msgSegments,
        streamId: this.streamId,
        messageId: this.assistantMessageId,
        cancelled: treatAsStopped || undefined,
        emptyReply: isEmptyTerminal || undefined,
      };

      if (this.sseDisconnected) {
        // Prefer active-stream reattach; still WS-fallback for open clients that
        // never reattached and have no registry subscription.
        if (persistReply && !isCancelledReply && !this.activeStream) {
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
        // Always push done into the ring so reattached clients finish cleanly.
        this.activeStream?.complete(donePayload);
      } else {
        // Live client: write done to SSE without double-pushing into the ring
        // (complete() already pushes the terminal event).
        if (this.sseBuffer && !this.sseDisconnected) {
          this.sseBuffer.send(donePayload);
        }
        this.activeStream?.complete(donePayload);

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
      // Persist empty cancelled/failed replies too — otherwise refresh wipes the
      // bubble and the user has no Retry target.
      if (this.options.persistAssistantMessage && this.sessionId && (persistReply || hasSegments || treatAsStopped || isEmptyTerminal)) {
        const msgMeta: Record<string, unknown> = {
          isStreaming: false,
          streamId: this.streamId,
        };
        if (this.msgSegments.length > 0) msgMeta.segments = this.msgSegments;
        if (treatAsStopped) msgMeta.isStopped = true;
        if (isEmptyTerminal && !treatAsStopped) msgMeta.isError = true;
        if (isEmptyTerminal) msgMeta.emptyReply = true;
        const storedContent = persistReply || (isEmptyTerminal ? '' : persistReply);
        try {
          await this.options.persistAssistantMessage(
            this.sessionId,
            this.options.agentId,
            storedContent,
            this.options.agent.getState().tokensUsedToday,
            msgMeta,
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
      if (this.forceStopTimer) {
        clearTimeout(this.forceStopTimer);
        this.forceStopTimer = null;
      }
      
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

      // Mark complete BEFORE handleError schedules sseBuffer.close(). Otherwise
      // onClose sees !isComplete and persistPartialOnDisconnect() rewrites the
      // row with isStreaming:true — UI stays on「思考中」even after the turn
      // failed (and after restart, with no live agent work).
      this.isComplete = true;

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
      const errMeta = { isError: true, isStreaming: false, streamId: this.streamId, segments: this.msgSegments };

      if (this.options.persistAssistantMessage && this.sessionId) {
        try {
          await this.options.persistAssistantMessage(
            this.sessionId, this.options.agentId, errReply, 0, errMeta,
          );
        } catch (e) {
          log.error('Failed to persist error message', { agentId: this.options.agentId, error: String(e) });
        }
      }
      this.activeStream?.complete({
        type: 'error',
        error: String(error).slice(0, 500),
        sessionId: this.sessionId,
        streamId: this.streamId,
      });
      if (this.options.onError) {
        void this.options.onError(error, this.msgSegments)
          .catch(e => log.warn('onError callback failed', { error: String(e) }));
      }
    } finally {
      this.isProcessing = false;
      if (this.forceStopTimer) {
        clearTimeout(this.forceStopTimer);
        this.forceStopTimer = null;
      }
    }
  }

  /** Emit to live SSE (if connected) and always to the reattach ring buffer. */
  private emitEvent(event: { type: string; [key: string]: unknown }): void {
    this.activeStream?.push(event);
    if (this.sseBuffer && !this.sseDisconnected) {
      this.sseBuffer.send(event);
    }
  }

  /**
   * Publish compact UI state for refresh reattach. Ring buffers of text_delta can
   * drop early tool events; the snapshot keeps tools/text authoritative.
   */
  private syncUiSnapshot(): void {
    if (!this.activeStream) return;
    const segments = [
      ...this.msgSegments,
      ...this.runningTools.map(rt => ({
        type: 'tool' as const,
        tool: rt.tool,
        status: 'running' as const,
        arguments: rt.arguments,
        durationMs: Date.now() - rt.startedAt,
        createdAt: new Date(rt.startedAt).toISOString(),
        ...(rt.subagentLogs?.length ? { subagentLogs: rt.subagentLogs } : {}),
      })),
    ];
    if (this.textBuf) {
      segments.push({
        type: 'text',
        content: this.textBuf,
        ...(this.thinkingBuf ? { thinking: this.thinkingBuf } : {}),
        createdAt: new Date().toISOString(),
      });
    } else if (this.thinkingBuf) {
      segments.push({
        type: 'text',
        content: '',
        thinking: this.thinkingBuf,
        createdAt: new Date().toISOString(),
      });
    }
    const content = segments
      .filter(s => s.type === 'text')
      .map(s => ('content' in s ? s.content : '') || '')
      .join('');
    this.activeStream.setUiSnapshot({
      content,
      segments,
      thinking: this.thinkingBuf || undefined,
    });
  }

  private persistSegmentsToExecutionStream(): void {
    const repo = this.options.executionStreamRepo;
    if (!repo) return;
    const messageId = this.assistantMessageId;

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
   * connection drops. Soft disconnect marks isStreaming so refresh can reattach.
   */
  private async persistPartialOnDisconnect(): Promise<void> {
    // Turn already finished (success or error) — never re-mark as streaming.
    if (this.isComplete) return;
    if (!this.options.persistAssistantMessage || !this.sessionId) return;

    this.syncUiSnapshot();

    const segments = [...this.msgSegments];
    // Snapshot in-flight tools as still running so refresh UI doesn't look "stopped"
    // while the agent continues (reattach will update to done/error).
    for (const rt of this.runningTools) {
      segments.push({
        type: 'tool',
        tool: rt.tool,
        status: 'running',
        arguments: rt.arguments,
        durationMs: Date.now() - rt.startedAt,
        createdAt: new Date().toISOString(),
        ...(rt.subagentLogs?.length ? { subagentLogs: rt.subagentLogs } : {}),
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

    const meta: Record<string, unknown> = {
      isStreaming: true,
      streamId: this.streamId,
    };
    if (segments.length > 0) meta.segments = segments;

    // Re-check: error/success may have completed while we were building the
    // snapshot (persistPartial is fire-and-forget from onClose).
    if (this.isComplete) return;

    try {
      await this.options.persistAssistantMessage(
        this.sessionId, this.options.agentId, partialText, 0, meta,
      );
      log.info('Persisted partial streaming content on SSE disconnect', {
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
        ...(rt.subagentLogs?.length ? { subagentLogs: rt.subagentLogs } : {}),
      });
    }
    this.runningTools = [];
  }

  /**
   * 处理流式事件 — always update internal state; wire writes only when connected.
   */
  private handleStreamEvent(event: AgentStreamEvent): void {
    // Delay agent_tool start events until AFTER thinking_commit/text_commit
    // flushes, so the client receives them in correct order.
    if (!(event.type === 'agent_tool' && event.phase === 'start')) {
      this.emitEvent({ ...event });
    }
    
    if (event.type === 'thinking_delta' && event.thinking) {
      this.thinkingBuf += event.thinking;
    }

    if (event.type === 'text_delta' && event.text) {
      this.textBuf += event.text;
      this.syncUiSnapshot();

      if (this.options.onTextDelta) {
        this.options.onTextDelta(event.text);
      }
      
      const tokenEstimate = Math.ceil(event.text.length * 0.75);
      this.processedTokens += tokenEstimate;
      this.totalTokens = Math.max(this.totalTokens, this.processedTokens + 50);
      
      if (tokenEstimate >= 50 || this.processedTokens % 50 < tokenEstimate) {
        this.emitEvent({
          type: 'progress',
          current: this.processedTokens,
          total: this.totalTokens,
          message: '正在生成回复...',
        });
      }
    } else if (event.type === 'agent_tool') {
      if (this.options.onToolEvent) {
        this.options.onToolEvent(event);
      }
      
      if (event.phase === 'start') {
        const now = new Date().toISOString();
        let turnThinking: string | undefined;
        if (this.thinkingBuf) {
          this.emitEvent({ type: 'thinking_commit', thinking: this.thinkingBuf, createdAt: now });
          turnThinking = this.thinkingBuf;
          this.thinkingBuf = '';
        }
        if (this.textBuf) { 
          const seg: typeof this.msgSegments[number] = { type: 'text' as const, content: this.textBuf, createdAt: now };
          if (turnThinking) (seg as { thinking?: string }).thinking = turnThinking;
          this.msgSegments.push(seg); 
          this.emitEvent({ type: 'text_commit', text: this.textBuf, createdAt: now });
          this.textBuf = ''; 
        } else if (turnThinking) {
          this.msgSegments.push({ type: 'text', content: '', thinking: turnThinking, createdAt: now });
        }
        // Send agent_tool start AFTER thinking/text commits
        this.emitEvent({ ...event });
        if (event.tool) {
          this.runningTools.push({ tool: event.tool, arguments: event.arguments, startedAt: Date.now() });
        }
        this.syncUiSnapshot();
        this.emitEvent({
          type: 'progress',
          current: this.processedTokens,
          total: this.totalTokens,
          message: `正在执行工具: ${event.tool}`,
        });
      } else if (event.phase === 'end' && event.tool) {
        const ended = [...this.runningTools].reverse().find(t => t.tool === event.tool);
        this.runningTools = this.runningTools.filter(t => t !== ended);
        this.msgSegments.push({ 
          type: 'tool', 
          tool: event.tool, 
          status: event.success === false ? 'error' : 'done',
          arguments: event.arguments,
          result: event.result,
          error: event.error,
          durationMs: event.durationMs,
          createdAt: new Date().toISOString(),
          ...(ended?.subagentLogs?.length ? { subagentLogs: ended.subagentLogs } : {}),
        });
        this.syncUiSnapshot();
        this.emitEvent({
          type: 'progress',
          current: this.processedTokens,
          total: this.totalTokens,
          message: `工具执行完成: ${event.tool}`,
        });
      }
    } else if (event.type === 'subagent_progress' && event.tool && event.subagentEvent) {
      const reversed = [...this.runningTools].reverse();
      const target = reversed.find(t => t.tool === event.tool)
        ?? reversed.find(t => t.tool === 'spawn_subagent' || t.tool === 'spawn_subagents');
      if (target) {
        const se = event.subagentEvent;
        target.subagentLogs = [
          ...(target.subagentLogs ?? []),
          { eventType: se.eventType, content: se.content, ...(se.metadata ? { metadata: se.metadata } : {}) },
        ];
        // Keep reattach snapshot fresh so refresh mid-run shows nested progress.
        const flush = se.eventType === 'completed' || se.eventType === 'error';
        this.scheduleUiSnapshotSync(flush);
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
      this.emitEvent({
        type: 'progress',
        current: this.processedTokens,
        total: this.totalTokens,
        message: '回复生成完成',
      });
    }
  }

  /**
   * 处理错误
   */
  private handleError(error: unknown, res: ServerResponse): void {
    try {
      const errMsg = typeof error === 'string' ? error : (error instanceof Error ? error.message : String(error));
      const payload = {
        type: 'error',
        error: errMsg,
        sessionId: this.sessionId,
        recoverable: false,
        timestamp: Date.now(),
        streamId: this.streamId,
      };
      this.emitEvent(payload);
      if (this.sseBuffer && !this.sseDisconnected) {
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
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
        res.end();
      }
    } catch (e) {
      log.error('Error handling SSE error', { error: String(e) });
    }
  }

  /**
   * 取消处理 (user Stop)
   */
  cancel(): void {
    this.cancelToken.cancelled = true;
    this.cancelToken.userStopped = true;
    this.activeStream?.cancel({
      type: 'done',
      content: '',
      cancelled: true,
      sessionId: this.sessionId,
      streamId: this.streamId,
    });
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

  getSegments(): Array<{type: 'text'; content: string} | {type: 'tool'; tool: string; status: 'running' | 'done' | 'error' | 'stopped'}> {
    return [...this.msgSegments];
  }

  getTextBuffer(): string {
    return this.textBuf;
  }
}
