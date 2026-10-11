/**
 * Slice G4 — notification routing, three levels, the last one always wins.
 *
 * The failure mode we are defending against (design §7.1): a user binds only a
 * handful of important agents, so "deliver to the agent's bound channel" would
 * leak every unbound agent's notifications. The chain must therefore terminate at
 * the org-wide Default (the Secretary), and the level that matched is recorded so
 * the choice is observable rather than guessed.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveNotifyTarget,
  type NotifyTarget,
  type NotifyTargetLookup,
} from '../src/gateway/notify-route.js';

const GLOBAL: NotifyTarget = { platform: 'feishu', instanceId: 'bi_secretary', nativeId: 'oc_owner' };

function lookupOf(overrides: Partial<NotifyTargetLookup> = {}): NotifyTargetLookup {
  return {
    agentTarget: () => undefined,
    instanceTarget: () => undefined,
    globalTarget: () => GLOBAL,
    ...overrides,
  };
}

describe('resolveNotifyTarget — first hit wins', () => {
  it('prefers the agent-level target when the agent has its own sink', () => {
    const agent: NotifyTarget = { platform: 'telegram', instanceId: 'bi_sales', nativeId: '111' };
    const resolved = resolveNotifyTarget('default', { agentId: 'agt_sales' }, lookupOf({
      agentTarget: () => agent,
      instanceTarget: () => ({ platform: 'slack', instanceId: 'bi_ops', nativeId: 'C1' }),
    }));
    expect(resolved).toEqual({ target: agent, matchedScope: 'agent' });
  });

  it('falls to the instance target when the agent has no sink of its own', () => {
    const instance: NotifyTarget = { platform: 'slack', instanceId: 'bi_ops', nativeId: 'C1' };
    const resolved = resolveNotifyTarget('default', { agentId: 'agt_ops' }, lookupOf({
      instanceTarget: () => instance,
    }));
    expect(resolved).toEqual({ target: instance, matchedScope: 'instance' });
  });

  it('falls to the global default when neither agent nor instance has a sink', () => {
    const resolved = resolveNotifyTarget('default', { agentId: 'agt_unbound' }, lookupOf());
    expect(resolved).toEqual({ target: GLOBAL, matchedScope: 'global' });
  });

  it('still reaches the global default when the origin has no agent at all', () => {
    const resolved = resolveNotifyTarget('default', {}, lookupOf());
    expect(resolved).toEqual({ target: GLOBAL, matchedScope: 'global' });
  });

  it('returns undefined only when even the global level is missing', () => {
    const resolved = resolveNotifyTarget('default', { agentId: 'a' }, lookupOf({
      globalTarget: () => undefined,
    }));
    expect(resolved).toBeUndefined();
  });

  it('does not consult the agent level when there is no agent', () => {
    let called = 0;
    resolveNotifyTarget('default', {}, lookupOf({ agentTarget: () => { called++; return undefined; } }));
    expect(called).toBe(0);
  });
});
