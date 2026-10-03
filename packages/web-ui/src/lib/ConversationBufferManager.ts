/**
 * ConversationBufferManager — Pure state machine for per-conversation message
 * buffer management. Zero React dependency; fully unit-testable.
 *
 * Each conversation key tracks a lifecycle phase that controls write permissions:
 *   idle → loading → ready → streaming → ready
 *
 * Key invariant: in `streaming` phase, DB load results write to cache only,
 * never to the display buffer. This eliminates race conditions by construction.
 */
import type { ChatMsg, ChatMode } from '../pages/ChatHelpers.ts';
import type { ActivityStep } from '../components/ActivityIndicator.tsx';
import type { ChatSessionInfo } from '../api.ts';

export type ConvPhase = 'idle' | 'loading' | 'ready' | 'streaming';

export interface BufferWriteResult {
  displayChanged: boolean;
  newMessages?: ChatMsg[];
}

export interface ActivityWriteResult {
  displayChanged: boolean;
  newActivities?: ActivityStep[];
}

export function makeConvKey(mode: ChatMode, agent: string, channel: string, dmUserId?: string): string {
  return mode === 'channel' ? `ch:${channel}` :
    mode === 'dm' ? `dm:${dmUserId ?? ''}` :
    (agent || '_direct');
}

export class ConversationBufferManager {
  currentConvKey = '';
  loadingSession: string | null = null;

  readonly msgBuffers = new Map<string, ChatMsg[]>();
  readonly sessionMsgCache = new Map<string, ChatMsg[]>();
  readonly activeSession = new Map<string, string>();
  readonly actBuffers = new Map<string, ActivityStep[]>();
  readonly sessionTabs = new Map<string, ChatSessionInfo[]>();

  private phase = new Map<string, ConvPhase>();
  private sendCount = new Map<string, number>();
  private streamingSessions = new Map<string, Set<string>>();
  private sessionCacheOrder: string[] = [];

  static readonly MAX_MESSAGES = 500;
  static readonly MAX_CONVERSATIONS = 20;
  static readonly MAX_SESSION_CACHE = 30;
  static readonly NEW_CHAT_ID = '__new_chat__';

  // ── Phase transitions ──

  /**
   * Effective phase for a conversation.
   *
   * The stored phase alone is NOT enough. `phase` is agent-level (one convKey =
   * one agent) while streams are tracked per SESSION, so with two tabs of the
   * same agent streaming at once, one turn finishing calls `endStream()` and
   * collapses the phase to 'ready' while the other turn is still live. Every
   * consumer that gated on the stored phase then declared the surviving turn
   * dead: the in-flight bubble lost its animated "outputting" border on the next
   * switch-back, and the sidebar showed the agent as idle.
   *
   * So the stored phase is an OVERRIDE for the windows where the ownership
   * record cannot speak (pre-registration: `beginStream` flips the phase before
   * `session_start` lands the mark). Whenever the set is non-empty, it wins.
   */
  getPhase(key: string): ConvPhase {
    const stored = this.phase.get(key) ?? 'idle';
    if (stored === 'streaming') return stored;
    return this.hasLiveStream(key) ? 'streaming' : stored;
  }

  /**
   * Is at least one stream genuinely in flight for this conversation?
   *
   * `streamingSessions` is the positive ownership record (added on
   * `setStreamSession`, released on done/abort/error). Single source of truth
   * for both "is the agent busy" and the derived phase above.
   */
  hasLiveStream(key: string): boolean {
    return (this.streamingSessions.get(key)?.size ?? 0) > 0;
  }

  beginLoad(key: string): void {
    if (this.getPhase(key) !== 'streaming') {
      this.phase.set(key, 'loading');
    }
  }

  completeLoad(key: string): void {
    if (this.getPhase(key) === 'loading') {
      this.phase.set(key, 'ready');
    }
  }

  beginStream(key: string): void {
    this.phase.set(key, 'streaming');
  }

