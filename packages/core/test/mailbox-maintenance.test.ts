import { describe, it, expect, vi } from 'vitest';
import { AgentMailbox } from '../src/mailbox.js';
import { AgentClock } from '../src/clock.js';
import { EventBus } from '../src/events.js';
import type { MailboxItem } from '@markus/shared';

const A = 'maint-agent';

function makeMailbox(loadDeferred: () => MailboxItem[]) {
  const eventBus = new EventBus();
  return new AgentMailbox(A, eventBus, {
    save: vi.fn(),
    updateStatus: vi.fn(),
    loadDeferred: () => loadDeferred(),
  });
}

function deferred(offsetMs: number): MailboxItem {
  return {
    id: 'm1',
    agentId: A,
    sourceType: 'a2a_message',
    priority: 2,
    status: 'deferred',
    payload: { summary: 's', content: 'c' },
    queuedAt: new Date().toISOString(),
    deferredUntil: new Date(Date.now() + offsetMs).toISOString(),
  } as MailboxItem;
}

describe('AgentMailbox.runMaintenance — single upkeep entry', () => {
  it('resurfaces an overdue deferred item', () => {
    const mailbox = makeMailbox(() => [deferred(-1000)]); // due 1s ago
    const r = mailbox.runMaintenance();
    expect(r.resurfaced).toBe(1);
    expect(mailbox.depth).toBe(1);
  });

  it('leaves a not-yet-due deferred item deferred', () => {
    const mailbox = makeMailbox(() => [deferred(+60 * 60_000)]); // due in 1h
    const r = mailbox.runMaintenance();
    expect(r.resurfaced).toBe(0);
    expect(mailbox.depth).toBe(0);
  });

  it('reports reclaimed / cleaned / purged counts without throwing when persistence is partial', () => {
    const mailbox = makeMailbox(() => []);
    const r = mailbox.runMaintenance();
    expect(r).toMatchObject({ resurfaced: 0, reclaimed: 0, cleaned: 0, purged: 0 });
  });
});

describe('the clock is what releases a stuck defer (empty queue, no external wake)', () => {
  it('one clock tick drives runMaintenance and frees the defer', () => {
    const mailbox = makeMailbox(() => [deferred(-1000)]);
    let t = 1_000_000;
    const clock = new AgentClock(A, 1000, () => t);
    clock.register({ name: 'mailbox-maintenance', everyMs: 30_000, fn: () => mailbox.runMaintenance() });

    // No enqueue, no dequeue, no loop iteration — only the clock.
    clock.tick();
    expect(mailbox.depth).toBe(1);

    // Cadence still holds.
    t += 30_000;
    clock.tick();
    expect(mailbox.depth).toBe(1); // already queued; no duplicate
  });
});
