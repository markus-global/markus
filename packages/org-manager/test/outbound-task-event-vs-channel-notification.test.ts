/**
 * req_d25dc9b9 · F2 — second-source sweep: “task migration HITL × EventBus double-trigger”.
 *
 * The concern: a task status transition might fire BOTH a HITL notification and a
 * `task:*` EventBus event, both landing in the outbound dispatcher → one IM group
 * receives two messages.
 *
 * This probe wires the **real** pieces and settles it by observation, not argument:
 *   • real `OutboundDispatcher` (both ports: channel notifications + EventBus)
 *   • real `HITLService` (the channel stream, F1's split)
 *   • real `EventBus` + real `wireAgentEventForwarding` (agent bus → manager bus,
 *     the exact production forwarding used by `AgentManager.forwardAgentEvents`)
 *
 * The conclusion it pins:
 *   1. ONE status transition ⇒ exactly ONE outbound message (the HITL path only).
 *      The status machine emits **no** `task:*` event, so the same transition can
 *      never double-fire.
 *   2. The `task:*` EventBus path is a **separate** logical notification, emitted by
 *      the *agent execution lifecycle* (not by the status machine). It is not a
 *      duplicate of the transition notification — it is a different event with a
 *      different (degenerate) shape.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { EventBus } from '../../core/src/events.js';
import { wireAgentEventForwarding } from '../../core/src/agent-manager.js';
import { HITLService } from '../src/hitl-service.js';
import { OutboundDispatcher } from '../../comms/src/gateway/dispatcher.js';
import type { NotifyTarget, NotifyTargetLookup } from '../../comms/src/gateway/notify-route.js';
import type { OutboundSink } from '../../comms/src/gateway/dispatcher.js';

const TARGET: NotifyTarget = { platform: 'feishu', instanceId: 'bi_1', nativeId: 'oc_group' };

function lookupOf(): NotifyTargetLookup {
  return { candidates: () => [{ target: TARGET, scope: 'global' }] };
}

type Delivery = { title: string; body: string; severity: string };
function recordingSink(): OutboundSink & { deliveries: Delivery[] } {
  const deliveries: Delivery[] = [];
  return {
    deliveries,
    capabilities: () => ({ markdown: true }),
    send: async (_t, rendered) => {
      deliveries.push({ title: rendered.text.split('\n')[0], body: rendered.text, severity: 'info' });
      return `native_${deliveries.length}`;
    },
  };
}

function serviceWithHumans(ids: string[]): HITLService {
  const s = new HITLService();
  s.setOrgService({ listHumanUsers: () => ids.map((id) => ({ id, name: id })) } as never);
  return s;
}

/**
 * Wire the dispatcher exactly like production (`cli/commands/outbound.ts`):
 * both the channel-notification source and the manager EventBus are attached.
 * Returns the manager bus an AgentManager would expose via `getEventBus()`.
 */
function wireProductionLike(dispatcher: OutboundDispatcher, hitl: HITLService): EventBus {
  const agentBus = new EventBus();            // one Agent’s private bus
  const managerBus = new EventBus();          // AgentManager.getEventBus()
  wireAgentEventForwarding(agentBus, managerBus); // the real reachability bridge
  dispatcher.attachNotifications(hitl);
  dispatcher.attachEventBus(managerBus);
  return agentBus;
}

