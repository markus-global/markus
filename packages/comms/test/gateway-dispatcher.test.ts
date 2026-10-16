/**
 * The OutboundDispatcher.
 *
 * This is the slice's acceptance surface:
 *   • an approval is delivered to **Telegram and Slack**, not only Feishu (D5);
 *   • a notification for an **unbound** agent still lands on the Secretary channel;
 *   • a message with no destination at all is reported as an explicit
 *     **undelivered** state — never a silent drop (R1);
 *   • severity splits routing: `action_required` is pushed immediately, `info` may
 *     be digested without ever swallowing the urgent one.
 */
import { describe, it, expect, vi } from 'vitest';
import { OutboundDispatcher, type OutboundSink } from '../src/gateway/dispatcher.js';
import { verifyActionRef, type OutboundMessage } from '../src/gateway/outbound.js';
import type { NotifyCandidate, NotifyTarget, NotifyTargetLookup } from '../src/gateway/notify-route.js';
import type { NotifyPreferences, NotifyPreferenceSource } from '../src/gateway/notify-prefs.js';

interface Delivery {
  target: NotifyTarget;
  format: string;
  text: string;
}

function recordingSink(capsOf: (t: NotifyTarget) => Record<string, boolean>): OutboundSink & { deliveries: Delivery[] } {
  const deliveries: Delivery[] = [];
  return {
    deliveries,
    capabilities: (t) => capsOf(t),
    send: async (t, rendered) => {
      deliveries.push({ target: t, format: rendered.format, text: rendered.text });
      return `native_${deliveries.length}`;
    },
  };
}

interface CardDelivery {
  target: NotifyTarget;
  format: string;
  body: string;
  origin?: { agentName?: string; teamName?: string };
}

/** A sink whose target can render cards, recording the structured body + origin. */
function recordingCardSink(): OutboundSink & { deliveries: CardDelivery[] } {
  const deliveries: CardDelivery[] = [];
  return {
    deliveries,
    capabilities: () => ({ cards: true, markdown: true }),
    send: async (t, rendered) => {
      deliveries.push({ target: t, format: rendered.format, body: rendered.body, origin: rendered.origin });
      return `native_${deliveries.length}`;
    },
  };
}

/**
 * A lookup with nothing reachable — the walk falls to whatever each test declares.
 * Each slot is one candidate, in the priority order the production lookup emits.
 */
function lookupOf(slots: {
  agent?: NotifyTarget;
  declared?: NotifyTarget;
  viaAgent?: NotifyTarget;
  global?: NotifyTarget;
} = {}): NotifyTargetLookup {
  const candidates: NotifyCandidate[] = [];
  if (slots.agent) candidates.push({ target: slots.agent, scope: 'agent' });
  if (slots.declared) candidates.push({ target: slots.declared, scope: 'instance' });
  if (slots.viaAgent) candidates.push({ target: slots.viaAgent, scope: 'instance' });
  if (slots.global) candidates.push({ target: slots.global, scope: 'global' });
  return { candidates: () => candidates };
}

/** A preference source that returns the same preferences for every target. */
function prefsOf(prefs: NotifyPreferences | undefined): NotifyPreferenceSource {
  return { preferencesFor: () => prefs };
}

const TELEGRAM: NotifyTarget = { platform: 'telegram', instanceId: 'bi_sales', nativeId: '111' };
const SLACK: NotifyTarget = { platform: 'slack', instanceId: 'bi_ops', nativeId: 'C1' };
const SECRETARY: NotifyTarget = { platform: 'feishu', instanceId: 'bi_secretary', nativeId: 'oc_owner' };

const APPROVAL: OutboundMessage = {
  title: '审批',
  body: '部署请求',
  severity: 'action_required',
  actions: [{ id: 'approve', label: '批准', ref: 'r1' }],
  origin: { agentId: 'agt_ops' },
};

