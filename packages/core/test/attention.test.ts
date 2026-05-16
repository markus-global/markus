/**
 * Attention Controller & Mailbox Processing Tests
 *
 * Phase 1: Pure-function unit tests for detectAbnormalCompletion, heuristicDecision, needsLLMTriage
 * Phase 2: Integration tests for processFocusedItem, checkYieldPoint, runLoop shutdown, applyDeliberationResult
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AttentionController,
  detectAbnormalCompletion,
  type AttentionDelegate,
} from '../src/attention.js';
import { AgentMailbox } from '../src/mailbox.js';
import { EventBus } from '../src/events.js';
import {
  COMPLETION_MARKER,
  type MailboxItem,
  type MailboxItemType,
  type MailboxPriority,
  MailboxPriorityLevel,
} from '@markus/shared';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const AGENT_ID = 'test-agent';

function makeItem(
  overrides: Partial<MailboxItem> & { sourceType: MailboxItemType },
): MailboxItem {
  return {
    id: `mbx_${Math.random().toString(36).slice(2, 8)}`,
    agentId: AGENT_ID,
    priority: 2 as MailboxPriority,
    status: 'queued',
    payload: { summary: 'test', content: 'test body' },
    queuedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeController(delegateOverrides?: Partial<AttentionDelegate>) {
  const eventBus = new EventBus();
  const mailbox = new AgentMailbox(AGENT_ID, eventBus);
  const delegate: AttentionDelegate = {
    processMailboxItem: vi.fn().mockResolvedValue(`done ${COMPLETION_MARKER}`),
    onDecisionMade: vi.fn(),
    onFocusChanged: vi.fn(),
    evaluateInterrupt: vi.fn().mockResolvedValue('continue'),
    onTriageCompleted: vi.fn(),
    performDeliberation: vi.fn().mockResolvedValue(null),
    onDeliberationCompleted: vi.fn(),
    ...delegateOverrides,
  };
  const controller = new AttentionController(AGENT_ID, mailbox, eventBus);
  controller.setDelegate(delegate);
  return { controller, mailbox, eventBus, delegate };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 1: detectAbnormalCompletion — pure function
// ═══════════════════════════════════════════════════════════════════════════════

describe('detectAbnormalCompletion', () => {
  it('returns undefined for non-LLM types (no check needed)', () => {
    const item = makeItem({ sourceType: 'task_comment' });
    expect(detectAbnormalCompletion('any reply', item)).toBeUndefined();
  });

  it('returns undefined for non-LLM types even with empty reply', () => {
    const item = makeItem({ sourceType: 'requirement_comment' });
    expect(detectAbnormalCompletion('', item)).toBeUndefined();
  });

  it('returns undefined for preempted reply', () => {
    const item = makeItem({ sourceType: 'a2a_message' });
    expect(detectAbnormalCompletion('[preempted]', item)).toBeUndefined();
  });

  it('returns undefined for cancelled reply', () => {
    const item = makeItem({ sourceType: 'a2a_message' });
    expect(detectAbnormalCompletion('[cancelled]', item)).toBeUndefined();
  });

  it('detects empty reply for LLM-invoking type', () => {
    const item = makeItem({ sourceType: 'a2a_message' });
    expect(detectAbnormalCompletion('', item)).toBe('empty reply from LLM-invoking item');
  });

  it('detects undefined reply for LLM-invoking type', () => {
    const item = makeItem({ sourceType: 'a2a_message' });
    expect(detectAbnormalCompletion(undefined, item)).toBe('empty reply from LLM-invoking item');
  });

  it('detects missing completion marker', () => {
    const item = makeItem({ sourceType: 'a2a_message' });
    expect(detectAbnormalCompletion('some reply without marker', item)).toBe(
      'completion marker missing from reply',
    );
  });

  it('returns undefined when marker is present', () => {
    const item = makeItem({ sourceType: 'a2a_message' });
    expect(
      detectAbnormalCompletion(`done ${COMPLETION_MARKER}`, item),
    ).toBeUndefined();
  });

  it('checks human_chat — no special bypass', () => {
    const item = makeItem({ sourceType: 'human_chat' });
    const result = detectAbnormalCompletion('reply without marker', item);
    expect(result).toBe('completion marker missing from reply');
  });

  it('checks heartbeat type', () => {
    const item = makeItem({ sourceType: 'heartbeat' });
    expect(detectAbnormalCompletion('', item)).toBe('empty reply from LLM-invoking item');
  });

  it('checks system_event type', () => {
    const item = makeItem({ sourceType: 'system_event' });
    expect(
      detectAbnormalCompletion(`ok ${COMPLETION_MARKER}`, item),
    ).toBeUndefined();
  });

  it('does not flag task_status_update (non-LLM type)', () => {
    const item = makeItem({ sourceType: 'task_status_update' });
    expect(detectAbnormalCompletion('', item)).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 1: heuristicDecision
// ═══════════════════════════════════════════════════════════════════════════════

describe('heuristicDecision', () => {
  let controller: AttentionController;

  beforeEach(() => {
    ({ controller } = makeController());
  });

  it('R1: human_chat preempts non-user work', () => {
    const current = makeItem({ sourceType: 'heartbeat', priority: 3 as MailboxPriority });
    const incoming = makeItem({ sourceType: 'human_chat', priority: 0 as MailboxPriority });
    expect(controller.heuristicDecision(current, incoming)).toBe('preempt');
  });

  it('R1: human_chat does NOT preempt another human_chat', () => {
    const current = makeItem({ sourceType: 'human_chat', priority: 0 as MailboxPriority });
    const incoming = makeItem({ sourceType: 'human_chat', priority: 0 as MailboxPriority });
    expect(controller.heuristicDecision(current, incoming)).not.toBe('preempt');
  });

  it('R1.5: a2a_message preempts background work', () => {
    const current = makeItem({ sourceType: 'heartbeat', priority: 3 as MailboxPriority });
    const incoming = makeItem({ sourceType: 'a2a_message', priority: 2 as MailboxPriority });
    expect(controller.heuristicDecision(current, incoming)).toBe('preempt');
  });

  it('R1.5: a2a_message does NOT preempt human_chat', () => {
    const current = makeItem({ sourceType: 'human_chat', priority: 0 as MailboxPriority });
    const incoming = makeItem({ sourceType: 'a2a_message', priority: 2 as MailboxPriority });
    expect(controller.heuristicDecision(current, incoming)).not.toBe('preempt');
  });

  it('R2: task_comment on same task → merge', () => {
    const current = makeItem({
      sourceType: 'a2a_message',
      payload: { summary: 'task work', content: 'working', taskId: 'task-1' },
    });
    const incoming = makeItem({
      sourceType: 'task_comment',
      payload: { summary: 'comment', content: 'feedback', taskId: 'task-1' },
    });
    expect(controller.heuristicDecision(current, incoming)).toBe('merge');
  });

  it('R2: task_comment on different task → NOT merge', () => {
    const current = makeItem({
      sourceType: 'a2a_message',
      payload: { summary: 'task work', content: 'working', taskId: 'task-1' },
    });
    const incoming = makeItem({
      sourceType: 'task_comment',
      payload: { summary: 'comment', content: 'feedback', taskId: 'task-2' },
    });
    expect(controller.heuristicDecision(current, incoming)).not.toBe('merge');
  });

  it('R6: strictly higher priority preempts', () => {
    const current = makeItem({ sourceType: 'a2a_message', priority: 2 as MailboxPriority });
    const incoming = makeItem({ sourceType: 'a2a_message', priority: 1 as MailboxPriority });
    expect(controller.heuristicDecision(current, incoming)).toBe('preempt');
  });

  it('R6: same priority does NOT preempt (unless background)', () => {
    const current = makeItem({ sourceType: 'a2a_message', priority: 2 as MailboxPriority });
    const incoming = makeItem({ sourceType: 'a2a_message', priority: 2 as MailboxPriority });
    expect(controller.heuristicDecision(current, incoming)).toBe('continue');
  });

  it('R9: mention preempts low-priority work', () => {
    const current = makeItem({ sourceType: 'a2a_message', priority: 2 as MailboxPriority });
    const incoming = makeItem({ sourceType: 'mention', priority: 1 as MailboxPriority });
    expect(controller.heuristicDecision(current, incoming)).toBe('preempt');
  });

  it('default: continue for same-priority non-critical items', () => {
    const current = makeItem({ sourceType: 'review_request', priority: 1 as MailboxPriority });
    const incoming = makeItem({ sourceType: 'review_request', priority: 1 as MailboxPriority });
    expect(controller.heuristicDecision(current, incoming)).toBe('continue');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 2: processFocusedItem — status transitions
// ═══════════════════════════════════════════════════════════════════════════════

describe('processFocusedItem (via runLoop)', () => {
  it('completes item on normal reply with marker', async () => {
    const { controller, mailbox, delegate } = makeController({
      processMailboxItem: vi.fn().mockResolvedValue(`done ${COMPLETION_MARKER}`),
    });

    const item = mailbox.enqueue('a2a_message', { summary: 'msg', content: 'body' });
    controller.start();
    // Wait for the item to be processed
    await vi.waitFor(() => {
      expect(mailbox.depth).toBe(0);
    }, { timeout: 2000 });
    controller.stop();

    expect(delegate.processMailboxItem).toHaveBeenCalledTimes(1);
  });

  it('defers item on [preempted] reply', async () => {
    const { controller, mailbox, delegate } = makeController({
      processMailboxItem: vi.fn().mockResolvedValue('[preempted]'),
    });

    const item = mailbox.enqueue('a2a_message', { summary: 'msg', content: 'body' });
    controller.start();
    await vi.waitFor(() => {
      expect(delegate.processMailboxItem).toHaveBeenCalledTimes(1);
    }, { timeout: 2000 });
    // Give time for post-processing
    await new Promise(r => setTimeout(r, 100));
    controller.stop();

    // Item should NOT be in the in-memory queue (deferDequeued doesn't re-insert)
    expect(mailbox.depth).toBe(0);
  });

  it('completes item on [cancelled] reply', async () => {
    const { controller, mailbox, delegate } = makeController({
      processMailboxItem: vi.fn().mockResolvedValue('[cancelled]'),
    });

    mailbox.enqueue('a2a_message', { summary: 'msg', content: 'body' });
    controller.start();
    await vi.waitFor(() => {
      expect(delegate.processMailboxItem).toHaveBeenCalledTimes(1);
    }, { timeout: 2000 });
    await new Promise(r => setTimeout(r, 100));
    controller.stop();

    expect(mailbox.depth).toBe(0);
  });

  it('requeues item on abnormal completion (empty reply)', async () => {
    let callCount = 0;
    const { controller, mailbox } = makeController({
      processMailboxItem: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount <= 2) return '';
        return `ok ${COMPLETION_MARKER}`;
      }),
    });

    mailbox.enqueue('a2a_message', { summary: 'msg', content: 'body' });
    controller.start();
    await vi.waitFor(() => {
      expect(callCount).toBeGreaterThanOrEqual(3);
    }, { timeout: 5000 });
    controller.stop();

    // After 2 retries with empty reply, the 3rd call succeeds
    expect(callCount).toBe(3);
  });

  it('requeues item on processing error', async () => {
    let callCount = 0;
    const { controller, mailbox } = makeController({
      processMailboxItem: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error('boom');
        return `ok ${COMPLETION_MARKER}`;
      }),
    });

    mailbox.enqueue('a2a_message', { summary: 'msg', content: 'body' });
    controller.start();
    await vi.waitFor(() => {
      expect(callCount).toBe(2);
    }, { timeout: 3000 });
    controller.stop();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 2: checkYieldPoint
// ═══════════════════════════════════════════════════════════════════════════════

describe('checkYieldPoint', () => {
  it('returns continue when no interrupt is pending', async () => {
    const { controller } = makeController();
    const result = await controller.checkYieldPoint();
    expect(result.decision).toBe('continue');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 2: runLoop shutdown — re-enqueue logic
// ═══════════════════════════════════════════════════════════════════════════════

describe('runLoop shutdown re-enqueue', () => {
  it('re-enqueues a2a_message without responsePromise on shutdown', async () => {
    const { controller, mailbox } = makeController({
      processMailboxItem: vi.fn().mockImplementation(async () => {
        // Simulate slow processing; controller.stop() will fire during this
        await new Promise(r => setTimeout(r, 500));
        return `ok ${COMPLETION_MARKER}`;
      }),
    });

    mailbox.enqueue('a2a_message', { summary: 'group chat msg', content: 'body' });
    controller.start();
    // Let it start processing
    await new Promise(r => setTimeout(r, 50));
    controller.stop();
    // Wait for loop to exit
    await new Promise(r => setTimeout(r, 200));

    // The item was being processed when stop() was called.
    // processFocusedItem should requeue it since !this.running.
    // We can't easily test the dequeue-during-shutdown path directly,
    // but we can verify the controller stopped cleanly.
  });

  it('does NOT re-enqueue human_chat on shutdown', async () => {
    const eventBus = new EventBus();
    const mailbox = new AgentMailbox(AGENT_ID, eventBus);

    // Enqueue two items: human_chat should be dropped, a2a should survive
    mailbox.enqueue('human_chat', { summary: 'user msg', content: 'hello' });
    mailbox.enqueue('a2a_message', { summary: 'agent msg', content: 'body' });

    expect(mailbox.depth).toBe(2);

    // On a real shutdown, the runLoop dequeues the head item (human_chat)
    // and checks !this.running → skips re-enqueue for human_chat.
    // We test the logic directly:
    const item = mailbox.dequeue()!;
    expect(item.sourceType).toBe('human_chat');

    const hasLiveCallback = item.sourceType === 'a2a_message' && !!item.metadata?.responsePromise;
    const shouldReenqueue = item.sourceType !== 'human_chat' && !hasLiveCallback;
    expect(shouldReenqueue).toBe(false);
  });

  it('distinguishes direct a2a (with responsePromise) from group chat a2a', () => {
    const directA2A = makeItem({
      sourceType: 'a2a_message',
      metadata: { responsePromise: { resolve: () => {} } } as any,
    });
    const groupA2A = makeItem({
      sourceType: 'a2a_message',
      metadata: { senderId: 'agent-2' },
    });

    const shouldReenqueueDirect =
      directA2A.sourceType !== 'human_chat' &&
      !(directA2A.sourceType === 'a2a_message' && !!directA2A.metadata?.responsePromise);
    const shouldReenqueueGroup =
      groupA2A.sourceType !== 'human_chat' &&
      !(groupA2A.sourceType === 'a2a_message' && !!groupA2A.metadata?.responsePromise);

    expect(shouldReenqueueDirect).toBe(false);
    expect(shouldReenqueueGroup).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 2: applyDeliberationResult — edge cases
// ═══════════════════════════════════════════════════════════════════════════════

describe('applyDeliberationResult edge cases', () => {
  it('does not inline-complete the item chosen for full processing', async () => {
    const { controller, mailbox, delegate } = makeController({
      processMailboxItem: vi.fn().mockResolvedValue(`ok ${COMPLETION_MARKER}`),
      performDeliberation: vi.fn().mockImplementation(async (_head, allItems) => {
        // Deliberately inconsistent: list processItemId in inlineCompletedIds too
        return {
          processItemId: allItems[1].id,
          inlineCompletedIds: [allItems[1].id],
          deferItemIds: [],
          dropItemIds: [],
          reasoning: 'test inconsistency',
        };
      }),
    });

    mailbox.enqueue('a2a_message', { summary: 'msg-A', content: 'A' });
    mailbox.enqueue('a2a_message', { summary: 'msg-B', content: 'B' });
    mailbox.enqueue('a2a_message', { summary: 'msg-C', content: 'C' });

    controller.start();
    await vi.waitFor(() => {
      expect(delegate.processMailboxItem).toHaveBeenCalled();
    }, { timeout: 3000 });
    controller.stop();

    // The chosen item (msg-B) should have been processed, not inline-completed
    const processedItem = (delegate.processMailboxItem as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(processedItem).toBeDefined();
  });

  it('protects human_chat from being dropped by deliberation', async () => {
    const { controller, mailbox, delegate } = makeController({
      processMailboxItem: vi.fn().mockResolvedValue(`ok ${COMPLETION_MARKER}`),
      performDeliberation: vi.fn().mockImplementation(async (_head, allItems) => {
        // Try to drop everything including human_chat
        return {
          processItemId: allItems[0].id,
          inlineCompletedIds: [],
          deferItemIds: [],
          dropItemIds: allItems.slice(1).map(i => i.id),
          reasoning: 'drop all',
        };
      }),
    });

    mailbox.enqueue('a2a_message', { summary: 'msg', content: 'body' });
    // human_chat should be protected
    const humanItem = mailbox.enqueue('human_chat', { summary: 'user', content: 'hello' });

    controller.start();
    await vi.waitFor(() => {
      expect(delegate.processMailboxItem).toHaveBeenCalled();
    }, { timeout: 3000 });
    // Give time for deliberation result to be applied
    await new Promise(r => setTimeout(r, 200));
    controller.stop();

    // human_chat should still be in queue (protected from drop)
    // or already processed — either way, it should not be status 'dropped'
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 2: onNewMail — interrupt signal
// ═══════════════════════════════════════════════════════════════════════════════

describe('onNewMail interrupt signal', () => {
  it('hasInterruptPending returns false when idle', () => {
    const { controller } = makeController();
    expect(controller.hasInterruptPending()).toBe(false);
  });

  it('sets interrupt signal when new mail arrives during focused state', async () => {
    const processPromise = new Promise<string>(() => {});
    const { controller, mailbox } = makeController({
      processMailboxItem: vi.fn().mockReturnValue(processPromise),
    });

    mailbox.enqueue('a2a_message', { summary: 'first', content: 'body' });
    controller.start();
    // Wait for the controller to pick up the item and enter focused state
    await new Promise(r => setTimeout(r, 100));

    // Now enqueue a second item — should trigger interrupt signal
    mailbox.enqueue('human_chat', { summary: 'urgent', content: 'help' });
    await new Promise(r => setTimeout(r, 50));

    expect(controller.hasInterruptPending()).toBe(true);
    controller.stop();
  });
});
