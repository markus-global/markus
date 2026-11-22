/**
 * Sticky entity→worker routing (concurrent-processing.md §3.4).
 *
 * Contract: an entity's work is handled by its OWNER worker across turns.
 * Liveness overrides stickiness only via the documented rules: busy-owner
 * grace steal, gone-owner transfer, pool-epoch reset, fail-open without probe.
 *
 * Bite: ownership assertions are synchronous dequeue(workerId) races against a
 * controlled probe — deterministic, no timing luck. The unicast test uses a
 * taskId whose FNV hash picks the NON-owner waiter under the old hash routing
 * ('tsk_UNI:r?' → index 1), so it is red without owner preference.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AgentMailbox, STICKY_STEAL_GRACE_MS } from '../src/mailbox.js';
import { EventBus } from '../src/events.js';
import { AttentionController, type AttentionDelegate } from '../src/attention.js';
import {
  createSessionWorkspace, sessionWorkspaceStore, type SessionWorkspace,
} from '../src/session-workspace.js';
import type { MailboxItem } from '@markus/shared';

const AGENT = 'sticky-routing-agent';
type WState = 'idle' | 'busy' | 'gone';

function makeMailbox() {
  return new AgentMailbox(AGENT, new EventBus());
}
function probe(mb: AgentMailbox, states: Record<number, WState>) {
  mb.setWorkerProbe(id => states[id] ?? 'gone');
}
/** task_comment with an explicit round — distinct rounds avoid dedup/merge. */
function tc(mb: AgentMailbox, taskId: string, round: number) {
  return mb.enqueue('task_comment', { taskId, summary: `t${round}`, content: `c${round}` }, { round });
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await sleep(10);
  }
}

afterEach(() => { vi.useRealTimers(); });

describe('ownership persists across turns', () => {
  it('first claim owns the entity; the next item is claimable only by the owner', () => {
    const mb = makeMailbox();
    probe(mb, { 1: 'idle', 2: 'idle' });
    const a = tc(mb, 'tsk_S', 1);
    expect(mb.dequeue(1)?.id).toBe(a.id);
    mb.complete(a.id);

    const b = tc(mb, 'tsk_S', 2);
    expect(mb.dequeue(2)).toBeUndefined();      // both idle — still owner-only
    expect(mb.dequeue(1)?.id).toBe(b.id);
  });

  it('different entities stay parallel — ownership never pins a second entity', () => {
    const mb = makeMailbox();
    probe(mb, { 1: 'idle', 2: 'idle' });
    const a = tc(mb, 'tsk_A', 1);
    mb.dequeue(1); mb.complete(a.id);
    const b = tc(mb, 'tsk_B', 1);
    expect(mb.dequeue(2)?.id).toBe(b.id);
  });

  it('serial dequeue() (no workerId) neither filters nor records — equivalence contract', () => {
    const mb = makeMailbox();
    probe(mb, { 1: 'idle', 2: 'idle' });
    const a = tc(mb, 'tsk_EQ', 1);
    mb.dequeue(1); mb.complete(a.id);
    const b = tc(mb, 'tsk_EQ', 2);
    expect(mb.dequeue()?.id).toBe(b.id);
  });

  it('resetEntityOwnership clears all claims (pool epoch boundary)', () => {
    const mb = makeMailbox();
    probe(mb, { 1: 'idle', 2: 'idle' });
    const a = tc(mb, 'tsk_R', 1);
    mb.dequeue(1); mb.complete(a.id);
    mb.resetEntityOwnership();
    const b = tc(mb, 'tsk_R', 2);
    expect(mb.dequeue(2)?.id).toBe(b.id);
  });

  it('no probe installed → fail-open (liveness first)', () => {
    const mb = makeMailbox();
    probe(mb, { 1: 'idle', 2: 'idle' });
    const a = tc(mb, 'tsk_F', 1);
    mb.dequeue(1); mb.complete(a.id);
    mb.setWorkerProbe(undefined);
    const b = tc(mb, 'tsk_F', 2);
    expect(mb.dequeue(2)?.id).toBe(b.id);
  });
});

