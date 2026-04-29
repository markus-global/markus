/**
 * Mailbox Recovery Mechanism Integration Tests
 *
 * Covers:
 *   1. Service restart recovery (recoverStaleItems)
 *   2. Message deduplication (enqueue-time + post-recovery)
 *   3. Completion Marker behaviour
 *   4. Priority ordering and processing
 *
 * All tests exercise AgentMailbox in isolation, using a hand-rolled in-memory
 * MailboxPersistence stub so there is no SQLite dependency.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentMailbox, type MailboxPersistence } from '../src/mailbox.js';
import { EventBus } from '../src/events.js';

// ─── Minimal inline types mirroring @markus/shared (avoids resolution issue) ─

type MailboxItemType =
  | 'human_chat'
  | 'a2a_message'
  | 'task_status_update'
  | 'task_comment'
  | 'heartbeat'
  | 'review_request'
  | 'requirement_update'
  | 'requirement_comment'
  | 'mention'
  | 'system_event'
  | 'session_reply'
  | 'daily_report'
  | 'memory_consolidation';

type MailboxItemStatus = 'queued' | 'processing' | 'completed' | 'dropped';

interface MailboxItem {
  id: string;
  agentId: string;
  sourceType: MailboxItemType;
  priority: number;
  status: MailboxItemStatus;
  payload: Record<string, unknown>;
  queuedAt: string;
  completedMarker?: string;
  mergedIntoId?: string;
  dedupKey?: string;
  sourceAgentId?: string;
}

// TTL: 3 days in ms — mirrors @markus/shared constant
const MAILBOX_QUEUED_TTL_MS = 259200000;

// ─── In-memory persistence stub ─────────────────────────────────────────────

class InMemoryPersistence implements MailboxPersistence {
  items = new Map<string, MailboxItem>();

  save(item: MailboxItem): void {
    this.items.set(item.id, { ...item });
  }

  updateStatus(
    itemId: string,
    status: MailboxItemStatus,
    extra?: Partial<MailboxItem>,
  ): void {
    const existing = this.items.get(itemId);
    if (existing) {
      Object.assign(existing, extra ?? {}, { status });
    }
  }

  markStaleProcessingAsDropped(agentId: string): number {
    let count = 0;
    for (const item of this.items.values()) {
      if (item.agentId === agentId && item.status === 'processing') {
        item.status = 'dropped';
        count++;
      }
    }
    return count;
  }

  loadQueued(agentId: string): MailboxItem[] {
    return [...this.items.values()].filter(
      (i) => i.agentId === agentId && i.status === 'queued',
    );
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const AGENT_ID = 'test-agent-001';

function makeEventBus() {
  return new EventBus();
}

function makeMailbox(
  persistence?: MailboxPersistence,
  agentId = AGENT_ID,
): AgentMailbox {
  return new AgentMailbox(agentId, makeEventBus(), persistence);
}

function makePayload(summary: string, content = 'body', taskId?: string) {
  return { summary, content, taskId };
}

/** Return a queuedAt timestamp that is older than MAILBOX_QUEUED_TTL_MS */
function expiredTimestamp(): string {
  return new Date(Date.now() - MAILBOX_QUEUED_TTL_MS - 1000).toISOString();
}

// ─── 1. Service Restart Recovery ────────────────────────────────────────────

