/**
 * The production notify-target lookup, backed by `channel_bindings` +
 * `platform_instances`.
 *
 * The decisive new property (R1): an instance's **declared** destination resolves
 * with *no binding at all*, so a bot the user configured in Settings is reachable
 * even when no agent has ever been DM'd.
 *
 * The second property this file pins is the 2026-10-16 fix: the lookup now
 * **enumerates** every reachable destination instead of returning one, so the walk
 * can move past a bot whose notifications are off; and the order it enumerates in
 * is stated here, not inherited from `ORDER BY label` (which is how a bot labelled
 * `CTO` silently outranked one labelled `default`).
 */
import { describe, it, expect } from 'vitest';
import {
  RepoNotifyTargetLookup,
  type BindingRowLike,
  type InstanceRowLike,
  type RepoNotifyTargetLookupDeps,
} from '../src/gateway/notify-lookup.js';
import { resolveNotifyTarget, type NotifyCandidate } from '../src/gateway/notify-route.js';
import type { PlatformField } from '../src/platforms/registry.js';

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

/** A stand-in manifest: a chat destination first, then a user destination. */
const DECLARED_FIELDS: PlatformField[] = [
  { key: 'notifyChatId', label: 'Default chat ID', type: 'text', required: false, notifyTarget: 'chat' },
  { key: 'notifyOpenId', label: 'Default open ID', type: 'text', required: false, notifyTarget: 'user' },
];

function lookupOf(rows: BindingRowLike[], secretaryId?: string): RepoNotifyTargetLookup {
  return new RepoNotifyTargetLookup({
    bindingRepo: { listByOrg: () => rows },
    instanceRepo: { findById: (id) => INSTANCES[id] },
    orgSecretaryId: () => secretaryId,
  });
}

/** The first candidate at a given level — what the old per-level API used to return. */
function firstAt(candidates: NotifyCandidate[], scope: NotifyCandidate['scope']) {
  return candidates.find((c) => c.scope === scope)?.target;
}

const atAgent = (l: RepoNotifyTargetLookup, agentId: string) =>
  firstAt(l.candidates('default', { agentId }), 'agent');
const atInstance = (l: RepoNotifyTargetLookup, agentId?: string) =>
  firstAt(l.candidates('default', agentId ? { agentId } : {}), 'instance');
const atGlobal = (l: RepoNotifyTargetLookup) => firstAt(l.candidates('default', {}), 'global');

