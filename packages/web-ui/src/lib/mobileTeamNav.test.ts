/**
 * Mobile Team back-navigation rules.
 *
 * These lock down the loop where Back from an agent chat escaped to whatever
 * page you came from (Notifications / Home), so tapping Team re-opened the same
 * agent and Back escaped again — L1/L2 were unreachable.
 */
import { describe, it, expect } from 'vitest';
import { resolveMobileChatBackHash, teamChannelKey } from './mobileTeamNav.ts';

const TEAMS = ['team_a', 'team_b'];

describe('resolveMobileChatBackHash — direct agent chat', () => {
  it('returns the agent team L2 when that team is loaded', () => {
    expect(resolveMobileChatBackHash({
      chatMode: 'direct',
      agentTeamId: 'team_a',
      knownTeamIds: TEAMS,
    })).toBe('team/t/team_a');
  });

  it('falls back to L1 when the agent has no team', () => {
    // A teamless agent (teamId '' / null) has no L2 to return to.
    expect(resolveMobileChatBackHash({ chatMode: 'direct', agentTeamId: '', knownTeamIds: TEAMS })).toBe('team');
    expect(resolveMobileChatBackHash({ chatMode: 'direct', agentTeamId: null, knownTeamIds: TEAMS })).toBe('team');
    expect(resolveMobileChatBackHash({ chatMode: 'direct', knownTeamIds: TEAMS })).toBe('team');
  });

  it('falls back to L1 for a deleted team instead of aiming at an undrawable L2', () => {
    // Aiming Back at a deleted team reproduces the blank-L2 failure.
    expect(resolveMobileChatBackHash({
      chatMode: 'direct',
      agentTeamId: 'team_gone',
      knownTeamIds: TEAMS,
    })).toBe('team');
  });

  it('falls back to L1 when the team list has not loaded yet', () => {
    // An empty list is "unknown", not "gone": L1 is the only safe destination.
    expect(resolveMobileChatBackHash({ chatMode: 'direct', agentTeamId: 'team_a', knownTeamIds: [] })).toBe('team');
  });

  it('accepts a Set of known teams', () => {
    expect(resolveMobileChatBackHash({
      chatMode: 'direct',
      agentTeamId: 'team_a',
      knownTeamIds: new Set(TEAMS),
    })).toBe('team/t/team_a');
  });
});

describe('resolveMobileChatBackHash — channels and DMs', () => {
  it('returns the channel team L2', () => {
    expect(resolveMobileChatBackHash({
      chatMode: 'channel',
      channelTeamId: 'team_b',
      knownTeamIds: TEAMS,
    })).toBe('team/t/team_b');
  });

  it('returns L1 for a group chat with no team', () => {
    expect(resolveMobileChatBackHash({ chatMode: 'channel', channelTeamId: null, knownTeamIds: TEAMS })).toBe('team');
  });

  it('returns L1 for a human DM', () => {
    expect(resolveMobileChatBackHash({ chatMode: 'dm', knownTeamIds: TEAMS })).toBe('team');
  });

  it('ignores a stale agentTeamId while in a DM', () => {
    // Guards against a leftover selection leaking an L2 for a DM conversation.
    expect(resolveMobileChatBackHash({
      chatMode: 'dm',
      agentTeamId: 'team_a',
      knownTeamIds: TEAMS,
    })).toBe('team');
  });
});

describe('resolveMobileChatBackHash — never escapes Team', () => {
  it('always returns a Team-layer hash for every mode', () => {
    // The regression: Back used to restore the previous page (Home /
    // Notifications). Anything outside `team` reintroduces that loop.
    const modes = ['direct', 'channel', 'dm', 'unknown'];
    for (const chatMode of modes) {
      const hash = resolveMobileChatBackHash({
        chatMode,
        agentTeamId: 'team_a',
        channelTeamId: 'team_b',
        knownTeamIds: TEAMS,
      });
      expect(hash === 'team' || hash.startsWith('team/t/'), `${chatMode} -> ${hash}`).toBe(true);
    }
  });
});

describe('teamChannelKey', () => {
  it('builds the synthetic team channel key', () => {
    // Team channels have no group_chats row, so this key is the only handle.
    expect(teamChannelKey('team_a')).toBe('group:team_a');
  });
});
