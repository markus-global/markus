import { describe, expect, it, vi } from 'vitest';

// useUnreadCounts.ts transitively imports api.ts which reads `window` at module
// load. jsdom is not installed in this repo, so provide a minimal window stub
// BEFORE the module is imported (vi.hoisted runs before imports).
vi.hoisted(() => {
  (globalThis as unknown as { window: unknown }).window = {
    __MARKUS_HUB_BASE_URL__: '',
    location: { origin: 'http://localhost' },
  } as unknown as Window & typeof globalThis;
  return true;
});

import { sumTeamChatUnread, isAgentOnlyConversationKey, reconcileServerCounts } from './useUnreadCounts.ts';

describe('reconcileServerCounts (an open conversation is read by definition)', () => {
  it('drops the conversation the reader has open, keeps every other one', () => {
    // The reported bug: sitting in agent A's chat, A replies -> A's row (and the
    // team row above it, and the nav badge) grew a "1" for a message already on
    // screen. The 60s poll re-synced from the server, which still counted it.
    const server = { 'session:open': 1, 'session:other': 3, 'channel:group:team_x': 2 };
    const { counts, staleActiveKeys } = reconcileServerCounts(server, new Set(['session:open']));

    expect(counts).toEqual({ 'session:other': 3, 'channel:group:team_x': 2 });
    expect(counts['session:open']).toBeUndefined();
    // ...and the server is told, so the next poll agrees with the screen.
    expect(staleActiveKeys).toEqual(['session:open']);
  });

  it('covers channels and DMs the same way (group chat open = its badge is read)', () => {
    const server = { 'channel:group:team_x': 4, 'channel:dm:u1:u2': 1, 'channel:group:team_y': 2 };
    const { counts, staleActiveKeys } = reconcileServerCounts(
      server,
      new Set(['channel:group:team_x', 'channel:dm:u1:u2']),
    );

    expect(counts).toEqual({ 'channel:group:team_y': 2 });
    expect(staleActiveKeys.sort()).toEqual(['channel:dm:u1:u2', 'channel:group:team_x']);
  });

  it('does not ask for a cursor advance when the server already agrees (count 0)', () => {
    const { counts, staleActiveKeys } = reconcileServerCounts({ 'session:open': 0 }, new Set(['session:open']));
    expect(counts).toEqual({});
    expect(staleActiveKeys).toEqual([]);
  });

  it('is a no-op when nothing is active (cold load / hidden page)', () => {
    const server = { 'session:a': 2, 'channel:group:team_x': 5 };
    const { counts, staleActiveKeys } = reconcileServerCounts(server, new Set());
    expect(counts).toEqual(server);
    expect(staleActiveKeys).toEqual([]);
  });

  it('never mutates the server payload it was handed', () => {
    const server = { 'session:open': 1, 'session:other': 3 };
    reconcileServerCounts(server, new Set(['session:open']));
    expect(server).toEqual({ 'session:open': 1, 'session:other': 3 });
  });
});

describe('sumTeamChatUnread (BottomNav Team badge — matches Team roster derivation)', () => {
  const agentMap = { s1: 'agt-a', s2: 'agt-b' };

  it('counts agent-mapped sessions + all channel keys', () => {
    const counts = {
      'session:s1': 2,
      'session:s2': 3,
      'channel:gc-team': 4,
      'channel:dm:u1:u2': 1,
    };
    expect(sumTeamChatUnread(counts, agentMap)).toBe(10);
  });

  it('EXCLUDES orphan sessions (session not in sessionAgentMap) — 旧全量求和会多计', () => {
    // Orphan session: cursor exists in counts but the session has no agent
    // mapping (e.g. agent deleted). The Team roster cannot display it, so the
    // BottomNav badge must not count it either.
    const counts = {
      'session:s1': 2,
      'session:orphan': 5,
      'channel:gc-team': 4,
    };
    expect(sumTeamChatUnread(counts, agentMap)).toBe(6); // 2 + 4, NOT 2 + 5 + 4
  });

  it('counts notes / self-notes channels (channel:* prefix, as roster does for its entries)', () => {
    const counts = {
      'channel:notes:u1': 1,
      'channel:dm:u1:u2': 1,
    };
    expect(sumTeamChatUnread(counts, {})).toBe(2);
  });

  it('ignores keys outside session:/channel: prefixes', () => {
    const counts = {
      'session:s1': 1,
      'channel:gc-team': 2,
      'agent:agt-a': 99,
      'unknown:xyz': 7,
    };
    expect(sumTeamChatUnread(counts, agentMap)).toBe(3);
  });

  it('returns 0 for empty / all-zero counts', () => {
    expect(sumTeamChatUnread({}, agentMap)).toBe(0);
    expect(sumTeamChatUnread({ 'session:s1': 0, 'channel:gc-team': 0 }, agentMap)).toBe(0);
  });

  it('handles undeclared session in map (mapping exists but no count) without throwing', () => {
    expect(sumTeamChatUnread({ 'channel:gc-team': 2 }, { s_missing: 'agt-x' })).toBe(2);
  });

  it('EXCLUDES agent-to-agent DM channels from the nav badge (regression: badge read 99+)', () => {
    // Real data that produced a bogus "99+" on the Team tab: ~350 unread
    // messages sitting in 10 agent-to-agent DM channels, none of which the
    // human is party to, plus 3 messages that were genuinely theirs.
    const counts = {
      'channel:dm:a2a:agt_a:agt_b': 91,
      'channel:dm:a2a:agt_c:agt_d': 61,
      'channel:dm:a2a:agt_e:agt_f': 58,
      'session:s1': 2,
      'session:s2': 1,
    };
    expect(sumTeamChatUnread(counts, agentMap)).toBe(3);
  });

  it('still counts human DMs, notes and group channels (only a2a is excluded)', () => {
    const counts = {
      'channel:dm:a2a:agt_a:agt_b': 91,
      'channel:dm:u1:u2': 4,
      'channel:notes:u1': 2,
      'channel:gc-team': 3,
    };
    expect(sumTeamChatUnread(counts, {})).toBe(9);
  });

  it('does not confuse a human DM key with an agent-only one', () => {
    // The prefix test must require the full `channel:dm:a2a:` marker, so an
    // agent id that merely starts with the letters a2a cannot slip through,
    // and a human DM with an `a2a`-ish user id is still counted.
    expect(isAgentOnlyConversationKey('channel:dm:a2a:a:b')).toBe(true);
    expect(isAgentOnlyConversationKey('channel:dm:a2aX:a:b')).toBe(false);
    expect(isAgentOnlyConversationKey('channel:dm:user:a2abc')).toBe(false);
    expect(isAgentOnlyConversationKey('channel:group:team_1')).toBe(false);
    expect(isAgentOnlyConversationKey('session:s1')).toBe(false);
  });
});