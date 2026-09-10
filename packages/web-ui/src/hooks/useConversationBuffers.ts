/**
 * useConversationBuffers — Thin React wrapper over ConversationBufferManager.
 *
 * All buffer logic, phase state machine, and write routing live in the pure
 * ConversationBufferManager class. This hook provides:
 * - A stable manager instance (useRef)
 * - React state bridging (BufferWriteResult → setMessages / setActivities)
 * - RAF batching for text streaming updates
 * - Backward-compatible API surface for Team.tsx migration
 */
import { useCallback, useRef, useState, useEffect } from 'react';
import { ConversationBufferManager, type ConvPhase, makeConvKey } from '../lib/ConversationBufferManager.ts';
import type { ChatMsg } from '../pages/ChatHelpers.ts';
import type { ActivityStep } from '../components/ActivityIndicator.tsx';
import { chatStore } from '../pages/useChatStore.ts';

export { type ConvPhase } from '../lib/ConversationBufferManager.ts';
export { makeConvKey } from '../lib/ConversationBufferManager.ts';
export const NEW_CHAT_PLACEHOLDER_ID = ConversationBufferManager.NEW_CHAT_ID;

export function useConversationBuffers(initialMessages?: ChatMsg[]) {
  const mgr = useRef(new ConversationBufferManager());
  const [messages, setMessages] = useState<ChatMsg[]>(initialMessages ?? []);
  const [sending, setSending] = useState(false);
  const [activities, setActivities] = useState<ActivityStep[]>([]);
  const rafRef = useRef<number | null>(null);

  useEffect(() => () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); }, []);

  const updateConvMsgs = useCallback((key: string, updater: (prev: ChatMsg[]) => ChatMsg[], sessionId?: string | null) => {
    const r = mgr.current.updateMessages(key, updater, sessionId);
    if (r.displayChanged && r.newMessages) setMessages(r.newMessages);
  }, []);

  const updateConvMsgsRaf = useCallback((key: string, updater: (prev: ChatMsg[]) => ChatMsg[], sessionId?: string | null) => {
    const r = mgr.current.updateMessages(key, updater, sessionId);
    if (r.displayChanged && rafRef.current === null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const latest = mgr.current.getMessages(key);
        if (latest && mgr.current.currentConvKey === key) setMessages([...latest]);
      });
    }
  }, []);

  const appendConvActivity = useCallback((key: string, step: ActivityStep, sessionId?: string | null) => {
    const r = mgr.current.appendActivity(key, step, sessionId);
    if (r.displayChanged && r.newActivities) setActivities(r.newActivities);
  }, []);

  // Phase transitions. beginStream marks the agent busy for the sidebar; the
  // busy mark is REMOVED only via clearStreamSession below (the single stream
  // lifecycle removal point) — NOT via endStream. This makes add/remove
  // pairing structural: every stream path (done, abort, stop, soft-disconnect
  // → reattach, session switch, retry) eventually calls clearStreamSession,
  // so the sidebar busy state cannot drift or leak.
  const isAgentKey = (key: string): boolean =>
    !!key && !key.startsWith('ch:') && !key.startsWith('dm:') && key !== '_direct';

  const getPhase = useCallback((key: string) => mgr.current.getPhase(key), []);
  const beginLoad = useCallback((key: string) => mgr.current.beginLoad(key), []);
  const beginStream = useCallback((key: string) => {
    mgr.current.beginStream(key);
    // Direct conversation keys are the agent id itself (see makeConvKey):
    // `ch:*` (team/channel) and `dm:*` (human DM) never map to one agent.
    if (isAgentKey(key)) chatStore.markAgentStreaming(key, true);
  }, []);
  const endStream = useCallback((key: string) => {
    mgr.current.endStream(key);
    // NOTE: intentionally does NOT unmark the agent — see comment above.
    // The agent stays busy until clearStreamSession is called by whichever
    // path owns the stream's end.
  }, []);
  // Single teardown entry for abort-like paths (stop / retry / interrupt /
  // channel abort / unmount). Replaces the copy-pasted cleanup sequences in
  // Team.tsx; see ConversationBufferManager.abortStream for the pure logic.
  const abortStream = useCallback((key: string, sessionId?: string | null) => {
    const affected = mgr.current.abortStream(key, sessionId);
    if (affected && isAgentKey(key)) chatStore.markAgentStreaming(key, false);
    if (mgr.current.currentConvKey === key) {
      setSending(false);
      setActivities([]);
    }
  }, []);
  const resetConv = useCallback((key: string, repinTo?: string) => {
    mgr.current.resetConv(key, repinTo);
    mgr.current.deleteBuffer(key);
  }, []);

  // Phase-aware async load
  const loadAndDisplay = useCallback(async (
    sessionId: string,
    convKey: string,
    fetchFn: () => Promise<{ messages: ChatMsg[]; hasMore: boolean; oldestCursor: string | null }>,
  ) => {
    mgr.current.loadingSession = sessionId;
    mgr.current.beginLoad(convKey);
    try {
      const data = await fetchFn();
      const r = mgr.current.applyLoadResult(convKey, sessionId, data.messages);
      if (r.displayChanged && r.newMessages) setMessages(r.newMessages);
      return { count: data.messages.length, hasMore: data.hasMore, oldestCursor: data.oldestCursor };
    } catch {
      if (mgr.current.currentConvKey === convKey && mgr.current.getPhase(convKey) !== 'streaming') {
        setMessages([]);
        mgr.current.completeLoad(convKey);
      }
      return { count: 0, hasMore: false, oldestCursor: null };
    }
  }, []);

  return {
    manager: mgr.current,
    messages, setMessages,
    sending, setSending,
    activities, setActivities,
    // Expose manager maps directly (Team.tsx migration replaces .current. with direct access)
    get msgBuffers() { return mgr.current.msgBuffers; },
    get sessionMsgCache() { return mgr.current.sessionMsgCache; },
    get activeSessionBuffer() { return mgr.current.activeSession; },
    get actBuffers() { return mgr.current.actBuffers; },
    get sessionTabsBuffer() { return mgr.current.sessionTabs; },
    // Ref-shaped wrapper for currentConvKey (enables currentConvKeyRef.current = x)
    get currentConvKeyRef() {
      return {
        get current() { return mgr.current.currentConvKey; },
        set current(v: string) { mgr.current.currentConvKey = v; },
      };
    },
    // Ref-shaped wrapper for loadingSession
    get loadingSessionRef() {
      return {
        get current() { return mgr.current.loadingSession; },
        set current(v: string | null) { mgr.current.loadingSession = v; },
      };
    },
    // Methods
    updateConvMsgs, updateConvMsgsRaf, appendConvActivity,
    getPhase, beginLoad, beginStream, endStream, resetConv,
    abortStream,
    loadAndDisplay,
    // Send counter helpers
    incrementSending: (k: string) => mgr.current.incrementSend(k),
    decrementSending: (k: string) => mgr.current.decrementSend(k),
    resetSending: (k: string) => mgr.current.resetSend(k),
    isSendingFor: (k: string) => mgr.current.isSending(k),
    // Stream session helpers. These are the SINGLE add/remove points for the
    // sidebar busy signal: calling setStreamSession marks the agent busy,
    // calling clearStreamSession unmarks it. Every other stream cleanup path
    // in Team.tsx funnels through clearStreamSession.
    setStreamSession: (k: string, s: string) => {
      mgr.current.addStreamSession(k, s);
      if (isAgentKey(k)) chatStore.markAgentStreaming(k, true);
    },
    clearStreamSession: (k: string, s?: string) => {
      mgr.current.removeStreamSession(k, s);
      if (isAgentKey(k)) chatStore.markAgentStreaming(k, false);
    },
    getStreamSession: (k: string) => mgr.current.getStreamSessions(k),
    // Session switch helpers
    saveSessionToCache: (k: string, s: string) => mgr.current.saveToCache(k, s),
    restoreSessionFromCache: (k: string, s: string) => {
      const msgs = mgr.current.restoreFromCache(k, s);
      setMessages(msgs ?? []);
      return msgs;
    },
    isSessionCacheFresherThanDb: (sid: string, dbMsgs: ChatMsg[]) => mgr.current.isCacheFresher(sid, dbMsgs),
  };
}
