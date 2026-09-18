import { useState, useEffect, useCallback, useMemo } from 'react';
import { api, wsClient } from '../api.ts';

const POLL_INTERVAL_MS = 60_000;

/**
 * Minimum spacing between two server-side cursor advances for the same
 * conversation while it stays open.
 *
 * A streaming reply broadcasts one unread event per chunk; without a floor the
 * client would POST a mark-read per token. The floor never affects what the
 * reader sees (an open conversation is filtered out of the counts regardless),
 * only how often we tell the server about it.
 */
const AUTO_READ_THROTTLE_MS = 2_000;

let _globalCounts: Record<string, number> = {};
let _globalSessionAgentMap: Record<string, string> = {};
const _listeners = new Set<() => void>();
const _activeKeys = new Set<string>();
let _graceUntil = 0;
const _lastAutoReadAt = new Map<string, number>();

// Singleton polling: one interval regardless of how many hook instances
let _pollTimer: ReturnType<typeof setInterval> | null = null;
let _subscriberCount = 0;
let _wsUnsub: (() => void) | null = null;

function notify() {
  for (const fn of _listeners) fn();
}

/**
 * Shallow value-equality for the flat records this store holds.
 *
 * `notify()` fires on every WS unread event, and the listeners used to hand React a brand-new
 * object identity each time — so a no-op notification still re-rendered the whole Team page
 * (84 agent rows + the message list). Bailing out on value-identical payloads keeps the store
 * honest about "nothing changed".
 */
function sameRecord<T>(a: Record<string, T>, b: Record<string, T>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

/**
 * Fold server counts together with the conversations the reader has open right
 * now. The server is the source of truth for everything EXCEPT the conversation
 * on screen - it tracks a read cursor, it cannot know that a message is already
 * rendered in front of the reader.
 *
 * Leaving that to the server produced the bug this locks down: you are sitting
 * in an agent's chat, it replies, and the agent's row grows a red "1" (and the
 * team row above it, and the nav badge) for a message you are looking at. The WS
 * path suppressed the optimistic +1, but the 60s poll then overwrote the store
 * with server truth, which still counted that message as unread.
 *
 * `staleActiveKeys` are active conversations the server still believes are
 * unread: the caller advances those cursors so the next poll agrees with the
 * screen instead of having to be masked again.
 */
export function reconcileServerCounts(
  server: Record<string, number>,
  activeKeys: ReadonlySet<string>,
): { counts: Record<string, number>; staleActiveKeys: string[] } {
  const counts: Record<string, number> = {};
  const staleActiveKeys: string[] = [];
  for (const [key, count] of Object.entries(server)) {
    if (activeKeys.has(key)) {
      if (count > 0) staleActiveKeys.push(key);
      continue;
    }
    counts[key] = count;
  }
  return { counts, staleActiveKeys };
}

/**
 * Tell the server that `key` has been read, at most once per
 * AUTO_READ_THROTTLE_MS (unless forced - see clearActiveKey).
 */
function _advanceReadCursor(key: string, opts?: { force?: boolean }) {
  const now = Date.now();
  const last = _lastAutoReadAt.get(key) ?? 0;
  if (!opts?.force && now - last < AUTO_READ_THROTTLE_MS) return;
  _lastAutoReadAt.set(key, now);
  if (key in _globalCounts) {
    delete _globalCounts[key];
    notify();
  }
  void api.unread.markRead(key, new Date().toISOString()).catch(() => { /* silent */ });
}

async function _fetchCounts() {
  try {
    const resp = await api.unread.getCounts();
    const { counts, staleActiveKeys } = reconcileServerCounts(resp.counts ?? {}, _activeKeys);
    _globalCounts = counts;
    _globalSessionAgentMap = resp.sessionAgentMap ?? {};
    notify();
    // Converge the server on the screen state: an open conversation is read.
    for (const key of staleActiveKeys) _advanceReadCursor(key);
  } catch { /* silent */ }
}

function _startPolling() {
  if (_pollTimer) return;
  _fetchCounts();
  _pollTimer = setInterval(_fetchCounts, POLL_INTERVAL_MS);
  _wsUnsub = wsClient.on('chat:unread_update', (event) => {
    const key = (event.payload as { conversationKey?: string })?.conversationKey;
    if (!key) return;
    // The reader is looking at this conversation right now, so the message is
    // already on screen = read. Don't bump the badge; do advance the server
    // cursor so the next poll does not resurrect it (see reconcileServerCounts).
    if (_activeKeys.has(key)) {
      _advanceReadCursor(key);
      return;
    }
    if (Date.now() > _graceUntil) {
      _globalCounts[key] = (_globalCounts[key] ?? 0) + 1;
      notify();
    }
  });
}

function _stopPolling() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  if (_wsUnsub) { _wsUnsub(); _wsUnsub = null; }
}

