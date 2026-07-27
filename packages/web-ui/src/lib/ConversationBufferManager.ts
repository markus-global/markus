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

  getPhase(key: string): ConvPhase {
    return this.phase.get(key) ?? 'idle';
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

  endStream(key: string): void {
    if (this.getPhase(key) === 'streaming') {
      this.phase.set(key, 'ready');
    }
  }

  resetConv(key: string): void {
    this.phase.set(key, 'idle');
    this.activeSession.delete(key);
  }

  // ── Message buffer writes ──

  updateMessages(
    key: string,
    updater: (prev: ChatMsg[]) => ChatMsg[],
    sessionId?: string | null,
  ): BufferWriteResult {
    const activeSessionId = this.activeSession.get(key);
    const isSameSession = !sessionId
      || activeSessionId === sessionId
      || activeSessionId === undefined;

    const source = isSameSession
      ? (this.msgBuffers.get(key) ?? [])
      : (this.sessionMsgCache.get(sessionId!) ?? []);

    let next = updater(source);
    if (next.length > ConversationBufferManager.MAX_MESSAGES) {
      next = next.slice(-ConversationBufferManager.MAX_MESSAGES);
    }

    let displayChanged = false;
    if (isSameSession) {
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
   * Apply DB load result. Phase-aware: blocks display writes during streaming.
   * When phase is `streaming`, data goes to cache only, preserving in-flight
   * streaming content in the display buffer.
   */
  applyLoadResult(
    convKey: string,
    sessionId: string,
    msgs: ChatMsg[],
  ): BufferWriteResult {
    const cacheIsFresher = this.isCacheFresher(sessionId, msgs);
    if (!cacheIsFresher) {
      this.sessionMsgCache.set(sessionId, msgs);
      this.touchSessionCache(sessionId);
    }

    const phase = this.getPhase(convKey);
    // Accept the result when this session is still the one being loaded OR the
    // one the user is viewing. Relying only on `loadingSession` drops the first
    // response when a second load for the same conversation races ahead.
    const activeSessionId = this.activeSession.get(convKey);
    const isCurrentView = this.currentConvKey === convKey
      && (this.loadingSession === sessionId || activeSessionId === sessionId);

    if (isCurrentView && phase !== 'streaming') {
      const displayMsgs = cacheIsFresher
        ? this.sessionMsgCache.get(sessionId)!
        : msgs;
      this.msgBuffers.set(convKey, displayMsgs);
      this.loadingSession = sessionId;
      this.completeLoad(convKey);
      return { displayChanged: true, newMessages: displayMsgs };
    }

    return { displayChanged: false };
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
      this.msgBuffers.set(key, cached);
      return cached;
    }
    this.msgBuffers.delete(key);
    return undefined;
  }

  isCacheFresher(sessionId: string, dbMsgs: ChatMsg[]): boolean {
    const cache = this.sessionMsgCache.get(sessionId);
    if (!cache || cache.length === 0) return false;
    if (cache.length > dbMsgs.length) return true;
    const cacheTextLen = cache.reduce((s, m) => s + m.text.length, 0);
    const dbTextLen = dbMsgs.reduce((s, m) => s + m.text.length, 0);
    if (cacheTextLen > dbTextLen) return true;
    const cacheSegLen = cache.reduce((s, m) => s + (m.segments?.length ?? 0), 0);
    const dbSegLen = dbMsgs.reduce((s, m) => s + (m.segments?.length ?? 0), 0);
    return cacheSegLen > dbSegLen;
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

  addStreamSession(key: string, sid: string): void {
    const s = this.streamingSessions.get(key) ?? new Set();
    s.add(sid);
    this.streamingSessions.set(key, s);
  }

  removeStreamSession(key: string, sid?: string): void {
    if (sid) {
      const s = this.streamingSessions.get(key);
      if (s) {
        s.delete(sid);
        if (s.size === 0) this.streamingSessions.delete(key);
      }
    } else {
      this.streamingSessions.delete(key);
    }
  }

  getStreamSessions(key: string): Set<string> | undefined {
    return this.streamingSessions.get(key);
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
