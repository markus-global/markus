/**
 * Tracks in-flight chat generations so clients can reattach after refresh.
 * Soft SSE disconnect detaches writers only — the agent keeps running and
 * events continue to accumulate in a ring buffer for replay.
 */
import type { ServerResponse } from 'node:http';
import { createLogger } from '@markus/shared';

const log = createLogger('active-stream');

export type StreamEventPayload = Record<string, unknown>;

export interface BufferedStreamEvent {
  seq: number;
  ts: number;
  event: StreamEventPayload;
}

/** Authoritative UI state for refresh reattach (tools + text), independent of ring truncation. */
export interface StreamUiSnapshot {
  content: string;
  segments: unknown[];
  thinking?: string;
  updatedAt: number;
}

type Subscriber = (event: BufferedStreamEvent) => void;

const RING_CAP = 2500;
/** Keep finished streams briefly so a late reattach still gets the final `done`. */
const DONE_TTL_MS = 90_000;

export class ActiveStreamSession {
  readonly streamId: string;
  readonly agentId: string;
  sessionId: string;
  readonly messageId: string;
  private seq = 0;
  private ring: BufferedStreamEvent[] = [];
  private subscribers = new Set<Subscriber>();
  status: 'streaming' | 'done' | 'error' | 'cancelled' = 'streaming';
  private donePayload?: StreamEventPayload;
  private ttlTimer: ReturnType<typeof setTimeout> | null = null;
  private onDispose?: () => void;
  private uiSnapshot: StreamUiSnapshot | null = null;

  constructor(opts: {
    streamId: string;
    agentId: string;
    sessionId: string;
    messageId: string;
    onDispose?: () => void;
  }) {
    this.streamId = opts.streamId;
    this.agentId = opts.agentId;
    this.sessionId = opts.sessionId;
    this.messageId = opts.messageId;
    this.onDispose = opts.onDispose;
  }

  get lastSeq(): number {
    return this.seq;
  }

  /** Keep a compact UI snapshot so refresh can restore tool cards even if the ring dropped early events. */
  setUiSnapshot(snapshot: Omit<StreamUiSnapshot, 'updatedAt'>): void {
    this.uiSnapshot = {
      content: snapshot.content,
      segments: snapshot.segments,
      thinking: snapshot.thinking,
      updatedAt: Date.now(),
    };
  }

  getUiSnapshot(): StreamUiSnapshot | null {
    return this.uiSnapshot;
  }

  push(event: StreamEventPayload): BufferedStreamEvent {
    const wrapped: BufferedStreamEvent = {
      seq: ++this.seq,
      ts: Date.now(),
      event: { ...event, seq: this.seq },
    };
    this.ring.push(wrapped);
    if (this.ring.length > RING_CAP) this.ring.shift();
    for (const sub of this.subscribers) {
      try {
        sub(wrapped);
      } catch (err) {
        log.warn('Active stream subscriber failed', { error: String(err) });
      }
    }
    return wrapped;
  }

  complete(payload: StreamEventPayload): void {
    this.status = payload.type === 'error' ? 'error' : 'done';
    this.donePayload = payload;
    this.push(payload);
    this.scheduleDispose();
  }

  cancel(payload?: StreamEventPayload): void {
    this.status = 'cancelled';
    this.donePayload = payload ?? {
      type: 'done',
      content: '',
      cancelled: true,
      sessionId: this.sessionId,
    };
    this.push(this.donePayload);
    this.scheduleDispose();
  }

  private scheduleDispose(): void {
    if (this.ttlTimer) clearTimeout(this.ttlTimer);
    this.ttlTimer = setTimeout(() => {
      this.subscribers.clear();
      this.onDispose?.();
    }, DONE_TTL_MS);
  }

  /**
   * Attach an SSE response.
   * Prefer an authoritative UI snapshot (tools + text) so refresh restores tool
   * cards even when the ring buffer has dropped early text_delta/tool events.
   * Then live-tail new events. Falls back to ring replay when no snapshot exists.
   */
  attach(res: ServerResponse, afterSeq = 0): void {
    if (res.headersSent) {
      log.warn('Cannot attach active stream — headers already sent', {
        streamId: this.streamId,
      });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });

