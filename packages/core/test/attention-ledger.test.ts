import { describe, it, expect, vi } from 'vitest';
import { AttentionController, type AttentionDelegate } from '../src/attention.js';
import { AgentMailbox } from '../src/mailbox.js';
import { EventBus } from '../src/events.js';
import { createSessionWorkspace, type SessionWorkspace } from '../src/session-workspace.js';
import {
  isStrictStateItem,
  type MailboxItem,
  type MailboxItemType,
  type MailboxPriority,
} from '@markus/shared';

const AGENT_ID = 'attn-ledger-agent';

function makeItem(
  overrides: Partial<MailboxItem> & { sourceType: MailboxItemType },
): MailboxItem {
  return {
    id: `mbx_${Math.random().toString(36).slice(2, 8)}`,
    agentId: AGENT_ID,
    priority: 2 as MailboxPriority,
    status: 'queued',
    payload: { summary: 'test', content: 'body' },
    queuedAt: new Date().toISOString(),
    ...overrides,
  };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitFor(fn: () => boolean, timeoutMs = 3000, stepMs = 10): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await sleep(stepMs);
  }
}

/**
 * Ledger invariant: the turn that starts processing an item MUST already have a
 * `pick` decision on record — on BOTH loop paths.
 *
 * Why the assertion is taken *inside* processMailboxItem rather than after the run:
 * an existence check after the fact is satisfied by any later write (including a
 * compensating one), so it would stay green if recording moved back into the serial
 * loop and the concurrent path silently stopped keeping books. Capturing the ledger
 * at the instant work begins pins both the writer and its position in the call order.
 *
 * Regression this guards (measured 2026-11-18): in concurrent mode a full day of
 * 116 inputs produced 3 decisions, all `drop` — the ledger had become a refusal log.
 */
function makeHarness(workerCount: number) {
  const eventBus = new EventBus();
  const mailbox = new AgentMailbox(AGENT_ID, eventBus);
  const workspaces = new Map<number, SessionWorkspace>();
  /** Per item: did a `pick` for it exist at the moment processing began? */
  const pickSeenAtStart = new Map<string, boolean>();
  const doneIds: string[] = [];

  let controller: AttentionController;
  const delegate: AttentionDelegate = {
    processMailboxItem: vi.fn(async (item: MailboxItem) => {
      const ledger = controller.getRecentDecisions(50);
      pickSeenAtStart.set(
        item.id,
        ledger.some(d => d.decisionType === 'pick' && d.mailboxItemId === item.id),
      );
      await sleep(20);
      doneIds.push(item.id);
      return 'ok';
    }),
    onDecisionMade: vi.fn(),
    onFocusChanged: vi.fn(),
    evaluateInterrupt: vi.fn().mockResolvedValue('continue'),
    onTriageCompleted: vi.fn(),
    onDeliberationCompleted: vi.fn(),
    getWorkerWorkspace: (workerId: number) => {
      let ws = workspaces.get(workerId);
      if (!ws) {
        ws = createSessionWorkspace(workerId);
        workspaces.set(workerId, ws);
      }
      return ws;
    },
  };

  controller = new AttentionController(AGENT_ID, mailbox, eventBus);
  controller.setWorkerCount(workerCount);
  controller.setDelegate(delegate);
  controller.start();
  return { controller, mailbox, pickSeenAtStart, doneIds };
}

describe('attention ledger — one recording execution point for both loops', () => {
  it('concurrent workers record the pick BEFORE processing starts', async () => {
    const h = makeHarness(3);
    h.mailbox.enqueue('a2a_message', { taskId: 'tsk_L1', summary: 'one', content: '1' });
    h.mailbox.enqueue('a2a_message', { taskId: 'tsk_L2', summary: 'two', content: '2' });
    h.mailbox.enqueue('a2a_message', { taskId: 'tsk_L3', summary: 'three', content: '3' });

    await waitFor(() => h.doneIds.length === 3);
    h.controller.stop();

    expect(h.pickSeenAtStart.size).toBe(3);
    for (const [itemId, seen] of h.pickSeenAtStart) {
      expect(seen, `no pick on record when work began for ${itemId}`).toBe(true);
    }
  });

  it('the serial loop records through the same execution point', async () => {
    const h = makeHarness(1);
    h.mailbox.enqueue('a2a_message', { taskId: 'tsk_S1', summary: 'one', content: '1' });
    h.mailbox.enqueue('a2a_message', { taskId: 'tsk_S2', summary: 'two', content: '2' });

    await waitFor(() => h.doneIds.length === 2);
    h.controller.stop();

    expect(h.pickSeenAtStart.size).toBe(2);
    for (const [itemId, seen] of h.pickSeenAtStart) {
      expect(seen, `no pick on record when work began for ${itemId}`).toBe(true);
    }
  });

  it('every processed item leaves exactly one pick — no path skips the books', async () => {
    const h = makeHarness(3);
    const ids = ['tsk_B1', 'tsk_B2', 'tsk_B3', 'tsk_B4'];
    for (const taskId of ids) {
      h.mailbox.enqueue('a2a_message', { taskId, summary: taskId, content: taskId });
    }
    await waitFor(() => h.doneIds.length === ids.length);
    h.controller.stop();

    const picks = h.controller
      .getRecentDecisions(100)
      .filter(d => d.decisionType === 'pick');
    expect(picks).toHaveLength(ids.length);
    expect(new Set(picks.map(d => d.mailboxItemId)).size).toBe(ids.length);
  });
});