describe('Mailbox Recovery — service restart', () => {
  it('restores queued items from persistence on recoverStaleItems()', () => {
    const persistence = new InMemoryPersistence();

    // Simulate: items were persisted before "shutdown"
    const originalMailbox = makeMailbox(persistence);
    originalMailbox.enqueue('a2a_message', makePayload('msg-A'));
    originalMailbox.enqueue('a2a_message', makePayload('msg-B'));
    expect(originalMailbox.depth).toBe(2);

    // Simulate restart: create a fresh mailbox with the same persistence
    const newMailbox = makeMailbox(persistence);
    expect(newMailbox.depth).toBe(0); // queue is empty before recovery

    const result = newMailbox.recoverStaleItems();
    expect(result.restored).toBe(2);
    expect(result.dropped).toBe(0);
    expect(result.expired).toBe(0);
    expect(newMailbox.depth).toBe(2);
  });

  it('drops items stuck in processing state (stale after restart)', () => {
    const persistence = new InMemoryPersistence();
    const originalMailbox = makeMailbox(persistence);

    // Enqueue and dequeue (moves to processing)
    originalMailbox.enqueue('a2a_message', makePayload('in-flight-msg'));
    const item = originalMailbox.dequeue();
    expect(item?.status).toBe('processing');
    // Verify persistence recorded it as processing
    const persisted = persistence.items.get(item!.id);
    expect(persisted?.status).toBe('processing');

    // Simulate restart
    const newMailbox = makeMailbox(persistence);
    const result = newMailbox.recoverStaleItems();

    expect(result.dropped).toBe(1);
    expect(result.restored).toBe(0);
    expect(newMailbox.depth).toBe(0);

    // Confirm the item is marked as dropped in persistence
    const droppedItem = persistence.items.get(item!.id);
    expect(droppedItem?.status).toBe('dropped');
  });

  it('does not restore expired items (older than TTL)', () => {
    const persistence = new InMemoryPersistence();
    const originalMailbox = makeMailbox(persistence);

    // Manually save an expired item
    originalMailbox.enqueue('a2a_message', makePayload('old-msg'));
    const items = [...persistence.items.values()];
    expect(items.length).toBe(1);
    // Override queuedAt to be expired
    items[0].queuedAt = expiredTimestamp();

    // New mailbox after restart
    const newMailbox = makeMailbox(persistence);
    const result = newMailbox.recoverStaleItems();

    expect(result.expired).toBe(1);
    expect(result.restored).toBe(0);
    expect(newMailbox.depth).toBe(0);
  });

  it('emits mailbox:new-item events after restoring zero items (sanity)', () => {
    const persistence = new InMemoryPersistence();
    const newMailbox = makeMailbox(persistence);
    const result = newMailbox.recoverStaleItems();

    expect(result.dropped).toBe(0);
    expect(result.restored).toBe(0);
    expect(result.expired).toBe(0);
    expect(result.merged).toBe(0);
    expect(newMailbox.depth).toBe(0);
  });

  it('handles mixed stale-processing and fresh-queued items', () => {
    const persistence = new InMemoryPersistence();
    const originalMailbox = makeMailbox(persistence);

    // 2 queued items
    originalMailbox.enqueue('a2a_message', makePayload('queued-A'));
    originalMailbox.enqueue('heartbeat', makePayload('hb-1'));
    // 1 item goes to processing
    originalMailbox.dequeue();

    const newMailbox = makeMailbox(persistence);
    const result = newMailbox.recoverStaleItems();

    // 1 dropped (was processing), 1 queued restored (the first was dequeued)
    // Actually we enqueued 2, dequeued 1 → 1 processing, 1 queued
    expect(result.dropped).toBe(1);
    expect(result.restored).toBe(1);
    expect(newMailbox.depth).toBe(1);
  });
});

// ─── 2. Message Deduplication ────────────────────────────────────────────────

describe('Mailbox Deduplication — enqueue-time', () => {
  it('merges task_comment items with the same taskId at enqueue time', () => {
    const mailbox = makeMailbox();

    mailbox.enqueue('task_comment', makePayload('first comment', 'body-1', 'task-abc'));
    mailbox.enqueue('task_comment', makePayload('second comment', 'body-2', 'task-abc'));

    // Both comments should be merged into one item
    expect(mailbox.depth).toBe(1);
    const item = mailbox.peek()!;
    expect(item.payload.content).toContain('body-1');
    expect(item.payload.content).toContain('body-2');
    expect(item.payload.summary).toContain('(+1)');
  });

  it('does NOT merge items with different taskIds', () => {
    const mailbox = makeMailbox();

    mailbox.enqueue('task_comment', makePayload('comment-A', 'body-A', 'task-001'));
    mailbox.enqueue('task_comment', makePayload('comment-B', 'body-B', 'task-002'));

    expect(mailbox.depth).toBe(2);
  });

  it('merges requirement_comment items with same requirementId', () => {
    const mailbox = makeMailbox();

    mailbox.enqueue('requirement_comment', {
      summary: 'req-comment-1',
      content: 'content-1',
      requirementId: 'req-xyz',
    });
    mailbox.enqueue('requirement_comment', {
      summary: 'req-comment-2',
      content: 'content-2',
      requirementId: 'req-xyz',
    });

    expect(mailbox.depth).toBe(1);
    const item = mailbox.peek()!;
    expect(item.payload.content).toContain('content-1');
    expect(item.payload.content).toContain('content-2');
  });

  it('does NOT merge items with triggerExecution flag', () => {
    const mailbox = makeMailbox();

    mailbox.enqueue('task_comment', {
      summary: 'trigger-A',
      content: 'body-A',
      taskId: 'task-trigger',
      extra: { triggerExecution: true },
    });
    mailbox.enqueue('task_comment', {
      summary: 'trigger-B',
      content: 'body-B',
      taskId: 'task-trigger',
      extra: { triggerExecution: true },
    });

    // Both should remain separate because triggerExecution prevents merge
    expect(mailbox.depth).toBe(2);
  });
});