export function useUnreadCounts(opts?: { enabled?: boolean }) {
  const enabled = opts?.enabled ?? true;
  const [counts, setCounts] = useState<Record<string, number>>(_globalCounts);
  const [sessionAgentMap, setSessionAgentMap] = useState<Record<string, string>>(_globalSessionAgentMap);

  const refresh = useCallback(async () => {
    await _fetchCounts();
  }, []);

  const markRead = useCallback(async (conversationKey: string) => {
    const ts = new Date().toISOString();
    delete _globalCounts[conversationKey];
    notify();
    try {
      await api.unread.markRead(conversationKey, ts);
    } catch { /* silent */ }
  }, []);

  const markAllRead = useCallback(async () => {
    _globalCounts = {};
    notify();
    try {
      await api.unread.markAllRead();
    } catch { /* silent */ }
  }, []);

  const setActiveKey = useCallback((key: string) => { _activeKeys.add(key); }, []);
  const clearActiveKey = useCallback((key: string) => {
    _activeKeys.delete(key);
    _graceUntil = Date.now() + 150;
    // Leaving the conversation persists its read state. A message that arrived
    // inside the throttle window was masked client-side but never confirmed to
    // the server, so without this last write the badge would pop back on the
    // next poll for a conversation the reader had open the whole time.
    _lastAutoReadAt.delete(key);
    _advanceReadCursor(key, { force: true });
  }, []);

  useEffect(() => {
    if (!enabled) return;

    _subscriberCount++;
    _startPolling();

    let _prevSessionAgentMap = _globalSessionAgentMap;
    const listener = () => {
      setCounts(prev => sameRecord(prev, _globalCounts) ? prev : { ..._globalCounts });
      if (_prevSessionAgentMap !== _globalSessionAgentMap) {
        _prevSessionAgentMap = _globalSessionAgentMap;
        setSessionAgentMap(prev => sameRecord(prev, _globalSessionAgentMap) ? prev : { ..._globalSessionAgentMap });
      }
    };
    _listeners.add(listener);

    // Sync initial state
    setCounts({ ..._globalCounts });
    setSessionAgentMap({ ..._globalSessionAgentMap });

    return () => {
      _listeners.delete(listener);
      _subscriberCount--;
      if (_subscriberCount <= 0) {
        _subscriberCount = 0;
        _stopPolling();
      }
    };
  }, [enabled]);

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
 * Uses the sessionAgentMap (sessionId -> agentId) returned by the server
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
 * Conversation keys that are not addressed to any human.
 *
 * `channel:dm:a2a:<agentA>:<agentB>` is the deterministic key for an
 * agent-to-agent DM (see core/src/tools/a2a.ts). No human is a participant and
 * no human will ever read it, so those messages must never inflate a badge that
 * means "messages waiting for YOU".
 *
 * Measured on real data before this filter: one account's Team badge read
 * "99+" while the human had 3 genuinely unread messages. The other ~350 came
 * from 10 agent-to-agent DM channels, which accumulate forever precisely
 * because nobody ever opens them to clear the counter.
 *
 * This only affects the AGGREGATE nav badge. Per-conversation badges (the
 * sidebar's A2A DM section) still render their own counts - that is a
 * deliberate monitoring view, not an inbox.
 */
export function isAgentOnlyConversationKey(key: string): boolean {
  return key.startsWith('channel:dm:a2a:');
}

/**
 * Compute the total "Team chat" unread badge count - the number shown as the
 * unread pill on the Team tab of the mobile bottom nav.
 *
 * This mirrors the Team page's roster derivation (unreadByAgent via
 * useAgentUnread + unreadByChannel) rather than blindly summing every
 * conversation key:
 *  - `session:*` keys count only when the session maps to an agent in
 *    `sessionAgentMap` (orphan sessions / deleted agents are not visible in
 *    the roster)
 *  - `channel:*` keys (group chats / human DMs / notes channels) count, EXCEPT
 *    agent-to-agent DMs - see isAgentOnlyConversationKey
 * Anything outside those two prefixes is ignored.
 */
export function sumTeamChatUnread(
  counts: Record<string, number>,
  sessionAgentMap: Record<string, string>,
): number {
  let total = 0;
  for (const [key, count] of Object.entries(counts)) {
    if (key.startsWith('session:')) {
      const sessionId = key.slice('session:'.length);
      if (sessionAgentMap[sessionId]) total += count;
    } else if (key.startsWith('channel:')) {
      // Agent-to-agent DMs are not addressed to any human; excluding them is
      // what keeps the nav badge honest (see isAgentOnlyConversationKey).
      if (isAgentOnlyConversationKey(key)) continue;
      total += count;
    }
  }
  return total;
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
