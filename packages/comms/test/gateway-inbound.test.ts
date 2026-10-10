import { describe, it, expect } from 'vitest';
import { resolveInboundTarget, type BindingLookup, type ScopeBinding } from '../src/gateway/inbound.js';
import {
  conversationKeyOf,
  isInboundIgnored,
  MAIN_CONVERSATION_KEY,
} from '../src/gateway/conversation-key.js';

/** A lookup backed by literal rows — the resolver is pure, so no DB is needed. */
function lookup(opts: {
  bindings?: ScopeBinding[];
  platformDefault?: string;
  secretary?: string;
}): BindingLookup {
  const rows = opts.bindings ?? [];
  return {
    bindings: (orgId) => (orgId ? rows : rows),
    platformDefaultAgent: () => opts.platformDefault,
    orgDefaultAgent: opts.secretary ? () => opts.secretary : undefined,
  };
}

describe('resolveInboundTarget — nearest wins, level recorded', () => {
  it('level 1: an explicit agentId on the message always wins', () => {
    const target = resolveInboundTarget(
      { orgId: 'o', platform: 'slack', nativeId: 'C1', instanceId: 'bi_1', explicitAgentId: 'agent-x' },
      lookup({
        bindings: [
          { scope: 'channel', instanceId: 'bi_1', nativeId: 'C1', kind: null, agentId: 'agent-channel' },
          { scope: 'instance', instanceId: 'bi_1', nativeId: null, kind: null, agentId: 'agent-instance' },
          { scope: 'global', instanceId: null, nativeId: null, kind: null, agentId: 'agent-global' },
        ],
        platformDefault: 'agent-platform',
      }),
    );
    expect(target?.agentId).toBe('agent-x');
    expect(target?.matchedScope).toBe('explicit');
  });

  it('level 2: a channel binding beats the instance, platform and global levels', () => {
    const target = resolveInboundTarget(
      { orgId: 'o', platform: 'slack', nativeId: 'C1', instanceId: 'bi_1' },
      lookup({
        bindings: [
          { scope: 'channel', instanceId: 'bi_1', nativeId: 'C1', kind: null, agentId: 'agent-channel' },
          { scope: 'instance', instanceId: 'bi_1', nativeId: null, kind: null, agentId: 'agent-instance' },
          { scope: 'global', instanceId: null, nativeId: null, kind: null, agentId: 'agent-global' },
        ],
        platformDefault: 'agent-platform',
      }),
    );
    expect(target?.agentId).toBe('agent-channel');
    expect(target?.matchedScope).toBe('channel');
  });

  it('level 3: the instance binding beats platform and global', () => {
    const target = resolveInboundTarget(
      { orgId: 'o', platform: 'slack', nativeId: 'C9', instanceId: 'bi_1' },
      lookup({
        bindings: [
          { scope: 'instance', instanceId: 'bi_1', nativeId: null, kind: null, agentId: 'agent-instance' },
          { scope: 'global', instanceId: null, nativeId: null, kind: null, agentId: 'agent-global' },
        ],
        platformDefault: 'agent-platform',
      }),
    );
    expect(target?.agentId).toBe('agent-instance');
    expect(target?.matchedScope).toBe('instance');
  });

  it('level 4: an unbound instance falls back to the platform default', () => {
    const target = resolveInboundTarget(
      { orgId: 'o', platform: 'slack', nativeId: 'C9', instanceId: 'bi_other' },
      lookup({
        bindings: [{ scope: 'global', instanceId: null, nativeId: null, kind: null, agentId: 'agent-global' }],
        platformDefault: 'agent-platform',
      }),
    );
    expect(target?.agentId).toBe('agent-platform');
    expect(target?.matchedScope).toBe('platform');
  });

  it('level 5: an unbound platform falls back to the global binding, never dropped (D6)', () => {
    const target = resolveInboundTarget(
      { orgId: 'o', platform: 'telegram', nativeId: '12345' },
      lookup({
        bindings: [{ scope: 'global', instanceId: null, nativeId: null, kind: null, agentId: 'secretary' }],
      }),
    );
    expect(target?.agentId).toBe('secretary');
    expect(target?.matchedScope).toBe('global');
  });

  it('level 5: falls back to the live Secretary when no global binding row exists', () => {
    const target = resolveInboundTarget(
      { orgId: 'o', platform: 'telegram', nativeId: '12345' },
      lookup({ secretary: 'agt_secretary' }),
    );
    expect(target?.agentId).toBe('agt_secretary');
    expect(target?.matchedScope).toBe('global');
  });

  it('returns undefined only when nothing at all is bound', () => {
    const target = resolveInboundTarget(
      { orgId: 'o', platform: 'telegram', nativeId: '12345' },
      lookup({}),
    );
    expect(target).toBeUndefined();
  });
});