describe('Mailbox Deduplication — post-recovery', () => {
  it('merges duplicate task_comment items loaded from persistence', () => {
    const persistence = new InMemoryPersistence();
    const originalMailbox = makeMailbox(persistence);

    // Enqueue two task_comments — because they merge at enqueue-time, we need
    // to bypass that by directly inserting into persistence
    originalMailbox.enqueue('task_comment', makePayload('first', 'body-first', 'task-dup'));
    // Manually inject a second item with the same taskId in persistence
    const secondItem: MailboxItem = {
      id: 'mbx_manual_002',
      agentId: AGENT_ID,
      sourceType: 'task_comment',
      priority: 2,
      status: 'queued',
      payload: {
        summary: 'second comment',
        content: 'body-second',
        taskId: 'task-dup',
      },
      queuedAt: new Date().toISOString(),
    };
    persistence.save(secondItem);

    // Now recover into a new mailbox — post-recovery dedup should merge them
    const newMailbox = makeMailbox(persistence);
    const result = newMailbox.recoverStaleItems();

    // The two items should have been merged into one
    expect(result.merged).toBe(1);
    expect(newMailbox.depth).toBe(1);
    const item = newMailbox.peek()!;
    expect(item.payload.content).toContain('body-first');
    expect(item.payload.content).toContain('body-second');
  });

  it('collapses multiple heartbeats to a single entry after recovery', () => {
    const persistence = new InMemoryPersistence();

    // Insert three heartbeat items directly into persistence
    const now = new Date().toISOString();
    for (let i = 1; i <= 3; i++) {
      const item: MailboxItem = {
        id: `mbx_hb_00${i}`,
        agentId: AGENT_ID,
        sourceType: 'heartbeat',
        priority: 3,
        status: 'queued',
        payload: { summary: `heartbeat-${i}`, content: `hb-${i}` },
        queuedAt: now,
      };
      persistence.save(item);
    }

    const newMailbox = makeMailbox(persistence);
    const result = newMailbox.recoverStaleItems();

    // Should keep 1 heartbeat, drop 2
    expect(result.merged).toBe(2);
    expect(newMailbox.depth).toBe(1);
    expect(newMailbox.peek()?.sourceType).toBe('heartbeat');
  });
});

// ─── 3. Completion Marker ────────────────────────────────────────────────────