describe('liveness overrides stickiness — and only via the documented rules', () => {
  it('idle owner is NEVER stolen from, even far beyond the grace window', async () => {
    vi.useFakeTimers();
    const mb = makeMailbox();
    probe(mb, { 1: 'idle', 2: 'idle' });
    const a = tc(mb, 'tsk_I', 1);
    mb.dequeue(1); mb.complete(a.id);
    const b = tc(mb, 'tsk_I', 2);
    await vi.advanceTimersByTimeAsync(STICKY_STEAL_GRACE_MS * 3);
    expect(mb.dequeue(2)).toBeUndefined();
    expect(mb.dequeue(1)?.id).toBe(b.id);
  });

  it('busy owner: blocked before grace, steal after grace, ownership transfers', async () => {
    vi.useFakeTimers();
    const mb = makeMailbox();
    probe(mb, { 1: 'idle', 2: 'idle' });
    const a = tc(mb, 'tsk_G', 1);
    mb.dequeue(1); mb.complete(a.id);

    probe(mb, { 1: 'busy', 2: 'idle' });
    const b = tc(mb, 'tsk_G', 2);
    expect(mb.dequeue(2)).toBeUndefined();      // grace not elapsed
    await vi.advanceTimersByTimeAsync(STICKY_STEAL_GRACE_MS + 1);
    expect(mb.dequeue(2)?.id).toBe(b.id);       // steal
    mb.complete(b.id);

    probe(mb, { 1: 'idle', 2: 'idle' });
    const c = tc(mb, 'tsk_G', 3);
    expect(mb.dequeue(1)).toBeUndefined();      // entity now belongs to worker 2
    expect(mb.dequeue(2)?.id).toBe(c.id);
  });

  it('gone owner: immediate transfer, no grace wait', () => {
    const mb = makeMailbox();
    probe(mb, { 1: 'idle', 2: 'idle' });
    const a = tc(mb, 'tsk_D', 1);
    mb.dequeue(1); mb.complete(a.id);
    probe(mb, { 1: 'gone', 2: 'idle' });
    const b = tc(mb, 'tsk_D', 2);
    expect(mb.dequeue(2)?.id).toBe(b.id);
  });

  it('timed wake: a parked worker steals at the deadline with NO external event', async () => {
    vi.useFakeTimers();
    const mb = makeMailbox();
    probe(mb, { 1: 'idle', 2: 'idle' });
    const a = tc(mb, 'tsk_T', 1);
    mb.dequeue(1); mb.complete(a.id);

    probe(mb, { 1: 'busy', 2: 'idle' });
    const b = tc(mb, 'tsk_T', 2);
    let got: MailboxItem | undefined;
    const p = mb.dequeueAsync(2).then(i => { got = i; });
    await vi.advanceTimersByTimeAsync(1000);
    expect(got).toBeUndefined();                // blocked: owner busy, grace running
    await vi.advanceTimersByTimeAsync(STICKY_STEAL_GRACE_MS);
    await p;
    expect(got?.id).toBe(b.id);                 // woke on the steal timer alone
  });
});

describe('ownership key = primary entity key only', () => {
  it('req: ownership does NOT pin task items of the same requirement', () => {
    const mb = makeMailbox();
    probe(mb, { 1: 'idle', 2: 'idle' });
    const r = mb.enqueue('requirement_comment',
      { requirementId: 'req_R', summary: 'r', content: 'r' }, { round: 1 });
    expect(mb.dequeue(1)?.id).toBe(r.id);       // owns req:req_R
    mb.complete(r.id);
    const t = mb.enqueue('task_comment',
      { taskId: 'tsk_P', requirementId: 'req_R', summary: 't', content: 't' }, { round: 1 });
    expect(mb.dequeue(2)?.id).toBe(t.id);       // primary task:tsk_P is unowned
  });

  it('user:-primary items get no owner at all', () => {
    const mb = makeMailbox();
    probe(mb, { 1: 'idle', 2: 'idle' });
    const m1 = mb.enqueue('mention', { summary: 'm1', content: 'x' },
      { metadata: { senderId: 'user_U' }, round: 1 });
    expect(mb.dequeue(1)?.id).toBe(m1.id);
    mb.complete(m1.id);
    const m2 = mb.enqueue('mention', { summary: 'm2', content: 'y' },
      { metadata: { senderId: 'user_U' }, round: 2 });
    expect(mb.dequeue(2)?.id).toBe(m2.id);
  });
});