    const write = (payload: StreamEventPayload) => {
      if (res.writableEnded || res.destroyed) return;
      try {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch (err) {
        log.warn('Failed writing reattach SSE event', { error: String(err) });
      }
    };

    write({
      type: 'reattach',
      streamId: this.streamId,
      sessionId: this.sessionId,
      messageId: this.messageId,
      lastSeq: this.seq,
      status: this.status,
      hasSnapshot: !!this.uiSnapshot,
    });

    // Full rebuild from start: snapshot is authoritative for prior tool/text UI.
    const useSnapshot = !!this.uiSnapshot && afterSeq <= 0;
    let lastWrittenSeq = afterSeq;
    if (useSnapshot && this.uiSnapshot) {
      const snapshotSeq = this.seq;
      lastWrittenSeq = snapshotSeq;
      write({
        type: 'snapshot',
        streamId: this.streamId,
        sessionId: this.sessionId,
        messageId: this.messageId,
        content: this.uiSnapshot.content,
        segments: this.uiSnapshot.segments,
        thinking: this.uiSnapshot.thinking,
        snapshotSeq,
        updatedAt: this.uiSnapshot.updatedAt,
      });
    }

    const writeOnce = (item: BufferedStreamEvent) => {
      if (item.seq <= lastWrittenSeq) return;
      lastWrittenSeq = item.seq;
      write(item.event);
    };

    if (this.status !== 'streaming') {
      if (useSnapshot && this.donePayload) {
        write(this.donePayload);
      } else {
        for (const item of this.ring) writeOnce(item);
      }
      res.end();
      return;
    }

    // Subscribe before backlog drain so events that arrive mid-attach aren't lost.
    const sub: Subscriber = (item) => {
      writeOnce(item);
      if (
        item.event.type === 'done' ||
        item.event.type === 'error' ||
        this.status !== 'streaming'
      ) {
        this.subscribers.delete(sub);
        if (!res.writableEnded) res.end();
      }
    };
    this.subscribers.add(sub);

    if (useSnapshot) {
      // Only events newer than the snapshot (live gap + future).
      for (const item of this.ring) writeOnce(item);
    } else {
      for (const item of this.ring) {
        if (item.seq > afterSeq) writeOnce(item);
      }
    }

    const cleanup = () => {
      this.subscribers.delete(sub);
    };
    res.on('close', cleanup);
    res.on('error', cleanup);
  }
}

export class ActiveStreamRegistry {
  private bySession = new Map<string, ActiveStreamSession>();
  private byStreamId = new Map<string, ActiveStreamSession>();

  private key(agentId: string, sessionId: string): string {
    return `${agentId}:${sessionId}`;
  }

  register(opts: {
    streamId: string;
    agentId: string;
    sessionId: string;
    messageId: string;
  }): ActiveStreamSession {
    const existing = this.bySession.get(this.key(opts.agentId, opts.sessionId));
    if (existing && existing.status === 'streaming') {
      // Replace stale registration for the same session.
      this.unregister(existing);
    }

    const session = new ActiveStreamSession({
      ...opts,
      onDispose: () => this.unregister(session),
    });
    this.bySession.set(this.key(opts.agentId, opts.sessionId), session);
    this.byStreamId.set(opts.streamId, session);
    log.info('Registered active stream', {
      streamId: opts.streamId,
      agentId: opts.agentId,
      sessionId: opts.sessionId,
    });
    return session;
  }

  unregister(session: ActiveStreamSession): void {
    const k = this.key(session.agentId, session.sessionId);
    if (this.bySession.get(k) === session) this.bySession.delete(k);
    if (this.byStreamId.get(session.streamId) === session) {
      this.byStreamId.delete(session.streamId);
    }
  }

  getByAgentSession(agentId: string, sessionId: string): ActiveStreamSession | undefined {
    return this.bySession.get(this.key(agentId, sessionId));
  }

  getByStreamId(streamId: string): ActiveStreamSession | undefined {
    return this.byStreamId.get(streamId);
  }

  /** Soft status probe for UI hydrate. */
  status(agentId: string, sessionId: string): {
    active: boolean;
    streamId?: string;
    messageId?: string;
    lastSeq?: number;
    status?: ActiveStreamSession['status'];
  } {
    const s = this.getByAgentSession(agentId, sessionId);
    if (!s) return { active: false };
    return {
      // Treat done/error within TTL as attachable so a late refresh can still
      // drain the terminal event (UI then hydrates from done segments).
      active: s.status === 'streaming' || s.status === 'done' || s.status === 'error',
      streamId: s.streamId,
      messageId: s.messageId,
      lastSeq: s.lastSeq,
      status: s.status,
    };
  }
}