describe('OutboundDispatcher — agent attribution', () => {
  it('labels the delivered message with the originating agent’s name', async () => {
    const sink = recordingSink(() => ({ markdown: true }));
    const lookup = lookupOf({ global: SECRETARY });
    const dispatcher = new OutboundDispatcher({
      lookup,
      sink,
      agentName: (id) => (id === 'agt_ops' ? '运营助手' : undefined),
    });

    await dispatcher.dispatch(APPROVAL);
    expect(sink.deliveries[0].text).toContain('来自：运营助手');
    expect(sink.deliveries[0].text).toContain('部署请求');
  });

  it('carries the team name in the attribution when the agent belongs to one', async () => {
    const sink = recordingSink(() => ({ markdown: true }));
    const lookup = lookupOf({ global: SECRETARY });
    const dispatcher = new OutboundDispatcher({
      lookup,
      sink,
      agentName: () => '运营助手',
      agentTeamName: () => '平台开发组',
    });

    await dispatcher.dispatch(APPROVAL);
    expect(sink.deliveries[0].text).toContain('来自：运营助手');
    expect(sink.deliveries[0].text).toContain('团队：平台开发组');
  });

  it('shows the agent without a team suffix when the agent has no team', async () => {
    const sink = recordingSink(() => ({ markdown: true }));
    const lookup = lookupOf({ global: SECRETARY });
    const dispatcher = new OutboundDispatcher({
      lookup,
      sink,
      agentName: () => '运营助手',
      agentTeamName: () => undefined,
    });

    await dispatcher.dispatch(APPROVAL);
    expect(sink.deliveries[0].text).toContain('来自：运营助手');
    expect(sink.deliveries[0].text).not.toContain('团队');
  });

  it('emits a plain-text attribution line — no markdown emphasis leaks into text platforms', async () => {
    const sink = recordingSink(() => ({}));
    const lookup = lookupOf({ global: SECRETARY });
    const dispatcher = new OutboundDispatcher({ lookup, sink, agentName: () => '运营助手' });

    await dispatcher.dispatch(APPROVAL);
    // A plain-text platform renders the line verbatim: the `**` of the old
    // in-band markdown prefix would have shown up literally here.
    expect(sink.deliveries[0].text).not.toContain('**');
    expect(sink.deliveries[0].text.split('\n')[0]).toBe('来自：运营助手');
  });

  it('delivers unattributed when the name is unknown — attribution never blocks', async () => {
    const sink = recordingSink(() => ({ markdown: true }));
    const lookup = lookupOf({ global: SECRETARY });
    const dispatcher = new OutboundDispatcher({ lookup, sink, agentName: () => undefined });

    const outcome = await dispatcher.dispatch(APPROVAL);
    expect(outcome.delivered).toBe(true);
    expect(sink.deliveries[0].text).not.toContain('来自');
  });

  it('surfaces the origin as structure so a card can place it, not only inline in text', async () => {
    const cardSink = recordingCardSink();
    const lookup = lookupOf({ global: SECRETARY });
    const dispatcher = new OutboundDispatcher({
      lookup,
      sink: cardSink,
      agentName: () => '运营助手',
      agentTeamName: () => '平台开发组',
    });

    await dispatcher.dispatch(APPROVAL);
    // Card body stays clean (no duplicated attribution inside the body)…
    expect(cardSink.deliveries[0].body).toBe('部署请求');
    // …while the origin travels as a field for the card's own dialect to render.
    expect(cardSink.deliveries[0].origin).toMatchObject({
      agentName: '运营助手',
      teamName: '平台开发组',
    });
  });
});

