/**
 * The notification-destination walk (design §3).
 *
 * Two failure modes are defended against here:
 *
 *   • (R1, 2026-10-11) the walk used to promise a terminus at "level 3" that does
 *     not exist on a migrated install, so every message was dropped. The chain must
 *     therefore hit a **declared**, binding-independent destination early, and when
 *     it truly finds nothing return an explicit `undelivered` — never a silent
 *     `undefined`.
 *
 *   • (2026-10-16) the walk used to stop at the first candidate **whatever its
 *     state**, and a later step then killed the message if that candidate's
 *     notifications were switched off. One switched-off bot therefore swallowed
 *     every notification for the whole org even though other bots could deliver.
 *     Eligibility is now part of the walk: an ineligible candidate is skipped and
 *     the walk continues.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveNotifyTarget,
  type NotifyCandidate,
  type NotifyTarget,
  type NotifyTargetLookup,
} from '../src/gateway/notify-route.js';

const GLOBAL: NotifyTarget = { platform: 'feishu', instanceId: 'bi_secretary', nativeId: 'oc_owner' };

/**
 * A lookup standing in for the candidate enumeration: each slot is one candidate,
 * in priority order, exactly as `RepoNotifyTargetLookup` would emit them.
 */
function lookupOf(slots: Partial<Record<'agent' | 'declared' | 'viaAgent' | 'global', NotifyTarget>> = {}): NotifyTargetLookup {
  const candidates: NotifyCandidate[] = [];
  if (slots.agent) candidates.push({ target: slots.agent, scope: 'agent' });
  if (slots.declared) candidates.push({ target: slots.declared, scope: 'instance' });
  if (slots.viaAgent) candidates.push({ target: slots.viaAgent, scope: 'instance' });
  if (slots.global) candidates.push({ target: slots.global, scope: 'global' });
  return { candidates: () => candidates };
}

describe('resolveNotifyTarget — first *eligible* hit wins', () => {
  it('prefers the agent-level target when the agent has its own sink', () => {
    const agent: NotifyTarget = { platform: 'telegram', instanceId: 'bi_sales', nativeId: '111' };
    const resolved = resolveNotifyTarget('default', { agentId: 'agt_sales' }, lookupOf({
      agent,
      declared: { platform: 'slack', instanceId: 'bi_ops', nativeId: 'C1' },
    }));
    expect(resolved).toMatchObject({ status: 'resolved', target: agent, matchedScope: 'agent' });
  });

  it('hits the instance-declared destination (step 2) before the notify-agent fallback', () => {
    const declared: NotifyTarget = {
      platform: 'feishu', instanceId: 'bi_feishu', nativeId: 'oc_declared', receiveIdType: 'chat_id',
    };
    const resolved = resolveNotifyTarget('default', { agentId: 'agt_ops' }, lookupOf({
      declared,
      viaAgent: { platform: 'feishu', instanceId: 'bi_feishu', nativeId: 'oc_agent' },
    }));
    expect(resolved).toMatchObject({ status: 'resolved', target: declared, matchedScope: 'instance' });
  });

  it('falls to the notify-agent level (step 3) when no destination is declared', () => {
    const viaAgent: NotifyTarget = { platform: 'slack', instanceId: 'bi_ops', nativeId: 'C1' };
    const resolved = resolveNotifyTarget('default', { agentId: 'agt_ops' }, lookupOf({ viaAgent }));
    expect(resolved).toEqual({ status: 'resolved', target: viaAgent, matchedScope: 'instance' });
  });

  it('falls to the global default when neither agent nor instance has a sink', () => {
    const resolved = resolveNotifyTarget('default', { agentId: 'agt_unbound' }, lookupOf({ global: GLOBAL }));
    expect(resolved).toEqual({ status: 'resolved', target: GLOBAL, matchedScope: 'global' });
  });

  it('still reaches the global default when the origin has no agent at all', () => {
    const resolved = resolveNotifyTarget('default', {}, lookupOf({ global: GLOBAL }));
    expect(resolved).toEqual({ status: 'resolved', target: GLOBAL, matchedScope: 'global' });
  });

  it('lets a no-agent origin land on a declared destination before the global default', () => {
    const declared: NotifyTarget = { platform: 'feishu', instanceId: 'bi_feishu', nativeId: 'oc_d' };
    const resolved = resolveNotifyTarget('default', {}, lookupOf({ declared }));
    expect(resolved).toEqual({ status: 'resolved', target: declared, matchedScope: 'instance' });
  });

  it('returns an explicit undelivered result when the whole walk finds nothing', () => {
    const resolved = resolveNotifyTarget('default', { agentId: 'a' }, lookupOf());
    expect(resolved).toEqual({ status: 'undelivered', reason: 'no-notify-target' });
  });

  it('returns undelivered — not a silent undefined — on a fresh install with no bindings', () => {
    const resolved = resolveNotifyTarget('default', { agentId: 'agt_nobody' }, lookupOf());
    expect(resolved.status).toBe('undelivered');
  });
});