describe('wake correctness', () => {
  it('unicast wake prefers the owner waiter (hash would pick the non-owner)', async () => {
    const mb = makeMailbox();
    probe(mb, { 1: 'idle', 2: 'idle' });
    // Seed ownership of task:tsk_UNI by worker 1.
    const seed = mb.enqueue('review_request',
      { taskId: 'tsk_UNI', summary: 'seed', content: 's' }, { round: 0 });
    expect(mb.dequeue(1)?.id).toBe(seed.id);
    mb.complete(seed.id);

    let got1: MailboxItem | undefined;
    let got2: MailboxItem | undefined;
    const p1 = mb.dequeueAsync(1).then(i => { got1 = i; });
    const p2 = mb.dequeueAsync(2).then(i => { got2 = i; });
    await sleep(15);
    // No round → routeKey 'tsk_UNI:r?' → FNV % 2 = 1 → old hash routing wakes
    // the SECOND registered waiter (worker 2). Owner preference must override.
    const rev = mb.enqueue('review_request',
      { taskId: 'tsk_UNI', summary: 'review', content: 'r' });
    await sleep(30);
    expect(got1?.id).toBe(rev.id);
    expect(got2).toBeUndefined();
    mb.cancelWait();
    await Promise.allSettled([p1, p2]);
  });
});

describe('attention wiring (pool epoch + workerId pass-through)', () => {
  function makeHarness(workerCount = 2) {
    const eventBus = new EventBus();
    const mailbox = new AgentMailbox(AGENT, eventBus);
    const seen: number[] = [];
    const workspaces = new Map<number, SessionWorkspace>();
    const delegate = {
      processMailboxItem: vi.fn(async (_item: MailboxItem) => {
        seen.push(sessionWorkspaceStore.getStore()?.workerId ?? -1);
        await sleep(20);
        return 'ok';
      }),
      onDecisionMade: vi.fn(),
      onFocusChanged: vi.fn(),
      evaluateInterrupt: vi.fn().mockResolvedValue('preempt'),
      onTriageCompleted: vi.fn(),
      onDeliberationCompleted: vi.fn(),
      getWorkerWorkspace: (workerId: number) => {
        let ws = workspaces.get(workerId);
        if (!ws) { ws = createSessionWorkspace(workerId); workspaces.set(workerId, ws); }
        return ws;
      },
    } as unknown as AttentionDelegate;
    const controller = new AttentionController(AGENT, mailbox, eventBus);
    controller.setWorkerCount(workerCount);
    controller.setDelegate(delegate);
    return { controller, mailbox, seen };
  }

  it('pool installs probe + resets ownership; workers dequeue with their id; one conversation stays on one worker', async () => {
    const h = makeHarness(2);
    const dequeueSpy = vi.spyOn(h.mailbox, 'dequeueAsync');
    const probeSpy = vi.spyOn(h.mailbox, 'setWorkerProbe');
    const resetSpy = vi.spyOn(h.mailbox, 'resetEntityOwnership');
    h.controller.start();
    await waitFor(() => dequeueSpy.mock.calls.length >= 2);
    expect(probeSpy).toHaveBeenCalled();
    expect(resetSpy).toHaveBeenCalled();
    const ids = dequeueSpy.mock.calls.map(c => c[0]);
    expect(ids).toContain(1);
    expect(ids).toContain(2);

    // End-to-end: two sequential turns of one conversation land on the same worker.
    h.mailbox.enqueue('human_chat', { summary: 'turn 1', content: 'one' },
      { metadata: { sessionId: 'cs_sticky_e2e' } });
    await waitFor(() => h.seen.length >= 1);
    h.mailbox.enqueue('human_chat', { summary: 'turn 2', content: 'two' },
      { metadata: { sessionId: 'cs_sticky_e2e' } });
    await waitFor(() => h.seen.length >= 2);
    expect(h.seen[0]).toBeGreaterThan(0);
    expect(h.seen[1]).toBe(h.seen[0]);
    h.controller.stop();
  });
});