describe('OutboundDispatcher.dispatch', () => {
  it('delivers an approval to a Telegram bot', async () => {
    const sink = recordingSink(() => ({ markdown: true }));
    const lookup = lookupOf({ viaAgent: TELEGRAM, global: SECRETARY });
    const dispatcher = new OutboundDispatcher({ lookup, sink });

    const outcome = await dispatcher.dispatch(APPROVAL);
    expect(outcome.delivered).toBe(true);
    expect(outcome.scope).toBe('instance');
    expect(outcome.format).toBe('markdown');
    expect(sink.deliveries).toHaveLength(1);
    expect(sink.deliveries[0].target.platform).toBe('telegram');
  });

  it('delivers the same approval to a Slack bot', async () => {
    const sink = recordingSink(() => ({ cards: true }));
    const lookup = lookupOf({ agent: SLACK, global: SECRETARY });
    const dispatcher = new OutboundDispatcher({ lookup, sink });

    const outcome = await dispatcher.dispatch(APPROVAL);
    expect(outcome.delivered).toBe(true);
    expect(outcome.format).toBe('card');
    expect(sink.deliveries[0].target.platform).toBe('slack');
  });

  it('routes an unbound agent\u2019s notification to the Secretary channel', async () => {
    const sink = recordingSink(() => ({ cards: true }));
    const lookup = lookupOf({ global: SECRETARY });
    const dispatcher = new OutboundDispatcher({ lookup, sink });

    const outcome = await dispatcher.dispatch({ ...APPROVAL, origin: { agentId: 'agt_nobody' } });
    expect(outcome.delivered).toBe(true);
    expect(outcome.scope).toBe('global');
    expect(sink.deliveries[0].target.nativeId).toBe('oc_owner');
  });

  it('reports an explicit undelivered state when no target exists at any level', async () => {
    const sink = recordingSink(() => ({}));
    const dispatcher = new OutboundDispatcher({ lookup: lookupOf(), sink });

    const outcome = await dispatcher.dispatch(APPROVAL);
    expect(outcome.delivered).toBe(false);
    expect(outcome.undelivered).toBe(true);
    expect(outcome.reason).toBe('no-notify-target');
    expect(sink.deliveries).toHaveLength(0);
  });

  it('exposes the same walk as a read-only resolve() (for a Settings reachability state)', () => {
    const dispatcher = new OutboundDispatcher({ lookup: lookupOf({ global: SECRETARY }), sink: recordingSink(() => ({})) });
    expect(dispatcher.resolve({ agentId: 'agt_x' })).toEqual({
      status: 'resolved',
      target: SECRETARY,
      matchedScope: 'global',
    });
    const bare = new OutboundDispatcher({ lookup: lookupOf(), sink: recordingSink(() => ({})) });
    expect(bare.resolve({})).toEqual({ status: 'undelivered', reason: 'no-notify-target' });
  });

  it('does not report delivered when the sink fails', async () => {
    const sink: OutboundSink = {
      capabilities: () => ({}),
      send: async () => undefined,
    };
    const lookup = lookupOf({ global: SECRETARY });
    const outcome = await new OutboundDispatcher({ lookup, sink }).dispatch(APPROVAL);
    expect(outcome.delivered).toBe(false);
    expect(outcome.undelivered).toBeUndefined();
  });
});

