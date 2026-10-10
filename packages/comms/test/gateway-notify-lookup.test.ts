/**
 * Slice G4 — the production notify-target lookup, backed by `channel_bindings`.
 *
 * A notification target is a binding whose `kind` is `notification` — the same
 * table that routes inbound, read for the *outbound* question. Keeping it in one
 * table is what lets "the agent's channel" and "where the agent's notifications
 * go" agree by construction, and lets the global level fall back to whoever the
 * org's Secretary is.
 */
import { describe, it, expect } from 'vitest';
import { RepoNotifyTargetLookup, type BindingRowLike, type InstanceRowLike } from '../src/gateway/notify-lookup.js';

function binding(over: Partial<BindingRowLike>): BindingRowLike {
  return {
    id: 'cb_x',
    orgId: 'default',
    scope: 'channel',
    instanceId: 'bi_a',
    nativeId: 'chat_1',
    kind: 'notification',
    agentId: 'agt_x',
    ...over,
  };
}

const INSTANCES: Record<string, InstanceRowLike> = {
  bi_a: { id: 'bi_a', platform: 'telegram' },
  bi_b: { id: 'bi_b', platform: 'slack' },
  bi_sec: { id: 'bi_sec', platform: 'feishu' },
};

function lookupOf(rows: BindingRowLike[], secretaryId?: string) {
  return new RepoNotifyTargetLookup({
    bindingRepo: { listByOrg: () => rows },
    instanceRepo: { findById: (id) => INSTANCES[id] },
    orgSecretaryId: () => secretaryId,
  });
}