  /**
   * Collapse the phase to 'ready' for this turn's end.
   *
   * Only meaningful when no other stream is live: while sibling tabs are still
   * streaming, `getPhase()` keeps reporting 'streaming' by virtue of the
   * ownership set, so flipping the stored value 'ready' is remembered but not
   * yet observable. It becomes the answer once the last mark is released.
   */
  endStream(key: string): void {
    if (this.getPhase(key) === 'streaming') {
      this.phase.set(key, 'ready');
    }
  }

  /**
   * Reset a conversation to empty idle state.
   *
   * CRITICAL (multi-session direct mode): `activeSession` is the single
   * routing gate that prevents stale streams from a PREVIOUS session writing
   * into a fresh buffer (see updateMessages → isSameSession). Every caller
   * MUST re-pin after reset — otherwise activeSession becomes undefined and
   * any still-running backend stream is treated as same-session and mixed in.
   * Passing `repinTo` makes reset + re-pin atomic so the ordering can never
   * be wrong. Pass NEW_CHAT_ID for a fresh conversation, or the session id
   * when switching to an existing session.
   */
  resetConv(key: string, repinTo?: string): void {
    this.phase.set(key, 'idle');
    this.activeSession.delete(key);
    if (repinTo) this.activeSession.set(key, repinTo);
  }

  // ── Message buffer writes ──

  updateMessages(
    key: string,
    updater: (prev: ChatMsg[]) => ChatMsg[],
    sessionId?: string | null,
  ): BufferWriteResult {
    const activeSessionId = this.activeSession.get(key);
    const routedToDisplay = this.isDisplayRoute(key, activeSessionId, sessionId);

    const source = routedToDisplay
      ? (this.msgBuffers.get(key) ?? [])
      : (this.sessionMsgCache.get(sessionId!) ?? []);

    let next = updater(source);
    if (next.length > ConversationBufferManager.MAX_MESSAGES) {
      next = next.slice(-ConversationBufferManager.MAX_MESSAGES);
    }

    let displayChanged = false;
    if (routedToDisplay) {
      this.msgBuffers.set(key, next);
      this.evictIfNeeded(key);
      displayChanged = this.currentConvKey === key;
    }
    if (sessionId && sessionId !== ConversationBufferManager.NEW_CHAT_ID) {
      this.sessionMsgCache.set(sessionId, next);
      this.touchSessionCache(sessionId);
    }

    return { displayChanged, newMessages: displayChanged ? next : undefined };
  }

  /**
   * Decide whether a message-buffer write may touch the shared display buffer.
   *
   * - Optimistic writes without a real session (`!sessionId`) always go to
   *   display — they are the user's own send in the currently-viewed view.
   * - When the routing gate is PINNED to a session, only that session may
   *   write to display. This is the structural guarantee that a background
   *   session's stream (another tab / still-running reattach) can never mix
   *   into the view (misordered bubbles / blank bubbles until refresh).
   * - When the gate is NOT pinned (undefined, or still on the new-chat
   *   placeholder), fall back to a conservative guard: only treat the write as
   *   display if the shared buffer visibly belongs to an in-flight stream
   *   (an unfinished agent bubble from the optimistic placeholder). Otherwise
   *   route to the session cache — a background stream can never corrupt the
   *   view even if a future caller forgets to pin the gate.
   */
  private isDisplayRoute(
    key: string,
    activeSessionId: string | undefined,
    sessionId?: string | null,
  ): boolean {
    if (!sessionId) return true;
    if (activeSessionId !== undefined && activeSessionId !== ConversationBufferManager.NEW_CHAT_ID) {
      return activeSessionId === sessionId;
    }
    const buf = this.msgBuffers.get(key) ?? [];
    for (let i = buf.length - 1; i >= Math.max(0, buf.length - 3); i--) {
      const m = buf[i];
      if (m?.sender === 'agent' && m.isStreaming && !m.isStopped) return true;
    }
    return false;
  }