describe('OutboundDispatcher — severity split', () => {
  const lookup = lookupOf({ global: SECRETARY });

  it('pushes action_required immediately even when digesting info', async () => {
    const sink = recordingSink(() => ({ markdown: true }));
    const dispatcher = new OutboundDispatcher({ lookup, sink, digestInfo: true });

    const outcome = await dispatcher.dispatch(APPROVAL);
    expect(outcome.delivered).toBe(true);
    expect(outcome.digested).toBeUndefined();
  });

  it('buffers info when digesting, and flushes one summary', async () => {
    const sink = recordingSink(() => ({ markdown: true }));
    const dispatcher = new OutboundDispatcher({ lookup, sink, digestInfo: true });

    const first = await dispatcher.dispatch({ title: 'a', body: '1', severity: 'info' });
    const second = await dispatcher.dispatch({ title: 'b', body: '2', severity: 'info' });
    expect(first.digested).toBe(true);
    expect(second.digested).toBe(true);
    expect(sink.deliveries).toHaveLength(0);
    expect(dispatcher.pendingDigestCount()).toBe(2);

    const flushed = await dispatcher.flushDigest();
    expect(flushed?.delivered).toBe(true);
    expect(sink.deliveries).toHaveLength(1);
    expect(sink.deliveries[0].text).toContain('a');
    expect(sink.deliveries[0].text).toContain('b');
    expect(dispatcher.pendingDigestCount()).toBe(0);
  });

  it('flags an undelivered info message instead of buffering it', async () => {
    const sink = recordingSink(() => ({ markdown: true }));
    const dispatcher = new OutboundDispatcher({ lookup: lookupOf(), sink, digestInfo: true });
    const outcome = await dispatcher.dispatch({ title: 'a', body: '1', severity: 'info' });
    expect(outcome.undelivered).toBe(true);
    expect(dispatcher.pendingDigestCount()).toBe(0);
    expect(sink.deliveries).toHaveLength(0);
  });

  it('flushes pending info before an urgent message so nothing is reordered', async () => {
    const sink = recordingSink(() => ({ markdown: true }));
    const dispatcher = new OutboundDispatcher({ lookup, sink, digestInfo: true });

    await dispatcher.dispatch({ title: 'background', body: 'x', severity: 'info' });
    await dispatcher.dispatch(APPROVAL);

    expect(sink.deliveries).toHaveLength(2);
    expect(sink.deliveries[0].text).toContain('background');
    expect(sink.deliveries[1].text).toContain('审批');
    expect(dispatcher.pendingDigestCount()).toBe(0);
  });

  it('sends info immediately when digesting is off (default)', async () => {
    const sink = recordingSink(() => ({ markdown: true }));
    const dispatcher = new OutboundDispatcher({ lookup, sink });
    const outcome = await dispatcher.dispatch({ title: 'a', body: '1', severity: 'info' });
    expect(outcome.delivered).toBe(true);
    expect(sink.deliveries).toHaveLength(1);
  });
});

describe('OutboundDispatcher — notification source', () => {
  it('converts and dispatches a HITL notification via attachNotifications', async () => {
    const sink = recordingSink(() => ({ markdown: true }));
    const lookup = lookupOf({ global: SECRETARY });
    const dispatcher = new OutboundDispatcher({ lookup, sink });

    let handler: ((n: unknown) => void) | undefined;
    const detach = dispatcher.attachNotifications({
      onChannelNotification: (cb) => {
        handler = cb as (n: unknown) => void;
        return () => { handler = undefined; };
      },
    });
    expect(typeof handler).toBe('function');

    handler!({ type: 'approval_request', title: '需要你批准', body: '部署', priority: 'high', metadata: { approvalId: 'apr_9' } });
    await vi.waitFor(() => expect(sink.deliveries).toHaveLength(1));
    expect(sink.deliveries[0].text).toContain('需要你批准');

    detach();
    expect(handler).toBeUndefined();
  });

  it('routes an approval to the producing agent when the notification names it', async () => {
    const sink = recordingSink(() => ({ markdown: true }));
    const lookup: NotifyTargetLookup = {
      candidates: (_org, origin) =>
        origin.agentId === 'agt_ops'
          ? [{ target: TELEGRAM, scope: 'agent' as const }]
          : [{ target: SECRETARY, scope: 'global' as const }],
    };
    const dispatcher = new OutboundDispatcher({ lookup, sink });

    let handler: ((n: unknown) => void) | undefined;
    dispatcher.attachNotifications({ onChannelNotification: (cb) => { handler = cb as (n: unknown) => void; return () => {}; } });
    handler!({ type: 'approval_request', title: 'x', body: 'y', metadata: { approvalId: 'apr_1', agentId: 'agt_ops' } });

    await vi.waitFor(() => expect(sink.deliveries).toHaveLength(1));
    expect(sink.deliveries[0].target.platform).toBe('telegram');
  });

  it('signs approval refs when an action secret is configured', async () => {
    const sink = recordingSink(() => ({ markdown: true }));
    const lookup = lookupOf({ global: SECRETARY });
    const dispatcher = new OutboundDispatcher({ lookup, sink, actionSecret: 'shh' });

    let handler: ((n: unknown) => void) | undefined;
    dispatcher.attachNotifications({ onChannelNotification: (cb) => { handler = cb as (n: unknown) => void; return () => {}; } });
    handler!({
      type: 'approval_request',
      title: 'x',
      body: 'y',
      metadata: { approvalId: 'apr_secret', options: [{ id: 'deploy', label: '部署' }] },
    });

    await vi.waitFor(() => expect(sink.deliveries).toHaveLength(1));
    const text = sink.deliveries[0].text;
    expect(text).toContain('部署');
    expect(text).not.toContain('apr_secret');
    const ref = text.split('[部署] ')[1]?.trim();
    expect(verifyActionRef(ref!, 'shh')).toEqual({ approvalId: 'apr_secret', action: 'deploy' });
  });
});