describe('resolveNotifyTarget — eligibility is a filter, never a dead end (2026-10-16)', () => {
  const OFF: NotifyTarget = { platform: 'feishu', instanceId: 'bi_cto', nativeId: 'oc_cto' };
  const ON: NotifyTarget = { platform: 'feishu', instanceId: 'bi_default', nativeId: 'oc_default' };

  it('skips an ineligible candidate and delivers through the next one', () => {
    // The exact production shape: two feishu bots declare a destination, the first
    // one has notifications switched off. It must not swallow the message.
    const resolved = resolveNotifyTarget(
      'default',
      { agentId: 'agt_ops' },
      lookupOf({ declared: OFF, viaAgent: ON }),
      (t) => (t.instanceId === 'bi_cto' ? 'notify-disabled' : undefined),
    );
    expect(resolved).toEqual({ status: 'resolved', target: ON, matchedScope: 'instance' });
  });

  it('does not fall through to a lower level when the top one is eligible', () => {
    let consulted = 0;
    const resolved = resolveNotifyTarget(
      'default',
      { agentId: 'agt_ops' },
      lookupOf({ agent: ON, global: GLOBAL }),
      () => { consulted += 1; return undefined; },
    );
    expect(resolved).toMatchObject({ status: 'resolved', target: ON, matchedScope: 'agent' });
    expect(consulted).toBe(1);
  });

  it('reports `suppressed` with EVERY skipped candidate when none is eligible', () => {
    // Deliberately switched off is not the same as nowhere to send: the result has
    // to carry the candidates, or a mis-route reads like an intentional setting.
    const resolved = resolveNotifyTarget(
      'default',
      { agentId: 'agt_ops' },
      lookupOf({ declared: OFF, global: GLOBAL }),
      () => 'notify-disabled',
    );
    expect(resolved).toMatchObject({
      status: 'suppressed',
      reason: 'notify-disabled',
    });
    if (resolved.status !== 'suppressed') throw new Error('expected suppressed');
    expect(resolved.skipped.map((s) => s.target.instanceId)).toEqual(['bi_cto', 'bi_secretary']);
    expect(resolved.skipped.every((s) => s.reason === 'notify-disabled')).toBe(true);
  });

  it('stays `undelivered` — not `suppressed` — when there were no candidates at all', () => {
    const resolved = resolveNotifyTarget('default', { agentId: 'a' }, lookupOf(), () => 'notify-disabled');
    expect(resolved.status).toBe('undelivered');
  });

  it('reports the destinations it did not need, so a multi-bot choice is visible', () => {
    const resolved = resolveNotifyTarget(
      'default',
      { agentId: 'agt_ops' },
      lookupOf({ declared: ON, global: GLOBAL }),
    );
    expect(resolved.status).toBe('resolved');
    if (resolved.status !== 'resolved') throw new Error('expected resolved');
    expect(resolved.alternatives?.map((c) => c.target.nativeId)).toEqual(['oc_owner']);
    expect(resolved.alternatives?.[0].scope).toBe('global');
  });
});