describe('conversation identity — stable and isolated', () => {
  it('two groups of the same instance get independent session keys', () => {
    const a = conversationKeyOf({ instanceId: 'bi_1', nativeId: 'group-A', kind: 'group' });
    const b = conversationKeyOf({ instanceId: 'bi_1', nativeId: 'group-B', kind: 'group' });
    expect(a).not.toBe(b);
    expect(resolveInboundTarget(
      { orgId: 'o', platform: 'feishu', nativeId: 'group-A', instanceId: 'bi_1', kind: 'group' },
      lookup({ platformDefault: 'agent' }),
    )?.conversationKey).toBe(a);
  });

  it('two external users (two dms) do not share a key', () => {
    const userA = conversationKeyOf({ instanceId: 'bi_1', nativeId: 'dm-u1', kind: 'dm' });
    const userB = conversationKeyOf({ instanceId: 'bi_1', nativeId: 'dm-u2', kind: 'dm' });
    expect(userA).not.toBe(userB);
  });

  it('the same conversation always maps to the same key (stability)', () => {
    const ref = { instanceId: 'bi_1', nativeId: 'group-A', kind: 'group' as const };
    expect(conversationKeyOf(ref)).toBe(conversationKeyOf({ ...ref }));
  });

  it('is collision-free across the tuple (percent-encoded parts)', () => {
    const one = conversationKeyOf({ instanceId: 'a:b', nativeId: 'c', kind: 'dm' });
    const two = conversationKeyOf({ instanceId: 'a', nativeId: 'b:c', kind: 'dm' });
    expect(one).not.toBe(two);
  });

  it('a channel designated `main` maps to the agent main session', () => {
    const target = resolveInboundTarget(
      { orgId: 'o', platform: 'feishu', nativeId: 'oc_home', instanceId: 'bi_1', kind: 'group' },
      lookup({
        bindings: [
          { scope: 'channel', instanceId: 'bi_1', nativeId: 'oc_home', kind: 'main', agentId: 'agent-1' },
        ],
      }),
    );
    expect(target?.kind).toBe('main');
    expect(target?.conversationKey).toBe(MAIN_CONVERSATION_KEY);
  });

  it('a notification channel is outbound-only — inbound is ignored, not routed', () => {
    expect(isInboundIgnored('notification')).toBe(true);
    const target = resolveInboundTarget(
      { orgId: 'o', platform: 'feishu', nativeId: 'oc_notify', instanceId: 'bi_1', kind: 'notification' },
      lookup({ platformDefault: 'agent' }),
    );
    expect(target?.ignored).toBe(true);
  });

  it('defaults an adapter-declared-less message to a group-kind key', () => {
    const target = resolveInboundTarget(
      { orgId: 'o', platform: 'slack', nativeId: 'C1', instanceId: 'bi_1' },
      lookup({ platformDefault: 'agent' }),
    );
    expect(target?.kind).toBe('group');
    expect(target?.conversationKey).toBe('im:bi_1:group:C1');
  });
});
