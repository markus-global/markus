/**
 * useConversationBuffers — Manages per-conversation message buffers with
 * session-aware routing for multi-session streaming.
 *
 * This hook encapsulates the buffer management that was previously scattered
 * across Team.tsx, providing a single source of truth for:
 * - Message storage per conversation key
 * - Per-session caching (survives tab switches during streaming)
 * - Session-aware update routing (stream events go to correct session)
 * - Activity step buffering
 * - Send counter tracking (multiple concurrent streams per agent)
 * - Streaming session ref tracking
 */
import { useCallback, useRef, useState } from 'react';
import type { ChatMsg, ChatMode } from '../pages/ChatHelpers.ts';
import type { ActivityStep } from '../components/ActivityIndicator.tsx';

const MAX_MESSAGES_PER_CONV = 500;
const MAX_BUFFERED_CONVERSATIONS = 20;
const NEW_CHAT_PLACEHOLDER_ID = '__new_chat__';

export { NEW_CHAT_PLACEHOLDER_ID };

export function makeConvKey(mode: ChatMode, agent: string, channel: string, dmUserId?: string): string {
  return mode === 'channel' ? `ch:${channel}` :
    mode === 'dm' ? `dm:${dmUserId ?? ''}` :
    (agent || '_direct');
}

export interface ConversationBuffers {
  // State
  messages: ChatMsg[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMsg[]>>;
  sending: boolean;
  setSending: React.Dispatch<React.SetStateAction<boolean>>;
  activities: ActivityStep[];
  setActivities: React.Dispatch<React.SetStateAction<ActivityStep[]>>;

  // Refs
  msgBuffers: React.MutableRefObject<Map<string, ChatMsg[]>>;
  actBuffers: React.MutableRefObject<Map<string, ActivityStep[]>>;
  sendingConvs: React.MutableRefObject<Map<string, number>>;
  currentConvKeyRef: React.MutableRefObject<string>;
  sessionMsgCache: React.MutableRefObject<Map<string, ChatMsg[]>>;
  activeSessionBuffer: React.MutableRefObject<Map<string, string>>;
  streamingForSessionRef: React.MutableRefObject<Map<string, Set<string>>>;
  sessionTabsBuffer: React.MutableRefObject<Map<string, unknown[]>>;

  // Methods
  updateConvMsgs: (key: string, updater: (prev: ChatMsg[]) => ChatMsg[], sessionId?: string | null) => void;
  updateConvMsgsRaf: (key: string, updater: (prev: ChatMsg[]) => ChatMsg[], sessionId?: string | null) => void;
  appendConvActivity: (key: string, step: ActivityStep, sessionId?: string | null) => void;

  // Send counter helpers
  incrementSending: (key: string) => void;
  decrementSending: (key: string) => number;
  resetSending: (key: string) => void;
  isSendingFor: (key: string) => boolean;

  // Session stream tracking (Set-based: multiple sessions can stream concurrently)
  setStreamSession: (key: string, sessionId: string) => void;
  clearStreamSession: (key: string, onlyIfSession?: string) => void;
  getStreamSession: (key: string) => Set<string> | undefined;

  // Session switch helpers
  saveSessionToCache: (key: string, sessionId: string) => void;
  restoreSessionFromCache: (key: string, sessionId: string) => ChatMsg[] | undefined;
  isSessionCacheFresherThanDb: (sessionId: string, dbMsgs: ChatMsg[]) => boolean;
}

export function useConversationBuffers(initialMessages?: ChatMsg[]): ConversationBuffers {
  const [messages, setMessages] = useState<ChatMsg[]>(initialMessages ?? []);
  const [sending, setSending] = useState(false);
  const [activities, setActivities] = useState<ActivityStep[]>([]);

  const msgBuffers = useRef<Map<string, ChatMsg[]>>(new Map());
  const actBuffers = useRef<Map<string, ActivityStep[]>>(new Map());
  const sendingConvs = useRef<Map<string, number>>(new Map());
  const currentConvKeyRef = useRef<string>('');
  const sessionMsgCache = useRef<Map<string, ChatMsg[]>>(new Map());
  const activeSessionBuffer = useRef<Map<string, string>>(new Map());
  const streamingForSessionRef = useRef<Map<string, Set<string>>>(new Map());
  const sessionTabsBuffer = useRef<Map<string, unknown[]>>(new Map());
  const rafPendingRef = useRef<number | null>(null);

  const updateConvMsgs = useCallback((key: string, updater: (prev: ChatMsg[]) => ChatMsg[], sessionId?: string | null) => {
    const activeSession = activeSessionBuffer.current.get(key);
    const isSameSession = !sessionId || activeSession === sessionId || activeSession === undefined;
    const source = isSameSession
      ? (msgBuffers.current.get(key) ?? [])
      : (sessionMsgCache.current.get(sessionId!) ?? []);

    let next = updater(source);
    if (next.length > MAX_MESSAGES_PER_CONV) {
      next = next.slice(-MAX_MESSAGES_PER_CONV);
    }

    if (isSameSession) {
      msgBuffers.current.set(key, next);
      if (msgBuffers.current.size > MAX_BUFFERED_CONVERSATIONS) {
        const keys = [...msgBuffers.current.keys()];
        const toEvict = keys
          .filter(k => k !== key && k !== currentConvKeyRef.current)
          .slice(0, keys.length - MAX_BUFFERED_CONVERSATIONS);
        for (const k of toEvict) {
          msgBuffers.current.delete(k);
          actBuffers.current.delete(k);
          sessionTabsBuffer.current.delete(k);
          activeSessionBuffer.current.delete(k);
        }
      }
      if (currentConvKeyRef.current === key) setMessages(next);
    }
    if (sessionId && sessionId !== NEW_CHAT_PLACEHOLDER_ID) {
      sessionMsgCache.current.set(sessionId, next);
    }
  }, []);

  const updateConvMsgsRaf = useCallback((key: string, updater: (prev: ChatMsg[]) => ChatMsg[], sessionId?: string | null) => {
    const activeSession = activeSessionBuffer.current.get(key);
    const isSameSession = !sessionId || activeSession === sessionId || activeSession === undefined;
    const source = isSameSession
      ? (msgBuffers.current.get(key) ?? [])
      : (sessionMsgCache.current.get(sessionId!) ?? []);

    let next = updater(source);
    if (next.length > MAX_MESSAGES_PER_CONV) {
      next = next.slice(-MAX_MESSAGES_PER_CONV);
    }

    if (isSameSession) {
      msgBuffers.current.set(key, next);
      if (currentConvKeyRef.current === key && rafPendingRef.current === null) {
        rafPendingRef.current = requestAnimationFrame(() => {
          rafPendingRef.current = null;
          const latest = msgBuffers.current.get(key);
          if (latest && currentConvKeyRef.current === key) setMessages([...latest]);
        });
      }
    }
    if (sessionId && sessionId !== NEW_CHAT_PLACEHOLDER_ID) {
      sessionMsgCache.current.set(sessionId, next);
    }
  }, []);

  const appendConvActivity = useCallback((key: string, step: ActivityStep, sessionId?: string | null) => {
    const next = [...(actBuffers.current.get(key) ?? []), step];
    actBuffers.current.set(key, next);
    if (currentConvKeyRef.current === key) {
      const viewedSession = activeSessionBuffer.current.get(key);
      if (!sessionId || !viewedSession || viewedSession === sessionId) {
        setActivities(next);
      }
    }
  }, []);

  // Send counter helpers
  const incrementSending = useCallback((key: string) => {
    sendingConvs.current.set(key, (sendingConvs.current.get(key) ?? 0) + 1);
  }, []);

  const decrementSending = useCallback((key: string): number => {
    const newCount = Math.max(0, (sendingConvs.current.get(key) ?? 1) - 1);
    sendingConvs.current.set(key, newCount);
    return newCount;
  }, []);

  const resetSending = useCallback((key: string) => {
    sendingConvs.current.set(key, 0);
  }, []);

  const isSendingFor = useCallback((key: string): boolean => {
    return (sendingConvs.current.get(key) ?? 0) > 0;
  }, []);

  // Stream session tracking (Set-based: multiple sessions can stream concurrently)
  const setStreamSession = useCallback((key: string, sessionId: string) => {
    const sessions = streamingForSessionRef.current.get(key) ?? new Set();
    sessions.add(sessionId);
    streamingForSessionRef.current.set(key, sessions);
  }, []);

  const clearStreamSession = useCallback((key: string, onlyIfSession?: string) => {
    if (onlyIfSession) {
      const sessions = streamingForSessionRef.current.get(key);
      if (sessions) {
        sessions.delete(onlyIfSession);
        if (sessions.size === 0) streamingForSessionRef.current.delete(key);
      }
    } else {
      streamingForSessionRef.current.delete(key);
    }
  }, []);

  const getStreamSession = useCallback((key: string): Set<string> | undefined => {
    return streamingForSessionRef.current.get(key);
  }, []);

  // Session switch helpers
  const saveSessionToCache = useCallback((key: string, sessionId: string) => {
    if (sessionId && sessionId !== NEW_CHAT_PLACEHOLDER_ID) {
      const currentMsgs = msgBuffers.current.get(key);
      if (currentMsgs && currentMsgs.length > 0) {
        sessionMsgCache.current.set(sessionId, currentMsgs);
      }
    }
  }, []);

  const restoreSessionFromCache = useCallback((key: string, sessionId: string): ChatMsg[] | undefined => {
    const cached = sessionMsgCache.current.get(sessionId);
    if (cached && cached.length > 0) {
      msgBuffers.current.set(key, cached);
      setMessages(cached);
      return cached;
    }
    msgBuffers.current.delete(key);
    setMessages([]);
    return undefined;
  }, []);

  const isSessionCacheFresherThanDb = useCallback((sessionId: string, dbMsgs: ChatMsg[]): boolean => {
    const existingCache = sessionMsgCache.current.get(sessionId);
    if (!existingCache || existingCache.length === 0) return false;
    if (existingCache.length > dbMsgs.length) return true;
    const cacheTextLen = existingCache.reduce((sum, m) => sum + m.text.length, 0);
    const dbTextLen = dbMsgs.reduce((sum, m) => sum + m.text.length, 0);
    const cacheSegLen = existingCache.reduce((sum, m) => sum + (m.segments?.length ?? 0), 0);
    const dbSegLen = dbMsgs.reduce((sum, m) => sum + (m.segments?.length ?? 0), 0);
    return cacheTextLen > dbTextLen || cacheSegLen > dbSegLen;
  }, []);

  return {
    messages, setMessages,
    sending, setSending,
    activities, setActivities,
    msgBuffers, actBuffers, sendingConvs, currentConvKeyRef,
    sessionMsgCache, activeSessionBuffer, streamingForSessionRef, sessionTabsBuffer,
    updateConvMsgs, updateConvMsgsRaf, appendConvActivity,
    incrementSending, decrementSending, resetSending, isSendingFor,
    setStreamSession, clearStreamSession, getStreamSession,
    saveSessionToCache, restoreSessionFromCache, isSessionCacheFresherThanDb,
  };
}