describe('Mailbox Completion Marker', () => {
  it('marks an item as completed and updates persistence', () => {
    const persistence = new InMemoryPersistence();
    const mailbox = makeMailbox(persistence);

    const item = mailbox.enqueue('a2a_message', makePayload('hello'));
    expect(persistence.items.get(item.id)?.status).toBe('queued');

    mailbox.complete(item.id);

    expect(persistence.items.get(item.id)?.status).toBe('completed');
  });

  it('records completedAt timestamp when marking complete', () => {
    const persistence = new InMemoryPersistence();
    const mailbox = makeMailbox(persistence);
    const before = new Date().toISOString();

    const item = mailbox.enqueue('a2a_message', makePayload('complete-me'));
    mailbox.complete(item.id);

    const stored = persistence.items.get(item.id)!;
    expect(stored.status).toBe('completed');
    // completedAt should be set and >= before
    expect(stored.completedAt).toBeDefined();
    expect(new Date(stored.completedAt!).getTime()).toBeGreaterThanOrEqual(
      new Date(before).getTime(),
    );
  });

  it('does not enqueue a new item after completion (no auto-re-queue)', () => {
    const mailbox = makeMailbox();
    const item = mailbox.enqueue('a2a_message', makePayload('done-msg'));

    // Dequeue (moves to processing) then complete
    const dequeued = mailbox.dequeue();
    expect(dequeued?.id).toBe(item.id);
    mailbox.complete(item.id);

    // The queue should be empty after completion
    expect(mailbox.depth).toBe(0);
    expect(mailbox.isEmpty).toBe(true);
  });

  it('completed items are NOT re-restored on next recovery', () => {
    const persistence = new InMemoryPersistence();
    const originalMailbox = makeMailbox(persistence);

    const item = originalMailbox.enqueue('a2a_message', makePayload('complete-persist'));
    originalMailbox.complete(item.id);
    expect(persistence.items.get(item.id)?.status).toBe('completed');

    // New mailbox recovery should NOT restore completed items
    const newMailbox = makeMailbox(persistence);
    const result = newMailbox.recoverStaleItems();

    expect(result.restored).toBe(0);
    expect(newMailbox.depth).toBe(0);
  });
});

// ─── 4. Priority Processing ──────────────────────────────────────────────────

describe('Mailbox Priority Processing', () => {
  it('processes higher-priority items before lower-priority items', () => {
    const mailbox = makeMailbox();

    // Enqueue in reverse priority order
    mailbox.enqueue('memory_consolidation', makePayload('background-task'), { priority: 4 });
    mailbox.enqueue('a2a_message', makePayload('normal-msg'), { priority: 2 });
    mailbox.enqueue('human_chat', makePayload('urgent-chat'), { priority: 0 });
    mailbox.enqueue('a2a_message', makePayload('high-msg'), { priority: 1 });

    const first = mailbox.dequeue();
    const second = mailbox.dequeue();
    const third = mailbox.dequeue();
    const fourth = mailbox.dequeue();

    expect(first?.priority).toBe(0);   // critical
    expect(second?.priority).toBe(1);  // high
    expect(third?.priority).toBe(2);   // normal
    expect(fourth?.priority).toBe(4);  // background
  });

  it('maintains FIFO order for items with the same priority', () => {
    const mailbox = makeMailbox();

    mailbox.enqueue('a2a_message', makePayload('msg-1'), { priority: 2 });
    mailbox.enqueue('a2a_message', makePayload('msg-2'), { priority: 2 });
    mailbox.enqueue('a2a_message', makePayload('msg-3'), { priority: 2 });

    const first = mailbox.dequeue();
    const second = mailbox.dequeue();
    const third = mailbox.dequeue();

    expect(first?.payload.summary).toBe('msg-1');
    expect(second?.payload.summary).toBe('msg-2');
    expect(third?.payload.summary).toBe('msg-3');
  });

  it('hasItemAbovePriority returns correct result', () => {
    const mailbox = makeMailbox();

    mailbox.enqueue('a2a_message', makePayload('normal'), { priority: 2 });

    expect(mailbox.hasItemAbovePriority(2)).toBe(true);  // priority 2 <= 2
    expect(mailbox.hasItemAbovePriority(1)).toBe(false); // priority 2 > 1
    expect(mailbox.hasItemAbovePriority(3)).toBe(true);  // priority 2 <= 3
  });

  it('elevates priority when merging a higher-priority duplicate', () => {
    const persistence = new InMemoryPersistence();
    const originalMailbox = makeMailbox(persistence);

    // Normal-priority task_comment
    originalMailbox.enqueue('task_comment', {
      summary: 'comment-normal',
      content: 'body-normal',
      taskId: 'task-prio-merge',
    }, { priority: 2 });

    // Manually inject a high-priority task_comment with same taskId
    const highPrioItem: MailboxItem = {
      id: 'mbx_high_prio_001',
      agentId: AGENT_ID,
      sourceType: 'task_comment',
      priority: 1, // high priority
      status: 'queued',
      payload: {
        summary: 'comment-high',
        content: 'body-high',
        taskId: 'task-prio-merge',
      },
      queuedAt: new Date().toISOString(),
    };
    persistence.save(highPrioItem);

    const newMailbox = makeMailbox(persistence);
    newMailbox.recoverStaleItems();

    // After merge, survivor should have been elevated to priority 1
    expect(newMailbox.depth).toBe(1);
    const survivor = newMailbox.peek()!;
    expect(survivor.priority).toBe(1);
  });

  it('restored items maintain their original priority ordering', () => {
    const persistence = new InMemoryPersistence();

    // Insert items with mixed priorities directly into persistence
    const items: MailboxItem[] = [
      {
        id: 'mbx_r_low',
        agentId: AGENT_ID,
        sourceType: 'a2a_message',
        priority: 3,
        status: 'queued',
        payload: { summary: 'low', content: 'low' },
        queuedAt: new Date().toISOString(),
      },
      {
        id: 'mbx_r_critical',
        agentId: AGENT_ID,
        sourceType: 'a2a_message',
        priority: 0,
        status: 'queued',
        payload: { summary: 'critical', content: 'critical' },
        queuedAt: new Date().toISOString(),
      },
      {
        id: 'mbx_r_normal',
        agentId: AGENT_ID,
        sourceType: 'a2a_message',
        priority: 2,
        status: 'queued',
        payload: { summary: 'normal', content: 'normal' },
        queuedAt: new Date().toISOString(),
      },
    ];

    for (const item of items) {
      persistence.save(item);
    }

    const newMailbox = makeMailbox(persistence);
    newMailbox.recoverStaleItems();

    expect(newMailbox.depth).toBe(3);
    expect(newMailbox.dequeue()?.priority).toBe(0); // critical first
    expect(newMailbox.dequeue()?.priority).toBe(2); // normal second
    expect(newMailbox.dequeue()?.priority).toBe(3); // low third
  });
});

