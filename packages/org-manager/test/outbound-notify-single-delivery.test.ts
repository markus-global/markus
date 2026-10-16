/**
 * req_d25dc9b9 — one logical notification ⇒ exactly ONE IM message.
 *
 * The defect: `HITLService.notify({ targetUserId: 'all' })` fans out to **every
 * human user** (one persisted notification per person, by design — the in-app
 * bell is per-person). But the outbound dispatcher subscribed to that *same*
 * per-person broadcast stream and routes **by channel**, ignoring `targetUserId`
 * and without de-duplication. So one logical notification produced N group
 * messages (N = number of human users; 3 on this machine).
 *
 * The fix splits the two granularities **at the single source** (HITLService):
 *   • per-person stream  (`onNotification`)      → fires once per recipient (N).
 *   • channel stream      (`onChannelNotification`) → fires once per `notify()` call.
 *
 * This test wires the **real** dispatcher to the **real** HITLService and asserts
 * a single delivery. It is the teeth: on the pre-fix code the same wiring yields
 * one delivery *per human* (3), which is the reported bug.
 */
import { describe, it, expect, vi } from 'vitest';
import { HITLService } from '../src/hitl-service.js';
import { OutboundDispatcher } from '../../comms/src/gateway/dispatcher.js';
import type { NotifyTarget, NotifyTargetLookup } from '../../comms/src/gateway/notify-route.js';
import type { OutboundSink } from '../../comms/src/gateway/dispatcher.js';

const SECRETARY: NotifyTarget = { platform: 'feishu', instanceId: 'bi_secretary', nativeId: 'oc_owner' };

function lookupOf(): NotifyTargetLookup {
  return { candidates: () => [{ target: SECRETARY, scope: 'global' }] };
}

function recordingSink(): OutboundSink & { deliveries: Array<{ target: NotifyTarget; text: string }> } {
  const deliveries: Array<{ target: NotifyTarget; text: string }> = [];
  return {
    deliveries,
    capabilities: () => ({ markdown: true }),
    send: async (target, rendered) => {
      deliveries.push({ target, text: rendered.text });
      return `native_${deliveries.length}`;
    },
  };
}

function serviceWithHumans(ids: string[]): HITLService {
  const service = new HITLService();
  service.setOrgService({ listHumanUsers: () => ids.map((id) => ({ id, name: id })) } as never);
  return service;
}

describe('req_d25dc9b9 — one logical notification ⇒ one outbound delivery', () => {
  it('sends exactly ONE IM message for `targetUserId:"all"` even with 3 human users', async () => {
    const service = serviceWithHumans(['u1', 'u2', 'u3']);
    const sink = recordingSink();
    const dispatcher = new OutboundDispatcher({ lookup: lookupOf(), sink });

    dispatcher.attachNotifications(service);
    service.notify({ targetUserId: 'all', type: 'system', title: '部署完成', body: '详情', priority: 'normal' });

    await vi.waitFor(() => expect(sink.deliveries.length).toBeGreaterThan(0));
    // The whole point: human count MUST NOT multiply channel messages.
    expect(sink.deliveries).toHaveLength(1);
  });

  it('scales to any human count — 6 users still yield 1 message', async () => {
    const service = serviceWithHumans(['u1', 'u2', 'u3', 'u4', 'u5', 'u6']);
    const sink = recordingSink();
    const dispatcher = new OutboundDispatcher({ lookup: lookupOf(), sink });

    dispatcher.attachNotifications(service);
    service.notify({ targetUserId: 'all', type: 'task_review', title: '待审阅', body: 'x' });

    await vi.waitFor(() => expect(sink.deliveries.length).toBeGreaterThan(0));
    expect(sink.deliveries).toHaveLength(1);
  });

  it('still delivers a single-target notification exactly once', async () => {
    const service = serviceWithHumans(['u1', 'u2', 'u3']);
    const sink = recordingSink();
    const dispatcher = new OutboundDispatcher({ lookup: lookupOf(), sink });

    dispatcher.attachNotifications(service);
    service.notify({ targetUserId: 'u2', type: 'system', title: '私信', body: 'x' });

    await vi.waitFor(() => expect(sink.deliveries.length).toBeGreaterThan(0));
    expect(sink.deliveries).toHaveLength(1);
  });
});