describe('RepoNotifyTargetLookup', () => {
  it('resolves an agent-level notification sink', () => {
    const lookup = lookupOf([
      binding({ id: 'cb1', scope: 'channel', instanceId: 'bi_a', nativeId: 'chat_1', agentId: 'agt_x' }),
    ]);
    expect(lookup.agentTarget('default', 'agt_x')).toEqual({
      platform: 'telegram',
      instanceId: 'bi_a',
      nativeId: 'chat_1',
      kind: 'notification',
    });
  });

  it('resolves the instance-level sink for an agent bound in that instance', () => {
    const lookup = lookupOf([
      binding({ id: 'cb_route', scope: 'instance', instanceId: 'bi_b', nativeId: null, kind: null, agentId: 'agt_ops' }),
      binding({ id: 'cb_notify', scope: 'instance', instanceId: 'bi_b', nativeId: 'C_NOTIFY', agentId: 'agt_bot' }),
    ]);
    expect(lookup.instanceTarget('default', 'agt_ops')).toEqual({
      platform: 'slack',
      instanceId: 'bi_b',
      nativeId: 'C_NOTIFY',
      kind: 'notification',
    });
  });

  it('falls back to the Secretary notification sink at the global level', () => {
    const lookup = lookupOf([
      binding({ id: 'cb_sec_route', scope: 'instance', instanceId: 'bi_sec', nativeId: null, kind: null, agentId: 'agt_secretary' }),
      binding({ id: 'cb_sec_notify', scope: 'instance', instanceId: 'bi_sec', nativeId: 'oc_owner', agentId: 'agt_secretary' }),
    ], 'agt_secretary');
    expect(lookup.globalTarget('default')).toEqual({
      platform: 'feishu',
      instanceId: 'bi_sec',
      nativeId: 'oc_owner',
      kind: 'notification',
    });
  });

  it('uses the platform fallback when the Secretary has no sink', () => {
    const lookup = new RepoNotifyTargetLookup({
      bindingRepo: { listByOrg: () => [] },
      instanceRepo: { findById: (id) => INSTANCES[id] },
      orgSecretaryId: () => 'agt_secretary',
      fallback: (orgId) =>
        orgId === 'default' ? { platform: 'feishu', instanceId: 'bi_sec', nativeId: 'oc_legacy' } : undefined,
    });
    expect(lookup.globalTarget('default')?.nativeId).toBe('oc_legacy');
  });

  it('treats the agent’s own channel as the target when no notification binding exists', () => {
    // The G1 migration seeds routing bindings with kind = NULL; requiring the
    // marker here would leave migrated installs unable to notify anyone.
    const lookup = lookupOf([
      binding({ id: 'cb_route', scope: 'channel', instanceId: 'bi_a', nativeId: 'chat_1', kind: null, agentId: 'agt_x' }),
    ]);
    expect(lookup.agentTarget('default', 'agt_x')?.nativeId).toBe('chat_1');
  });

  it('prefers an explicit notification binding over the agent’s other channels', () => {
    const lookup = lookupOf([
      binding({ id: 'cb_group', scope: 'channel', instanceId: 'bi_a', nativeId: 'group_1', kind: 'group', agentId: 'agt_x' }),
      binding({ id: 'cb_dm', scope: 'channel', instanceId: 'bi_a', nativeId: 'dm_1', kind: 'direct', agentId: 'agt_x' }),
      binding({ id: 'cb_notify', scope: 'channel', instanceId: 'bi_b', nativeId: 'C_NOTIFY', agentId: 'agt_x' }),
    ]);
    expect(lookup.agentTarget('default', 'agt_x')?.nativeId).toBe('C_NOTIFY');
  });

  it('resolves the global level from the Secretary’s own channel (migrated install)', () => {
    const lookup = lookupOf([
      binding({ id: 'cb_sec', scope: 'channel', instanceId: 'bi_sec', nativeId: 'oc_owner', kind: null, agentId: 'agt_secretary' }),
    ], 'agt_secretary');
    expect(lookup.globalTarget('default')?.nativeId).toBe('oc_owner');
  });

  it('returns undefined for an unknown agent', () => {
    const lookup = lookupOf([binding({ agentId: 'agt_other' })]);
    expect(lookup.agentTarget('default', 'agt_x')).toBeUndefined();
    expect(lookup.instanceTarget('default', 'agt_x')).toBeUndefined();
  });

  it('returns undefined when there is no global target and no fallback', () => {
    expect(lookupOf([]).globalTarget('default')).toBeUndefined();
  });

  it('resolves the instance’s notification-target agent (G5 UI `config.notifyAgentId`)', () => {
    // Closes the G4×G5 seam: the "Notification target" the operator picks is an
    // agent; its own conversation is the level-2 sink.
    const lookup = new RepoNotifyTargetLookup({
      bindingRepo: {
        listByOrg: () => [
          binding({ id: 'cb_route', scope: 'instance', instanceId: 'bi_a', nativeId: null, kind: null, agentId: 'agt_ops' }),
          binding({ id: 'cb_sec', scope: 'channel', instanceId: 'bi_a', nativeId: 'chat_sec', agentId: 'agt_secretary' }),
        ],
      },
      instanceRepo: { findById: (id) => id === 'bi_a' ? { id: 'bi_a', platform: 'telegram', config: { notifyAgentId: 'agt_secretary' } } : INSTANCES[id] },
    });
    expect(lookup.instanceTarget('default', 'agt_ops')).toEqual({
      platform: 'telegram',
      instanceId: 'bi_a',
      nativeId: 'chat_sec',
      kind: 'notification',
    });
  });

  it('ignores a blank notification target and falls through ("leave empty to use the org secretary")', () => {
    const lookup = new RepoNotifyTargetLookup({
      bindingRepo: {
        listByOrg: () => [
          binding({ id: 'cb_route', scope: 'instance', instanceId: 'bi_a', nativeId: null, kind: null, agentId: 'agt_ops' }),
        ],
      },
      instanceRepo: { findById: (id) => id === 'bi_a' ? { id: 'bi_a', platform: 'telegram', config: { notifyAgentId: '   ' } } : INSTANCES[id] },
    });
    expect(lookup.instanceTarget('default', 'agt_ops')).toBeUndefined();
  });

  it('lets an explicit `notification` binding win over the declared target agent', () => {
    const lookup = new RepoNotifyTargetLookup({
      bindingRepo: {
        listByOrg: () => [
          binding({ id: 'cb_route', scope: 'instance', instanceId: 'bi_a', nativeId: null, kind: null, agentId: 'agt_ops' }),
          binding({ id: 'cb_sink', scope: 'instance', instanceId: 'bi_a', nativeId: 'C_SINK', agentId: 'agt_bot' }),
          binding({ id: 'cb_sec', scope: 'channel', instanceId: 'bi_a', nativeId: 'chat_sec', agentId: 'agt_secretary' }),
        ],
      },
      instanceRepo: { findById: (id) => id === 'bi_a' ? { id: 'bi_a', platform: 'telegram', config: { notifyAgentId: 'agt_secretary' } } : INSTANCES[id] },
    });
    expect(lookup.instanceTarget('default', 'agt_ops')?.nativeId).toBe('C_SINK');
  });
});
