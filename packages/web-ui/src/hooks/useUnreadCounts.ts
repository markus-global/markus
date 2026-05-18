import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { api, wsClient } from '../api.ts';

const POLL_INTERVAL_MS = 60_000;

let _globalCounts: Record<string, number> = {};
let _listeners = new Set<() => void>();

function notify() {
  for (const fn of _listeners) fn();
}

export function useUnreadCounts() {
  const [counts, setCounts] = useState<Record<string, number>>(_globalCounts);
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const resp = await api.unread.getCounts();
      _globalCounts = resp.counts ?? {};
      setCounts(_globalCounts);
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

  useEffect(() => {
    refresh();
    pollRef.current = setInterval(refresh, POLL_INTERVAL_MS);

    const unsub = wsClient.on('chat:unread_update', (event) => {
      const key = (event.payload as { conversationKey?: string })?.conversationKey;
      if (key) {
        _globalCounts[key] = (_globalCounts[key] ?? 0) + 1;
        setCounts({ ..._globalCounts });
        notify();
      }
    });

    const listener = () => setCounts({ ..._globalCounts });
    _listeners.add(listener);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      unsub();
      _listeners.delete(listener);
    };
  }, [refresh]);

  const totalUnread = useMemo(() => {
    return Object.values(counts).reduce((sum, n) => sum + n, 0);
  }, [counts]);

  const getSessionUnread = useCallback((sessionId: string): number => {
    return counts[`session:${sessionId}`] ?? 0;
  }, [counts]);

  const getChannelUnread = useCallback((channelKey: string): number => {
    return counts[`channel:${channelKey}`] ?? 0;
  }, [counts]);

  return { counts, totalUnread, getSessionUnread, getChannelUnread, markRead, markAllRead, refresh };
}

/**
 * Get unread count for a specific agent by summing all session:* entries
 * that belong to sessions of that agent.
 * Since session keys encode the session ID (not the agent ID), the caller
 * must provide a mapping of sessionId -> agentId.
 */
export function useAgentUnread(
  agentSessionMap: Map<string, string>,
  counts: Record<string, number>
): Map<string, number> {
  return useMemo(() => {
    const result = new Map<string, number>();
    for (const [key, count] of Object.entries(counts)) {
      if (key.startsWith('session:')) {
        const sessionId = key.slice('session:'.length);
        const agentId = agentSessionMap.get(sessionId);
        if (agentId) {
          result.set(agentId, (result.get(agentId) ?? 0) + count);
        }
      }
    }
    return result;
  }, [agentSessionMap, counts]);
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
