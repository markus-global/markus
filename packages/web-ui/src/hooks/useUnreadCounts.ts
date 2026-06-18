import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { api, wsClient } from '../api.ts';

const POLL_INTERVAL_MS = 60_000;

let _globalCounts: Record<string, number> = {};
let _globalSessionAgentMap: Record<string, string> = {};
const _listeners = new Set<() => void>();
const _activeKeys = new Set<string>();
let _graceUntil = 0;

function notify() {
  for (const fn of _listeners) fn();
}

export function useUnreadCounts(opts?: { enabled?: boolean }) {
  const enabled = opts?.enabled ?? true;
  const [counts, setCounts] = useState<Record<string, number>>(_globalCounts);
  const [sessionAgentMap, setSessionAgentMap] = useState<Record<string, string>>(_globalSessionAgentMap);
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const resp = await api.unread.getCounts();
      _globalCounts = resp.counts ?? {};
      _globalSessionAgentMap = resp.sessionAgentMap ?? {};
      setCounts(_globalCounts);
      setSessionAgentMap(_globalSessionAgentMap);
      notify();
    } catch { /* silent */ }
  }, []);

  const markRead = useCallback(async (conversationKey: string) => {
    const ts = new Date().toISOString();
    delete _globalCounts[conversationKey];
    setCounts({ ..._globalCounts });
    notify();
    try {
      await api.unread.markRead(conversationKey, ts);
    } catch { /* silent */ }
  }, []);

  const markAllRead = useCallback(async () => {
    _globalCounts = {};
    setCounts({});
    notify();
    try {
      await api.unread.markAllRead();
    } catch { /* silent */ }
  }, []);

  const setActiveKey = useCallback((key: string) => { _activeKeys.add(key); }, []);
  const clearActiveKey = useCallback((key: string) => {
    _activeKeys.delete(key);
    _graceUntil = Date.now() + 150;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    refresh();
    pollRef.current = setInterval(refresh, POLL_INTERVAL_MS);

    const unsub = wsClient.on('chat:unread_update', (event) => {
      const key = (event.payload as { conversationKey?: string })?.conversationKey;
      if (key && !_activeKeys.has(key) && Date.now() > _graceUntil) {
        _globalCounts[key] = (_globalCounts[key] ?? 0) + 1;
        setCounts({ ..._globalCounts });
        notify();
      }
    });

    let _prevSessionAgentMapRef = _globalSessionAgentMap;
    const listener = () => {
      setCounts({ ..._globalCounts });
      if (_prevSessionAgentMapRef !== _globalSessionAgentMap) {
        _prevSessionAgentMapRef = _globalSessionAgentMap;
        setSessionAgentMap({ ..._globalSessionAgentMap });
      }
    };
    _listeners.add(listener);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      unsub();
      _listeners.delete(listener);
    };
  }, [enabled, refresh]);

  const totalUnread = useMemo(() => {
    return Object.values(counts).reduce((sum, n) => sum + n, 0);
  }, [counts]);

  const getSessionUnread = useCallback((sessionId: string): number => {
    return counts[`session:${sessionId}`] ?? 0;
  }, [counts]);

  const getChannelUnread = useCallback((channelKey: string): number => {
    return counts[`channel:${channelKey}`] ?? 0;
  }, [counts]);

  return { counts, totalUnread, sessionAgentMap, getSessionUnread, getChannelUnread, markRead, markAllRead, refresh, setActiveKey, clearActiveKey };
}

/**
 * Derive per-agent unread counts from session-level read cursors.
 * Uses the sessionAgentMap (sessionId → agentId) returned by the server
 * to aggregate session:* counts into agent-level totals.
 */
export function useAgentUnread(
  sessionAgentMap: Record<string, string>,
  counts: Record<string, number>
): Map<string, number> {
  return useMemo(() => {
    const result = new Map<string, number>();
    for (const [key, count] of Object.entries(counts)) {
      if (key.startsWith('session:')) {
        const sessionId = key.slice('session:'.length);
        const agentId = sessionAgentMap[sessionId];
        if (agentId) {
          result.set(agentId, (result.get(agentId) ?? 0) + count);
        }
      }
    }
    return result;
  }, [sessionAgentMap, counts]);
}

/**
 * Get unread for a team by summing its team channel + all member agent sessions.
 */
export function getTeamUnread(
  teamId: string,
  teamAgentIds: string[],
  teamChannelKey: string | undefined,
  agentUnreads: Map<string, number>,
  counts: Record<string, number>
): number {
  let total = 0;
  if (teamChannelKey) {
    total += counts[`channel:${teamChannelKey}`] ?? 0;
  }
  for (const agentId of teamAgentIds) {
    total += agentUnreads.get(agentId) ?? 0;
  }
  return total;
}