describe('attention ledger — a strict-state override is one decision, not two', () => {
  it('records only the final judgement when the rule refuses to defer', async () => {
    const eventBus = new EventBus();
    const mailbox = new AgentMailbox(AGENT_ID, eventBus);
    const delegate: AttentionDelegate = {
      processMailboxItem: vi.fn().mockResolvedValue('done'),
      onDecisionMade: vi.fn(),
      onFocusChanged: vi.fn(),
      // The model wants to defer; the platform rule must refuse for strict-state items.
      evaluateInterrupt: vi.fn().mockResolvedValue('defer'),
      onTriageCompleted: vi.fn(),
      onDeliberationCompleted: vi.fn(),
    };
    const controller = new AttentionController(AGENT_ID, mailbox, eventBus);
    controller.setDelegate(delegate);

    const current = makeItem({ sourceType: 'a2a_message', id: 'focus_ledger' });
    // `review_request` is strict-state by policy (routeMailboxItem → strictState: true).
    const incoming = makeItem({
      sourceType: 'review_request',
      id: 'incoming_strict',
      priority: 1 as MailboxPriority,
      payload: { taskId: 'tsk_STRICT', summary: 'review', content: 'go' },
    });
    // Fixture self-check: if this stops being a strict-state item the test would
    // silently exercise nothing, so make that condition fail loudly instead.
    expect(isStrictStateItem(incoming)).toBe(true);

    mailbox.enqueue('review_request', incoming.payload, { priority: 1 as MailboxPriority });
    controller['currentFocus'] = current;
    controller['state'] = 'focused';
    controller['interruptSignal'] = true;
    controller['pendingInterruptItem'] = incoming;

    const result = await controller.checkYieldPoint();

    const forItem = controller
      .getRecentDecisions(50)
      .filter(d => d.mailboxItemId === incoming.id);
    expect(forItem, 'override must leave exactly one ledger row').toHaveLength(1);
    expect(forItem[0].decisionType).toBe(result.decision);
    expect(forItem[0].decisionType).not.toBe('defer');
    // The row must say a rule overrode the model, and what it overrode.
    expect(forItem[0].source).toBe('heuristic');
    expect(forItem[0].overrode).toBe('defer');
  });

  it('a model judgement is recorded as model, not silently as a rule', async () => {
    const eventBus = new EventBus();
    const mailbox = new AgentMailbox(AGENT_ID, eventBus);
    const delegate: AttentionDelegate = {
      processMailboxItem: vi.fn().mockResolvedValue('done'),
      onDecisionMade: vi.fn(),
      onFocusChanged: vi.fn(),
      evaluateInterrupt: vi.fn().mockResolvedValue('preempt'),
      onTriageCompleted: vi.fn(),
      onDeliberationCompleted: vi.fn(),
    };
    const controller = new AttentionController(AGENT_ID, mailbox, eventBus);
    controller.setDelegate(delegate);

    const current = makeItem({ sourceType: 'a2a_message', id: 'focus_model' });
    const incoming = makeItem({
      sourceType: 'human_chat',
      id: 'incoming_model',
      priority: 0 as MailboxPriority,
    });
    controller['currentFocus'] = current;
    controller['state'] = 'focused';
    controller['interruptSignal'] = true;
    controller['pendingInterruptItem'] = incoming;

    await controller.checkYieldPoint();

    const row = controller
      .getRecentDecisions(50)
      .find(d => d.mailboxItemId === incoming.id);
    expect(row?.source).toBe('model');
    expect(row?.overrode).toBeUndefined();
  });

  it('with no delegate the judgement is honestly labelled heuristic', async () => {
    const eventBus = new EventBus();
    const mailbox = new AgentMailbox(AGENT_ID, eventBus);
    const controller = new AttentionController(AGENT_ID, mailbox, eventBus);
    // No delegate: the platform decides on its own and must say so.
    const current = makeItem({ sourceType: 'a2a_message', id: 'focus_nodeleg' });
    const incoming = makeItem({
      sourceType: 'human_chat',
      id: 'incoming_nodeleg',
      priority: 0 as MailboxPriority,
    });
    controller['currentFocus'] = current;
    controller['state'] = 'focused';
    controller['interruptSignal'] = true;
    controller['pendingInterruptItem'] = incoming;

    await controller.checkYieldPoint();

    const row = controller
      .getRecentDecisions(50)
      .find(d => d.mailboxItemId === incoming.id);
    expect(row?.source).toBe('heuristic');
  });
});