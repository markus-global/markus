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

import { sumTeamChatUnread } from './useUnreadCounts.ts';

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
});