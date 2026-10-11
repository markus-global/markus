import { describe, it, expect } from 'vitest';
import { RepoBindingLookup } from '../src/gateway/repo-binding-lookup.js';
import { resolveInboundTarget } from '../src/gateway/inbound.js';

interface BindingRow {
  scope: string;
  instanceId: string | null;
  nativeId: string | null;
  kind: string | null;
  agentId: string;
}

function makeLookup(opts: {
  bindings: BindingRow[];
  instances: Array<{ id: string; label: string }>;
  secretary?: string;
}): RepoBindingLookup {
  return new RepoBindingLookup({
    bindingRepo: { listByOrg: () => opts.bindings },
    instanceRepo: { listByPlatform: () => opts.instances },
    ...(opts.secretary ? { orgDefaultAgent: () => opts.secretary } : {}),
  });
}

describe('RepoBindingLookup — the DB-backed single writer', () => {
  it('realises the platform level as the platform default-instance binding', () => {
    const lookup = makeLookup({
      instances: [
        { id: 'bi_default', label: 'default' },
        { id: 'bi_sales', label: 'sales' },
      ],
      bindings: [
        { scope: 'instance', instanceId: 'bi_default', nativeId: null, kind: null, agentId: 'secretary' },
        { scope: 'global', instanceId: null, nativeId: null, kind: null, agentId: 'secretary' },
      ],
    });

    // The `sales` instance is unbound → level 4 → the default instance's agent.
    const target = resolveInboundTarget(
      { orgId: 'o', platform: 'feishu', nativeId: 'oc_x', instanceId: 'bi_sales' },
      lookup,
    );
    expect(target?.matchedScope).toBe('platform');
    expect(target?.agentId).toBe('secretary');
  });

  it('does not leak a binding from an instance belonging to another platform', () => {
    const lookup = makeLookup({
      instances: [{ id: 'bi_1', label: 'default' }],
      bindings: [
        { scope: 'instance', instanceId: 'bi_other_platform', nativeId: null, kind: null, agentId: 'wrong' },
      ],
    });
    // bi_other_platform is not an instance of this platform → its binding is invisible.
    const target = resolveInboundTarget(
      { orgId: 'o', platform: 'feishu', nativeId: 'oc_x', instanceId: 'bi_1' },
      lookup,
    );
    expect(target).toBeUndefined();
  });

  it('keeps global bindings platform-agnostic', () => {
    const lookup = makeLookup({
      instances: [],
      bindings: [{ scope: 'global', instanceId: null, nativeId: null, kind: null, agentId: 'secretary' }],
    });
    const target = resolveInboundTarget(
      { orgId: 'o', platform: 'telegram', nativeId: '123' },
      lookup,
    );
    expect(target?.agentId).toBe('secretary');
    expect(target?.matchedScope).toBe('global');
  });

  it('routes a channel binding of the right instance', () => {
    const lookup = makeLookup({
      instances: [{ id: 'bi_1', label: 'default' }],
      bindings: [
        { scope: 'instance', instanceId: 'bi_1', nativeId: null, kind: null, agentId: 'agent-instance' },
        { scope: 'channel', instanceId: 'bi_1', nativeId: 'oc_sales', kind: 'group', agentId: 'agent-sales' },
      ],
    });
    const target = resolveInboundTarget(
      { orgId: 'o', platform: 'feishu', nativeId: 'oc_sales', instanceId: 'bi_1' },
      lookup,
    );
    expect(target?.agentId).toBe('agent-sales');
    expect(target?.matchedScope).toBe('channel');
    expect(target?.conversationKey).toBe('im:bi_1:group:oc_sales');
  });
});