  /**
   * Apply DB load result. Phase-aware: blocks display writes during streaming.
   * When phase is `streaming`, data goes to cache only, preserving in-flight
   * streaming content in the display buffer.
   */
  applyLoadResult(
    convKey: string,
    sessionId: string,
    msgs: ChatMsg[],
  ): BufferWriteResult {
    const cache = this.sessionMsgCache.get(sessionId);
    // A cached `isStreaming` bubble is authoritative ONLY while a stream is in
    // flight for THIS session. Once no stream is live it is stale local state —
    // the finalize ran on whichever buffer was routed and left the other one
    // behind. Both the freshness heuristic and the merge must ignore it, or the
    // stale row keeps the cache looking newer than the DB forever and the
    // authoritative list never gets to replace it (2026-10-02 report: an OLD
    // reply bubble re-appearing AFTER the newest message).
    const streamLive = this.isStreamLiveForSession(convKey, sessionId);
    const cacheIsFresher = this.isCacheFresher(sessionId, msgs, streamLive);
    if (!cacheIsFresher) {
      this.sessionMsgCache.set(sessionId, msgs);
      this.touchSessionCache(sessionId);
    }

    const phase = this.getPhase(convKey);
    // `streaming` is per-convKey (an agent-wide flag), while the in-flight
    // stream belongs to a SPECIFIC session. A DB load for a DIFFERENT session
    // must still be allowed to write the display buffer — otherwise switching
    // tabs shows a misleading "new chat" empty state instead of real history.
    //
    // The bypass is only granted when a different owner is POSITIVELY known.
    // `beginStream` flips the phase before the session mark is registered (and
    // a brand-new chat may never register one), so an empty/unknown membership
    // must NOT be read as "therefore it is not this session" — that window is
    // exactly where a stale DB response clobbers the in-flight display.
    const isStreamingPhase = phase === 'streaming';
    const streamingSet = this.streamingSessions.get(convKey);
    // "Another session owns the live stream" must be a POSITIVE claim: there has
    // to be a mark for a session that is neither the one being loaded NOR the
    // pre-registration placeholder. Treating the placeholder as a foreign owner
    // (the old `!set.has(sessionId)`) let a DB load replace the display in the
    // middle of a live turn — the mid-turn DB only holds the user row, so the
    // in-flight bubble was wiped and its animated border vanished on tab
    // switch-back while the turn was still running.
    const otherSessionStreaming = isStreamingPhase
      && Array.from(streamingSet ?? []).some(
        sid => sid !== sessionId && sid !== ConversationBufferManager.NEW_CHAT_ID,
      );
    // Accept the result when this session is still the one being loaded OR the
    // one the user is viewing. Relying only on `loadingSession` drops the first
    // response when a second load for the same conversation races ahead.
    //
    // …but that leniency must never let a load for a DIFFERENT session write the
    // shared display buffer. The display buffer is per-convKey (one agent = one
    // view), so with several tabs of the same agent streaming at once, a
    // background load landing for tab B used to satisfy `loadingSession` and
    // replace tab A's transcript — the turn the user was actually watching
    // vanished from under them. A positive pin to another session always wins.
    const activeSessionId = this.activeSession.get(convKey);
    const pinnedToOtherSession = activeSessionId !== undefined
      && activeSessionId !== ConversationBufferManager.NEW_CHAT_ID
      && activeSessionId !== sessionId;
    const isCurrentView = this.currentConvKey === convKey
      && !pinnedToOtherSession
      && (this.loadingSession === sessionId || activeSessionId === sessionId);

    if (isCurrentView && (!isStreamingPhase || otherSessionStreaming)) {
      // DB rows are the ordering authority (user bubbles are persisted before
      // the assistant reply). A fresher cache may only add live-tail messages
      // that the DB does not have yet — it must never hide DB user messages,
      // which is what caused "user bubble after the agent reply" until refresh.
      const displayMsgs = this.mergeDbWithCache(
        msgs,
        cacheIsFresher ? cache : undefined,
        streamLive,
      );
      this.msgBuffers.set(convKey, displayMsgs);
      this.loadingSession = sessionId;
      this.completeLoad(convKey);
      return { displayChanged: true, newMessages: displayMsgs };
    }

    return { displayChanged: false };
  }