describe('OutboundDispatcher — notification-preference enforcement (R6)', () => {
  const lookup = lookupOf({ global: SECRETARY });
  const INFO: OutboundMessage = { title: 'done', body: 'x', severity: 'info', priority: 'high' };

  it('suppresses an approval when notifyOnApproval is off — and reports it, not a silent drop', async () => {
    const sink = recordingSink(() => ({ markdown: true }));
    const dispatcher = new OutboundDispatcher({ lookup, sink, preferences: prefsOf({ notifyOnApproval: false }) });

    const outcome = await dispatcher.dispatch(APPROVAL);
    expect(outcome.delivered).toBe(false);
    expect(outcome.suppressed).toBe(true);
    expect(outcome.reason).toBe('notify-off-approval');
    expect(sink.deliveries).toHaveLength(0);
  });

  it('delivers an approval by default (notifyOnApproval defaults to on)', async () => {
    const sink = recordingSink(() => ({ markdown: true }));
    const dispatcher = new OutboundDispatcher({ lookup, sink, preferences: prefsOf({}) });
    expect((await dispatcher.dispatch(APPROVAL)).delivered).toBe(true);
    expect(sink.deliveries).toHaveLength(1);
  });

  it('suppresses an event when notifyOnNotification is off (the default)', async () => {
    const sink = recordingSink(() => ({ markdown: true }));
    const dispatcher = new OutboundDispatcher({ lookup, sink, preferences: prefsOf({ notifyOnNotification: false }) });

    const outcome = await dispatcher.dispatch(INFO);
    expect(outcome.delivered).toBe(false);
    expect(outcome.suppressed).toBe(true);
    expect(outcome.reason).toBe('notify-off-notification');
    expect(sink.deliveries).toHaveLength(0);
  });

  it('delivers an event when notifyOnNotification is on and its priority is allowed', async () => {
    const sink = recordingSink(() => ({ markdown: true }));
    const dispatcher = new OutboundDispatcher({
      lookup,
      sink,
      preferences: prefsOf({ notifyOnNotification: true, notifyPriority: 'high,urgent' }),
    });
    expect((await dispatcher.dispatch(INFO)).delivered).toBe(true);
    expect(sink.deliveries).toHaveLength(1);
  });

  it('filters an event below the notifyPriority threshold', async () => {
    const sink = recordingSink(() => ({ markdown: true }));
    const dispatcher = new OutboundDispatcher({
      lookup,
      sink,
      preferences: prefsOf({ notifyOnNotification: true, notifyPriority: ['high', 'urgent'] }),
    });

    const outcome = await dispatcher.dispatch({ ...INFO, priority: 'low' });
    expect(outcome.delivered).toBe(false);
    expect(outcome.suppressed).toBe(true);
    expect(outcome.reason).toBe('priority-filtered');
    expect(sink.deliveries).toHaveLength(0);
  });

  it('does not buffer a suppressed event for the digest', async () => {
    const sink = recordingSink(() => ({ markdown: true }));
    const dispatcher = new OutboundDispatcher({
      lookup,
      sink,
      digestInfo: true,
      preferences: prefsOf({ notifyOnNotification: false }),
    });

    const outcome = await dispatcher.dispatch({ title: 'a', body: '1', severity: 'info' });
    expect(outcome.suppressed).toBe(true);
    expect(dispatcher.pendingDigestCount()).toBe(0);
    expect(sink.deliveries).toHaveLength(0);
  });

  it('does not filter when no preference source is wired (back-compat)', async () => {
    const sink = recordingSink(() => ({ markdown: true }));
    const dispatcher = new OutboundDispatcher({ lookup, sink });
    expect((await dispatcher.dispatch(APPROVAL)).delivered).toBe(true);
    expect((await dispatcher.dispatch({ title: 'a', body: '1', severity: 'info' })).delivered).toBe(true);
    expect(sink.deliveries).toHaveLength(2);
  });
});