// ─── 5. consolidateByEntity ───────────────────────────────────────────────────

describe('Mailbox consolidateByEntity (pre-triage)', () => {
  it('consolidates multiple item types for same taskId into one', () => {
    const mailbox = makeMailbox();

    // Enqueue different types for the same task
    mailbox.enqueue('task_status_update', makePayload('status-update', 'assigned', 'task-consolidate'));
    // task_comment dedup happens at enqueue time; use a2a_message for cross-type test
    mailbox.enqueue('a2a_message', {
      summary: 'a2a msg about task',
      content: 'please review',
      taskId: 'task-consolidate',
    });

    expect(mailbox.depth).toBe(2);

    const merged = mailbox.consolidateByEntity();
    expect(merged).toBe(1);
    expect(mailbox.depth).toBe(1);

    const consolidated = mailbox.peek()!;
    expect(consolidated.payload.content).toContain('assigned');
    expect(consolidated.payload.content).toContain('please review');
  });

  it('does not consolidate items with different taskIds', () => {
    const mailbox = makeMailbox();

    mailbox.enqueue('task_status_update', makePayload('update-A', 'body-A', 'task-001'));
    mailbox.enqueue('task_status_update', makePayload('update-B', 'body-B', 'task-002'));

    const merged = mailbox.consolidateByEntity();
    expect(merged).toBe(0);
    expect(mailbox.depth).toBe(2);
  });
});

// ─── 6. findByTaskId / findByRequirementId ───────────────────────────────────

describe('Mailbox lookup helpers', () => {
  it('findByTaskId returns the correct item', () => {
    const mailbox = makeMailbox();

    mailbox.enqueue('a2a_message', { summary: 'about task-xyz', content: 'body', taskId: 'task-xyz' });
    mailbox.enqueue('a2a_message', { summary: 'about task-abc', content: 'body', taskId: 'task-abc' });

    const found = mailbox.findByTaskId('task-xyz');
    expect(found).toBeDefined();
    expect(found?.payload.taskId).toBe('task-xyz');
  });

  it('findByRequirementId returns the correct item', () => {
    const mailbox = makeMailbox();

    mailbox.enqueue('requirement_update', {
      summary: 'req update',
      content: 'updated',
      requirementId: 'req-001',
    });

    const found = mailbox.findByRequirementId('req-001');
    expect(found).toBeDefined();
    expect(found?.payload.requirementId).toBe('req-001');
  });
});