  /**
   * Build the display list as: DB messages first (correct chronological order),
   * then any cache-only rows (e.g. a streaming tail not yet flushed to DB) that
   * are missing from DB, inserted by createdAt so late WS arrivals stay ordered.
   * Duplicates by id are dropped; user rows present in DB are never reordered.
   *
   * Ordering exception: LIVE-streaming agent bubbles are ALWAYS appended last.
   * Their rawCreatedAt is the OPTIMISTIC send-time (set before the server
   * persists the user message), which is EARLIER than the DB user row's
   * createdAt. Chronologically inserting them would place the in-flight agent
   * reply ABOVE the user message it answers — "user bubble appears below the
   * agent streaming bubble" when re-opening a tab mid-stream. The streaming
   * bubble is by definition the latest in-flight response, so the tail is
   * authoritative regardless of timestamps.
   */
  private mergeDbWithCache(
    dbMsgs: ChatMsg[],
    cache?: ChatMsg[],
    streamLive = false,
  ): ChatMsg[] {
    if (!cache || cache.length === 0) return [...dbMsgs];
    const byId = new Set<string>();
    const out: ChatMsg[] = [];
    for (const m of dbMsgs) {
      byId.add(m.id);
      out.push(m);
    }
    // Split cache-only rows: live streaming agent bubbles (must append last) vs
    // everything else (kept chronologically ordered among DB rows).
    const streamingTail: ChatMsg[] = [];
    const rest: ChatMsg[] = [];
    for (const cm of cache) {
      if (byId.has(cm.id)) continue;
      if (cm.sender === 'agent' && cm.isStreaming) {
        // Only a LIVE stream may contribute a tail. With no stream running for
        // this session, an `isStreaming` cache row is stale local state: its turn
        // is either already persisted in the DB or already finalized locally, so
        // keeping it strands a duplicate of an OLD reply at the bottom of the
        // thread (its rawCreatedAt is the optimistic send time, so it can never
        // be ordered correctly either). The DB is the sole authority once idle.
        if (!streamLive) continue;
        streamingTail.push(cm);
        byId.add(cm.id);
      } else {
        rest.push(cm);
      }
    }
    for (const cm of rest) {
      if (byId.has(cm.id)) continue;
      // Insert cache-only messages chronologically among DB messages.
      const t = cm.rawCreatedAt ? Date.parse(cm.rawCreatedAt) : NaN;
      let i = out.length;
      while (i > 0 && out[i - 1]!.rawCreatedAt && Number.isFinite(t)) {
        const pt = Date.parse(out[i - 1]!.rawCreatedAt!);
        if (!Number.isFinite(pt) || pt <= t) break;
        i--;
      }
      out.splice(i, 0, cm);
      byId.add(cm.id);
    }
    // Live streaming tails go last, in cache order (their own turn ordering).
    for (const cm of streamingTail) out.push(cm);
    return out;
  }

  // ── Activity buffer ──

  appendActivity(
    key: string,
    step: ActivityStep,
    sessionId?: string | null,
  ): ActivityWriteResult {
    const bufKey = sessionId ?? key;
    const next = [...(this.actBuffers.get(bufKey) ?? []), step];
    this.actBuffers.set(bufKey, next);

    if (this.currentConvKey !== key) return { displayChanged: false };
    const viewedSession = this.activeSession.get(key);
    if (!sessionId || !viewedSession || viewedSession === sessionId) {
      return { displayChanged: true, newActivities: next };
    }
    return { displayChanged: false };
  }

  // ── Session management ──

  getActiveSession(key: string): string | undefined {
    return this.activeSession.get(key);
  }

  setActiveSession(key: string, sessionId: string): void {
    this.activeSession.set(key, sessionId);
  }

  /** Unpin the routing gate (e.g. no session selected). After this, writes
   * with a real session id are handled by the conservative isDisplayRoute
   * guard until the gate is pinned again. */
  clearActiveSession(key: string): void {
    this.activeSession.delete(key);
  }