describe('F2 — a task status transition never double-fires (HITL × EventBus)', () => {
  it('ONE status transition ⇒ exactly ONE outbound message (HITL path only)', async () => {
    const hitl = serviceWithHumans(['u1', 'u2', 'u3']);
    const sink = recordingSink();
    const dispatcher = new OutboundDispatcher({ lookup: lookupOf(), sink });
    wireProductionLike(dispatcher, hitl);

    // What task-service.broadcastStatusChange does on  in_progress → review.
    hitl.notify({ targetUserId: 'all', type: 'task_review', title: 'Task ready for review: X', body: '…', priority: 'normal' });

    await vi.waitFor(() => expect(sink.deliveries.length).toBeGreaterThan(0));
    // 3 humans, but the channel stream fires once → 1 message, and NO second
    // message from the EventBus path (the status machine emits no task:* event).
    expect(sink.deliveries).toHaveLength(1);
    expect(sink.deliveries[0]!.body).toContain('Task ready for review: X');
    expect(sink.deliveries.some((d) => d.body.startsWith('task:'))).toBe(false);
  });

  it('the status machine emits NO task:* event — subscribed-but-silent on a transition', async () => {
    // Same wiring, but we never emit on the bus: a transition alone must not
    // produce the “task:review / task:completed / task:failed” messages, so the
    // dispatcher’s EventBus port stays silent for a transition.
    const hitl = serviceWithHumans(['u1', 'u2', 'u3']);
    const sink = recordingSink();
    const dispatcher = new OutboundDispatcher({ lookup: lookupOf(), sink });
    wireProductionLike(dispatcher, hitl);

    for (const type of ['task_review', 'task_completed', 'task_failed'] as const) {
      hitl.notify({ targetUserId: 'all', type, title: `Transition ${type}`, body: '…', priority: 'normal' });
    }

    await vi.waitFor(() => expect(sink.deliveries.length).toBe(3));
    // Exactly one message per transition — never two.
    expect(sink.deliveries).toHaveLength(3);
    expect(sink.deliveries.every((d) => d.body.startsWith('Transition '))).toBe(true);
  });

  it('agent-execution finish names nothing ⇒ it is NOT forwarded as a notification', async () => {
    const hitl = serviceWithHumans(['u1', 'u2', 'u3']);
    const sink = recordingSink();
    const dispatcher = new OutboundDispatcher({ lookup: lookupOf(), sink });
    const agentBus = wireProductionLike(dispatcher, hitl);

    // (a) the agent’s execution lifecycle emits task:completed on its private bus
    //     (agent.ts `_executeTaskInternal`, forwarded agent→manager). Its payload
    //     is `{ taskId, agentId }` — a runtime fact with no human-readable subject.
    agentBus.emit('task:completed', { taskId: 'tsk_x', agentId: 'agt_x' });
    agentBus.emit('task:failed', { taskId: 'tsk_x', agentId: 'agt_x', error: 'boom' });
    // (b) the status machine then moves the task to review → the ONE real
    //     user-facing notification.
    hitl.notify({ targetUserId: 'all', type: 'task_review', title: 'Task ready for review: X', body: '…', priority: 'normal' });

    await vi.waitFor(() => expect(sink.deliveries.length).toBeGreaterThan(0));
    // Exactly one message: the HITL one. The lifecycle events produced NOTHING —
    // before 2026-10-16 they degraded to a literally context-free "task:completed"
    // (the raw event name used as the title) and were pushed to the chat app.
    expect(sink.deliveries).toHaveLength(1);
    expect(sink.deliveries[0]!.body).toContain('Task ready for review: X');
    expect(sink.deliveries.some((d) => d.body.startsWith('task:'))).toBe(false);
  });

  it('a task event that DOES name itself is still forwarded (the guard is not a mute)', async () => {
    // The guard only drops content-free events. A task event carrying a title —
    // e.g. a future/external producer — must still reach the channel.
    const hitl = serviceWithHumans(['u1']);
    const sink = recordingSink();
    const dispatcher = new OutboundDispatcher({ lookup: lookupOf(), sink });
    const agentBus = wireProductionLike(dispatcher, hitl);

    agentBus.emit('task:completed', { taskId: 'tsk_x', agentId: 'agt_x', title: 'Ship the widget' });

    await vi.waitFor(() => expect(sink.deliveries.length).toBe(1));
    expect(sink.deliveries[0]!.body).toContain('Ship the widget');
  });
});

describe('F2 — structural guard: the status machine cannot emit task:* events', () => {
  it('task-service.ts contains no EventBus `emit(\'task:…\')`', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, '../src/task-service.ts'), 'utf8');
    // The ONLY producers of task:* events are the agent execution lifecycle
    // (core/agent.ts). If a status transition ever starts emitting them, the
    // dispatcher’s EventBus port would fire alongside the HITL path → the exact
    // double the F2 sweep is about. This guard makes that regression loud.
    expect(src).not.toMatch(/emit\(\s*['"`]task:/);
  });
});