describe('OutboundDispatcher — a switched-off bot never swallows the message (2026-10-16)', () => {
  const OFF: NotifyTarget = { platform: 'feishu', instanceId: 'bi_cto', nativeId: 'oc_cto' };
  const ON: NotifyTarget = { platform: 'feishu', instanceId: 'bi_default', nativeId: 'oc_default' };

  /** Preferences keyed by bot — the real source reads each candidate's own instance. */
  function prefsByInstance(map: Record<string, NotifyPreferences>): NotifyPreferenceSource {
    return { preferencesFor: (t) => (t.instanceId ? map[t.instanceId] : undefined) };
  }

  it('delivers through the next bot when the first one has notifications off', async () => {
    const sink = recordingSink(() => ({ markdown: true }));
    const dispatcher = new OutboundDispatcher({
      lookup: lookupOf({ declared: OFF, viaAgent: ON }),
      sink,
      preferences: prefsByInstance({ bi_cto: { notifyEnabled: false }, bi_default: {} }),
    });

    const outcome = await dispatcher.dispatch(APPROVAL);
    expect(outcome.delivered).toBe(true);
    expect(outcome.target?.instanceId).toBe('bi_default');
    expect(sink.deliveries).toHaveLength(1);
  });

  it('reports `suppressed` carrying every candidate when all of them are off', async () => {
    const sink = recordingSink(() => ({ markdown: true }));
    const dispatcher = new OutboundDispatcher({
      lookup: lookupOf({ declared: OFF, global: ON }),
      sink,
      preferences: prefsByInstance({ bi_cto: { notifyEnabled: false }, bi_default: { notifyEnabled: false } }),
    });

    const outcome = await dispatcher.dispatch(APPROVAL);
    expect(outcome.delivered).toBe(false);
    expect(outcome.suppressed).toBe(true);
    expect(outcome.reason).toBe('notify-disabled');
    expect(outcome.skipped?.map((s) => s.target.instanceId)).toEqual(['bi_cto', 'bi_default']);
    expect(sink.deliveries).toHaveLength(0);
  });

  it('flushes one summary per destination when items resolved to different bots', async () => {
    const sink = recordingSink(() => ({ markdown: true }));
    const A: NotifyTarget = { platform: 'telegram', instanceId: 'bi_a', nativeId: '1' };
    const B: NotifyTarget = { platform: 'slack', instanceId: 'bi_b', nativeId: 'C1' };
    const lookup: NotifyTargetLookup = {
      candidates: (_org, origin) => [{ target: origin.agentId === 'agt_b' ? B : A, scope: 'instance' }],
    };
    const dispatcher = new OutboundDispatcher({ lookup, sink, digestInfo: true });

    await dispatcher.dispatch({ title: 'a', body: '1', severity: 'info', origin: { agentId: 'agt_a' } });
    await dispatcher.dispatch({ title: 'b', body: '2', severity: 'info', origin: { agentId: 'agt_b' } });
    expect(dispatcher.pendingDigestCount()).toBe(2);

    await dispatcher.flushDigest();
    expect(sink.deliveries).toHaveLength(2);
    expect(sink.deliveries.map((d) => d.target.instanceId).sort()).toEqual(['bi_a', 'bi_b']);
  });
});