describe('RepoNotifyTargetLookup', () => {
  it('resolves an agent-level notification sink', () => {
    const lookup = lookupOf([
      binding({ id: 'cb1', scope: 'channel', instanceId: 'bi_a', nativeId: 'chat_1', agentId: 'agt_x' }),
    ]);
    expect(atAgent(lookup, 'agt_x')).toEqual({
      platform: 'telegram',
      instanceId: 'bi_a',
      nativeId: 'chat_1',
      kind: 'notification',
    });
  });

  it('resolves an instance-level `notification` binding sink', () => {
    const lookup = lookupOf([
      binding({ id: 'cb_route', scope: 'instance', instanceId: 'bi_b', nativeId: null, kind: null, agentId: 'agt_ops' }),
      binding({ id: 'cb_notify', scope: 'instance', instanceId: 'bi_b', nativeId: 'C_NOTIFY', agentId: 'agt_bot' }),
    ]);
    expect(atInstance(lookup, 'agt_ops')).toEqual({
      platform: 'slack',
      instanceId: 'bi_b',
      nativeId: 'C_NOTIFY',
      kind: 'notification',
    });
  });

  it('reads a destination declared in instance config — with NO binding at all (R1)', () => {
    const instance: InstanceRowLike = { id: 'bi_f', platform: 'feishu', config: { notifyChatId: 'oc_ops' } };
    const lookup = new RepoNotifyTargetLookup({
      bindingRepo: { listByOrg: () => [] },
      instanceRepo: { findById: () => instance, listByOrg: () => [instance] },
      fieldDefs: () => DECLARED_FIELDS,
    });
    expect(atInstance(lookup, 'agt_unbound')).toEqual({
      platform: 'feishu',
      instanceId: 'bi_f',
      nativeId: 'oc_ops',
      receiveIdType: 'chat_id',
      kind: 'notification',
    });
  });

  it('maps a `user`-kind declaration onto the wire receive-id type (open_id)', () => {
    const instance: InstanceRowLike = { id: 'bi_f', platform: 'feishu', config: { notifyOpenId: 'ou_person' } };
    const lookup = new RepoNotifyTargetLookup({
      bindingRepo: { listByOrg: () => [] },
      instanceRepo: { findById: () => instance, listByOrg: () => [instance] },
      fieldDefs: () => DECLARED_FIELDS,
    });
    expect(atInstance(lookup)?.receiveIdType).toBe('open_id');
  });

  it('prefers the chat declaration over the user declaration (manifest order)', () => {
    const instance: InstanceRowLike = {
      id: 'bi_f', platform: 'feishu', config: { notifyChatId: 'oc_chat', notifyOpenId: 'ou_person' },
    };
    const lookup = new RepoNotifyTargetLookup({
      bindingRepo: { listByOrg: () => [] },
      instanceRepo: { findById: () => instance, listByOrg: () => [instance] },
      fieldDefs: () => DECLARED_FIELDS,
    });
    expect(atInstance(lookup)?.nativeId).toBe('oc_chat');
  });

  it('ignores a blank declared value and treats the destination as undeclared', () => {
    const instance: InstanceRowLike = { id: 'bi_f', platform: 'feishu', config: { notifyChatId: '   ' } };
    const lookup = new RepoNotifyTargetLookup({
      bindingRepo: { listByOrg: () => [] },
      instanceRepo: { findById: () => instance, listByOrg: () => [instance] },
      fieldDefs: () => DECLARED_FIELDS,
    });
    expect(atInstance(lookup)).toBeUndefined();
  });

  it('prefers the agent’s own instance declared destination over an unrelated one', () => {
    const mine: InstanceRowLike = { id: 'bi_mine', platform: 'telegram', config: { notifyChatId: 'mine' } };
    const other: InstanceRowLike = { id: 'bi_other', platform: 'slack', config: { notifyChatId: 'other' } };
    const lookup = new RepoNotifyTargetLookup({
      bindingRepo: {
        listByOrg: () => [binding({ id: 'cb_route', scope: 'instance', instanceId: 'bi_mine', nativeId: null, kind: null, agentId: 'agt_ops' })],
      },
      instanceRepo: {
        findById: (id) => (id === 'bi_mine' ? mine : id === 'bi_other' ? other : undefined),
        listByOrg: () => [other, mine],
      },
      fieldDefs: () => DECLARED_FIELDS,
    });
    expect(atInstance(lookup, 'agt_ops')?.nativeId).toBe('mine');
  });

  it('offers EVERY declaring instance, not just the first — so the walk can move on', () => {
    const cto: InstanceRowLike = { id: 'bi_cto', platform: 'feishu', config: { notifyChatId: 'oc_cto' } };
    const def: InstanceRowLike = { id: 'bi_default', platform: 'feishu', config: { notifyChatId: 'oc_default' } };
    const lookup = new RepoNotifyTargetLookup({
      bindingRepo: { listByOrg: () => [] },
      instanceRepo: { findById: (id) => (id === 'bi_cto' ? cto : id === 'bi_default' ? def : undefined), listByOrg: () => [cto, def] },
      fieldDefs: () => DECLARED_FIELDS,
    });
    expect(lookup.candidates('default', { agentId: 'agt_ops' }).map((c) => c.target.instanceId))
      .toEqual(['bi_cto', 'bi_default']);
  });

  it('never lets a disabled bot be a destination — it is not even connected', () => {
    const off: InstanceRowLike = { id: 'bi_off', platform: 'feishu', config: { notifyChatId: 'oc_off' }, enabled: false };
    const on: InstanceRowLike = { id: 'bi_on', platform: 'feishu', config: { notifyChatId: 'oc_on' } };
    const lookup = new RepoNotifyTargetLookup({
      bindingRepo: { listByOrg: () => [] },
      instanceRepo: { findById: (id) => (id === 'bi_off' ? off : id === 'bi_on' ? on : undefined), listByOrg: () => [off, on] },
      fieldDefs: () => DECLARED_FIELDS,
    });
    expect(lookup.candidates('default', { agentId: 'agt_ops' }).map((c) => c.target.instanceId)).toEqual(['bi_on']);
  });

  it('orders the remaining instances by creation, never by label (the `CTO` mis-route)', () => {
    // Same platform, and `CTO` sorts before `default` alphabetically — the ordering
    // that used to decide which bot carried the org's notifications.
    const cto: InstanceRowLike = { id: 'bi_cto', platform: 'feishu', createdAt: '2026-01-02T00:00:00Z', config: { notifyChatId: 'oc_cto' } };
    const def: InstanceRowLike = { id: 'bi_default', platform: 'feishu', createdAt: '2026-01-01T00:00:00Z', config: { notifyChatId: 'oc_def' } };
    const lookup = new RepoNotifyTargetLookup({
      bindingRepo: { listByOrg: () => [] },
      // The repo hands them back in `(platform, label)` order: CTO first.
      instanceRepo: { findById: (id) => (id === 'bi_cto' ? cto : id === 'bi_default' ? def : undefined), listByOrg: () => [cto, def] },
      fieldDefs: () => DECLARED_FIELDS,
    });
    expect(lookup.candidates('default', { agentId: 'agt_ops' }).map((c) => c.target.instanceId))
      .toEqual(['bi_default', 'bi_cto']);
  });

  it("puts the org's declared global sink instance ahead of the rest", () => {
    const a: InstanceRowLike = { id: 'bi_a2', platform: 'slack', createdAt: '2026-01-01T00:00:00Z', config: { notifyChatId: 'C_A' } };
    const b: InstanceRowLike = { id: 'bi_b2', platform: 'telegram', createdAt: '2026-01-02T00:00:00Z', config: { notifyChatId: 'T_B' } };
    const lookup = new RepoNotifyTargetLookup({
      bindingRepo: {
        // No native id: this binding names the org's *instance*, not a destination.
        listByOrg: () => [binding({ id: 'cb_g', scope: 'global', instanceId: 'bi_b2', nativeId: null, kind: null, agentId: 'agt_x' })],
      },
      instanceRepo: { findById: (id) => (id === 'bi_a2' ? a : id === 'bi_b2' ? b : undefined), listByOrg: () => [a, b] },
      fieldDefs: () => DECLARED_FIELDS,
    });
    // bi_a2 was created first, so creation order alone would pick it; the org's
    // declared sink instance must outrank it.
    expect(lookup.candidates('default', { agentId: 'agt_ops' })[0].target.instanceId).toBe('bi_b2');
  });

  it('falls back to the Secretary’s own conversation at the global level', () => {
    const lookup = lookupOf([
      binding({ id: 'cb_sec_route', scope: 'instance', instanceId: 'bi_sec', nativeId: null, kind: null, agentId: 'agt_secretary' }),
      binding({ id: 'cb_sec_chat', scope: 'channel', instanceId: 'bi_sec', nativeId: 'oc_owner', kind: null, agentId: 'agt_secretary' }),
    ], 'agt_secretary');
    expect(atGlobal(lookup)).toEqual({
      platform: 'feishu',
      instanceId: 'bi_sec',
      nativeId: 'oc_owner',
      kind: 'notification',
    });
  });

  it('uses a global-scope binding with a native id when the Secretary has no sink', () => {
    const lookup = lookupOf([
      binding({ id: 'cb_g', scope: 'global', instanceId: 'bi_sec', nativeId: 'oc_global', kind: null, agentId: 'agt_x' }),
    ]);
    expect(atGlobal(lookup)?.nativeId).toBe('oc_global');
  });

  it('does NOT read a legacy `markus.json` channel — the global level is DB-only (R2)', () => {
    // Before T5 the walk ended on a `fallback` fed from `markus.json`
    // `integrations.feishu.notifyChatId`. That reader is gone (single source of
    // truth): with no DB destination the walk is honestly empty, never a stale
    // file value.
    const lookup = new RepoNotifyTargetLookup({
      bindingRepo: { listByOrg: () => [] },
      instanceRepo: { findById: (id) => INSTANCES[id] },
      orgSecretaryId: () => 'agt_secretary',
    });
    expect(atGlobal(lookup)).toBeUndefined();
  });

  it('treats the agent’s own channel as the target when no notification binding exists', () => {
    // The G1 migration seeds routing bindings with kind = NULL; requiring the
    // marker here would leave migrated installs unable to notify anyone.
    const lookup = lookupOf([
      binding({ id: 'cb_route', scope: 'channel', instanceId: 'bi_a', nativeId: 'chat_1', kind: null, agentId: 'agt_x' }),
    ]);
    expect(atAgent(lookup, 'agt_x')?.nativeId).toBe('chat_1');
  });

  it('prefers an explicit notification binding over the agent’s other channels', () => {
    const lookup = lookupOf([
      binding({ id: 'cb_group', scope: 'channel', instanceId: 'bi_a', nativeId: 'group_1', kind: 'group', agentId: 'agt_x' }),
      binding({ id: 'cb_dm', scope: 'channel', instanceId: 'bi_a', nativeId: 'dm_1', kind: 'direct', agentId: 'agt_x' }),
      binding({ id: 'cb_notify', scope: 'channel', instanceId: 'bi_b', nativeId: 'C_NOTIFY', agentId: 'agt_x' }),
    ]);
    expect(atAgent(lookup, 'agt_x')?.nativeId).toBe('C_NOTIFY');
  });

  it('resolves the global level from the Secretary’s own channel (migrated install)', () => {
    const lookup = lookupOf([
      binding({ id: 'cb_sec', scope: 'channel', instanceId: 'bi_sec', nativeId: 'oc_owner', kind: null, agentId: 'agt_secretary' }),
    ], 'agt_secretary');
    expect(atGlobal(lookup)?.nativeId).toBe('oc_owner');
  });

  it('returns nothing for an unknown agent', () => {
    const lookup = lookupOf([binding({ agentId: 'agt_other' })]);
    expect(lookup.candidates('default', { agentId: 'agt_x' })).toEqual([]);
  });

  it('returns nothing when there is no global target', () => {
    expect(atGlobal(lookupOf([]))).toBeUndefined();
  });

  it('resolves the instance’s notification-target agent (G5 UI `config.notifyAgentId`)', () => {
    // Closes the G4×G5 seam: the "Notification target" the operator picks is an
    // agent; its own conversation is the sink.
    const lookup = new RepoNotifyTargetLookup({
      bindingRepo: {
        listByOrg: () => [
          binding({ id: 'cb_route', scope: 'instance', instanceId: 'bi_a', nativeId: null, kind: null, agentId: 'agt_ops' }),
          binding({ id: 'cb_sec', scope: 'channel', instanceId: 'bi_a', nativeId: 'chat_sec', agentId: 'agt_secretary' }),
        ],
      },
      instanceRepo: { findById: (id) => id === 'bi_a' ? { id: 'bi_a', platform: 'telegram', config: { notifyAgentId: 'agt_secretary' } } : INSTANCES[id] },
    });
    expect(atInstance(lookup, 'agt_ops')).toEqual({
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
    expect(atInstance(lookup, 'agt_ops')).toBeUndefined();
  });

  it('orders an explicit `notification` binding sink ahead of the notify-agent sink', () => {
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
    const instanceScoped = lookup.candidates('default', { agentId: 'agt_ops' })
      .filter((c) => c.scope === 'instance')
      .map((c) => c.target.nativeId);
    expect(instanceScoped).toEqual(['C_SINK', 'chat_sec']);
  });
});

describe('the walk over the real lookup', () => {
  const declared = (config: Record<string, unknown>): InstanceRowLike => ({ id: 'bi_f', platform: 'feishu', config });

  it('a fresh install with no bindings and no destination is `undelivered`', () => {
    const lookup = lookupOf([]);
    expect(resolveNotifyTarget('default', { agentId: 'agt_nobody' }, lookup)).toEqual({
      status: 'undelivered',
      reason: 'no-notify-target',
    });
  });

  it('a declared destination is reached and carries receiveIdType', () => {
    const instance = declared({ notifyChatId: 'oc_ops' });
    const lookup = new RepoNotifyTargetLookup({
      bindingRepo: { listByOrg: () => [] },
      instanceRepo: { findById: () => instance, listByOrg: () => [instance] },
      fieldDefs: () => DECLARED_FIELDS,
    });
    expect(resolveNotifyTarget('default', { agentId: 'agt_nobody' }, lookup)).toEqual({
      status: 'resolved',
      matchedScope: 'instance',
      target: {
        platform: 'feishu',
        instanceId: 'bi_f',
        nativeId: 'oc_ops',
        receiveIdType: 'chat_id',
        kind: 'notification',
      },
    });
  });

  it('end-to-end: a switched-off first bot no longer swallows the notification', () => {
    // The 2026-10-16 production shape, over the real lookup: two feishu instances
    // declare a destination, the first is switched off. The walk must skip it.
    const cto: InstanceRowLike = { id: 'bi_cto', platform: 'feishu', createdAt: '2026-01-01T00:00:00Z', config: { notifyChatId: 'oc_cto' } };
    const def: InstanceRowLike = { id: 'bi_default', platform: 'feishu', createdAt: '2026-01-02T00:00:00Z', config: { notifyChatId: 'oc_default' } };
    const lookup = new RepoNotifyTargetLookup({
      bindingRepo: { listByOrg: () => [] },
      instanceRepo: { findById: (id) => (id === 'bi_cto' ? cto : id === 'bi_default' ? def : undefined), listByOrg: () => [cto, def] },
      fieldDefs: () => DECLARED_FIELDS,
    });
    const prefs: Record<string, boolean | undefined> = { bi_cto: false, bi_default: true };
    const resolved = resolveNotifyTarget(
      'default',
      { agentId: 'agt_author' },
      lookup,
      (t) => (t.instanceId && prefs[t.instanceId] === false ? 'notify-disabled' : undefined),
    );
    expect(resolved).toMatchObject({ status: 'resolved', target: { instanceId: 'bi_default', nativeId: 'oc_default' } });
  });
});

/** Keeps the deps type honest for readers of this file. */
const _depsShape: keyof RepoNotifyTargetLookupDeps = 'bindingRepo';
void _depsShape;
