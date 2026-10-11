/**
 * Slice G4 — the OutboundDispatcher.
 *
 * This is the slice's acceptance surface:
 *   • an approval is delivered to **Telegram and Slack**, not only Feishu (D5);
 *   • a notification for an **unbound** agent still lands on the Secretary channel;
 *   • severity splits routing: `action_required` is pushed immediately, `info` may
 *     be digested without ever swallowing the urgent one.
 */
import { describe, it, expect, vi } from 'vitest';
import { OutboundDispatcher, type OutboundSink } from '../src/gateway/dispatcher.js';
import { verifyActionRef, type OutboundMessage } from '../src/gateway/outbound.js';
import type { NotifyTarget, NotifyTargetLookup } from '../src/gateway/notify-route.js';

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

describe('OutboundDispatcher.dispatch', () => {
  it('delivers an approval to a Telegram bot', async () => {
    const sink = recordingSink(() => ({ markdown: true }));
    const lookup: NotifyTargetLookup = {
      agentTarget: () => undefined,
      instanceTarget: () => TELEGRAM,
      globalTarget: () => SECRETARY,
    };
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
    const lookup: NotifyTargetLookup = {
      agentTarget: () => SLACK,
      instanceTarget: () => undefined,
      globalTarget: () => SECRETARY,
    };
    const dispatcher = new OutboundDispatcher({ lookup, sink });

    const outcome = await dispatcher.dispatch(APPROVAL);
    expect(outcome.delivered).toBe(true);
    expect(outcome.format).toBe('card');
    expect(sink.deliveries[0].target.platform).toBe('slack');
  });

  it('routes an unbound agent\u2019s notification to the Secretary channel', async () => {
    const sink = recordingSink(() => ({ cards: true }));
    const lookup: NotifyTargetLookup = {
      agentTarget: () => undefined,
      instanceTarget: () => undefined,
      globalTarget: () => SECRETARY,
    };
    const dispatcher = new OutboundDispatcher({ lookup, sink });

    const outcome = await dispatcher.dispatch({ ...APPROVAL, origin: { agentId: 'agt_nobody' } });
    expect(outcome.delivered).toBe(true);
    expect(outcome.scope).toBe('global');
    expect(sink.deliveries[0].target.nativeId).toBe('oc_owner');
  });

  it('reports failure loudly when no target exists at any level', async () => {
    const sink = recordingSink(() => ({}));
    const lookup: NotifyTargetLookup = {
      agentTarget: () => undefined,
      instanceTarget: () => undefined,
      globalTarget: () => undefined,
    };
    const dispatcher = new OutboundDispatcher({ lookup, sink });

    const outcome = await dispatcher.dispatch(APPROVAL);
    expect(outcome.delivered).toBe(false);
    expect(outcome.reason).toBe('no-notify-target');
    expect(sink.deliveries).toHaveLength(0);
  });

  it('does not report delivered when the sink fails', async () => {
    const sink: OutboundSink = {
      capabilities: () => ({}),
      send: async () => undefined,
    };
    const lookup: NotifyTargetLookup = {
      agentTarget: () => undefined,
      instanceTarget: () => undefined,
      globalTarget: () => SECRETARY,
    };
    const outcome = await new OutboundDispatcher({ lookup, sink }).dispatch(APPROVAL);
    expect(outcome.delivered).toBe(false);
  });
});

describe('OutboundDispatcher — severity split', () => {
  const lookup: NotifyTargetLookup = {
    agentTarget: () => undefined,
    instanceTarget: () => undefined,
    globalTarget: () => SECRETARY,
  };

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
    const lookup: NotifyTargetLookup = {
      agentTarget: () => undefined,
      instanceTarget: () => undefined,
      globalTarget: () => SECRETARY,
    };
    const dispatcher = new OutboundDispatcher({ lookup, sink });

    let handler: ((n: unknown) => void) | undefined;
    const detach = dispatcher.attachNotifications({
      onNotification: (cb) => {
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
      agentTarget: (_org, agentId) => (agentId === 'agt_ops' ? TELEGRAM : undefined),
      instanceTarget: () => undefined,
      globalTarget: () => SECRETARY,
    };
    const dispatcher = new OutboundDispatcher({ lookup, sink });

    let handler: ((n: unknown) => void) | undefined;
    dispatcher.attachNotifications({ onNotification: (cb) => { handler = cb as (n: unknown) => void; return () => {}; } });
    handler!({ type: 'approval_request', title: 'x', body: 'y', metadata: { approvalId: 'apr_1', agentId: 'agt_ops' } });

    await vi.waitFor(() => expect(sink.deliveries).toHaveLength(1));
    expect(sink.deliveries[0].target.platform).toBe('telegram');
  });

  it('signs approval refs when an action secret is configured', async () => {
    const sink = recordingSink(() => ({ markdown: true }));
    const lookup: NotifyTargetLookup = {
      agentTarget: () => undefined,
      instanceTarget: () => undefined,
      globalTarget: () => SECRETARY,
    };
    const dispatcher = new OutboundDispatcher({ lookup, sink, actionSecret: 'shh' });

    let handler: ((n: unknown) => void) | undefined;
    dispatcher.attachNotifications({ onNotification: (cb) => { handler = cb as (n: unknown) => void; return () => {}; } });
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