  saveToCache(key: string, sessionId: string): void {
    if (!sessionId || sessionId === ConversationBufferManager.NEW_CHAT_ID) return;
    const msgs = this.msgBuffers.get(key);
    if (msgs && msgs.length > 0) {
      this.sessionMsgCache.set(sessionId, msgs);
      this.touchSessionCache(sessionId);
    }
  }

  restoreFromCache(key: string, sessionId: string): ChatMsg[] | undefined {
    const cached = this.sessionMsgCache.get(sessionId);
    if (cached && cached.length > 0) {
      // Never restore a stale streaming row into the view: it would render an old
      // duplicate bubble at the tail until the next DB load heals it.
      const live = this.isStreamLiveForSession(key, sessionId);
      const usable = live
        ? cached
        : cached.filter(m => !(m.sender === 'agent' && m.isStreaming && !m.isStopped));
      if (usable.length === 0) {
        this.msgBuffers.delete(key);
        return undefined;
      }
      this.msgBuffers.set(key, usable);
      return usable;
    }
    this.msgBuffers.delete(key);
    return undefined;
  }

  isCacheFresher(sessionId: string, dbMsgs: ChatMsg[], streamLive = false): boolean {
    const raw = this.sessionMsgCache.get(sessionId);
    if (!raw || raw.length === 0) return false;
    // Stale streaming rows must not count as freshness evidence: the extra row
    // they carry is exactly what makes the cache look newer than the DB forever
    // and stops the authoritative DB list from ever replacing it.
    const cache = streamLive
      ? raw
      : raw.filter(m => !(m.sender === 'agent' && m.isStreaming && !m.isStopped));
    if (cache.length === 0) return false;
    if (cache.length > dbMsgs.length) return true;
    const cacheTextLen = cache.reduce((s, m) => s + m.text.length, 0);
    const dbTextLen = dbMsgs.reduce((s, m) => s + m.text.length, 0);
    if (cacheTextLen > dbTextLen) return true;
    const cacheSegLen = cache.reduce((s, m) => s + (m.segments?.length ?? 0), 0);
    const dbSegLen = dbMsgs.reduce((s, m) => s + (m.segments?.length ?? 0), 0);
    return cacheSegLen > dbSegLen;
  }

  /**
   * Is a stream genuinely in flight for `sessionId` in this conversation?
   *
   * `streamingSessions` is the positive ownership record (`setStreamSession` on
   * session_start, released on done/abort/error). An EMPTY set during a
   * `streaming` phase is the pre-registration window — `beginStream` flips the
   * phase before the session mark lands — so it must NOT be read as "no stream":
   * that window is exactly where the in-flight placeholder legitimately lives.
   */
  private isStreamLiveForSession(convKey: string, sessionId: string): boolean {
    if (this.getPhase(convKey) !== 'streaming') return false;
    const set = this.streamingSessions.get(convKey);
    if (!set || set.size === 0) return true;
    if (set.has(sessionId)) return true;
    return this.placeholderTurnBelongsTo(convKey, sessionId);
  }

  /**
   * A turn can be tracked under the NEW_CHAT placeholder before the server
   * assigns a real session id (`beginStream` flips the phase, `session_start`
   * lands later), and a chat started from a fresh tab keeps that id. Such a
   * mark belongs to whichever session is being VIEWED, so it must count as live
   * for that session too.
   *
   * React's session-switch handler already treats the placeholder this way
   * (`streamForThis`), so the two predicates used to disagree: the view said
   * "this session is streaming" while the buffer manager said "some other
   * session owns it" and dropped the in-flight row. One question, one answer.
   */
  private placeholderTurnBelongsTo(convKey: string, sessionId: string): boolean {
    const set = this.streamingSessions.get(convKey);
    if (!set || !set.has(ConversationBufferManager.NEW_CHAT_ID)) return false;
    return this.activeSession.get(convKey) === sessionId;
  }

  // ── Send / stream tracking ──

  incrementSend(key: string): void {
    this.sendCount.set(key, (this.sendCount.get(key) ?? 0) + 1);
  }

  decrementSend(key: string): number {
    const n = Math.max(0, (this.sendCount.get(key) ?? 1) - 1);
    this.sendCount.set(key, n);
    return n;
  }

  resetSend(key: string): void {
    this.sendCount.set(key, 0);
  }

  isSending(key: string): boolean {
    return (this.sendCount.get(key) ?? 0) > 0;
  }

  /** Returns true when the membership actually changed (false = already present). */
  addStreamSession(key: string, sid: string): boolean {
    const s = this.streamingSessions.get(key) ?? new Set();
    if (s.has(sid)) {
      this.streamingSessions.set(key, s);
      return false;
    }
    s.add(sid);
    this.streamingSessions.set(key, s);
    return true;
  }

  /** Returns true when the membership actually changed (false = nothing to remove). */
  removeStreamSession(key: string, sid?: string): boolean {
    if (sid) {
      const s = this.streamingSessions.get(key);
      if (!s || !s.has(sid)) return false;
      s.delete(sid);
      if (s.size === 0) this.streamingSessions.delete(key);
      return true;
    }
    return this.streamingSessions.delete(key);
  }

  getStreamSessions(key: string): Set<string> | undefined {
    return this.streamingSessions.get(key);
  }

  /**
   * Single, idempotent teardown for ANY path that must stop the current
   * send/stream: user stop, double-submit retry, same-session interrupt,
   * channel abort, unmount. Replaces the fragile copy-pasted cleanup
   * sequences that could leak state when one step was forgotten.
   *
   * Clears, in one pass: send counter, activity buffer (keyed by sessionId
   * when provided, mirroring how activities are written), phase
   * (streaming → ready), and the streaming-session marks. Safe to call when
   * nothing is active — returns false so callers can skip follow-up work.
   */
  abortStream(key: string, sessionId?: string | null): boolean {
    let affected = false;

    if ((this.sendCount.get(key) ?? 0) > 0) {
      this.sendCount.set(key, 0);
      affected = true;
    }

    const bufKey = sessionId ?? key;
    if (this.actBuffers.delete(bufKey)) affected = true;

    if (this.getPhase(key) === 'streaming') {
      this.phase.set(key, 'ready');
      affected = true;
    }

    if (sessionId) {
      const had = this.streamingSessions.get(key)?.has(sessionId) ?? false;
      this.removeStreamSession(key, sessionId);
      if (had) affected = true;
    } else if (this.streamingSessions.delete(key)) {
      affected = true;
    }

    return affected;
  }

  // ── Buffer reads ──

  getMessages(key: string): ChatMsg[] | undefined {
    return this.msgBuffers.get(key);
  }

  getActivities(bufKey: string): ActivityStep[] {
    return this.actBuffers.get(bufKey) ?? [];
  }

  deleteBuffer(key: string): void {
    this.msgBuffers.delete(key);
  }

  // ── Internal ──

  private evictIfNeeded(currentKey: string): void {
    if (this.msgBuffers.size <= ConversationBufferManager.MAX_CONVERSATIONS) return;
    const keys = [...this.msgBuffers.keys()];
    const toEvict = keys
      .filter(k => k !== currentKey && k !== this.currentConvKey)
      .slice(0, keys.length - ConversationBufferManager.MAX_CONVERSATIONS);
    for (const k of toEvict) {
      this.msgBuffers.delete(k);
      this.actBuffers.delete(k);
      this.sessionTabs.delete(k);
      this.activeSession.delete(k);
    }
  }

  /** Track a sessionMsgCache write and evict oldest entries beyond MAX_SESSION_CACHE. */
  touchSessionCache(sessionId: string): void {
    const idx = this.sessionCacheOrder.indexOf(sessionId);
    if (idx !== -1) this.sessionCacheOrder.splice(idx, 1);
    this.sessionCacheOrder.push(sessionId);

    while (this.sessionCacheOrder.length > ConversationBufferManager.MAX_SESSION_CACHE) {
      const oldest = this.sessionCacheOrder.shift()!;
      const activeSessionIds = new Set(this.activeSession.values());
      if (activeSessionIds.has(oldest)) {
        this.sessionCacheOrder.push(oldest);
        break;
      }
      this.sessionMsgCache.delete(oldest);
    }
  }
}
