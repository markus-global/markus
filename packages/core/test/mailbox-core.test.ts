import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentMailbox, MailboxCancelledError } from '../src/mailbox.js';
import { EventBus } from '../src/events.js';
import type { MailboxItem, MailboxPriority } from '@markus/shared';

const AGENT_ID = 'mailbox-core-agent';

function makeMailbox(persistence?: Parameters<typeof AgentMailbox.prototype.setPersistence>[0]) {
  const eventBus = new EventBus();
  const mailbox = new AgentMailbox(AGENT_ID, eventBus, persistence);
  return { mailbox, eventBus };
}

describe('AgentMailbox queue operations', () => {
  it('dequeues items in priority order (lower number first)', () => {
    const { mailbox } = makeMailbox();
    mailbox.enqueue('heartbeat', { summary: 'hb', content: 'check' }, { priority: 3 as MailboxPriority });
    mailbox.enqueue('human_chat', { summary: 'user', content: 'help' }, { priority: 0 as MailboxPriority });
    mailbox.enqueue('a2a_message', { summary: 'peer', content: 'hi' }, { priority: 2 as MailboxPriority });

    expect(mailbox.dequeue()?.sourceType).toBe('human_chat');
    expect(mailbox.dequeue()?.sourceType).toBe('a2a_message');
    expect(mailbox.dequeue()?.sourceType).toBe('heartbeat');
    expect(mailbox.isEmpty).toBe(true);
  });

  it('peek returns head without removing', () => {
    const { mailbox } = makeMailbox();
    mailbox.enqueue('a2a_message', { summary: 'msg', content: 'body' });
    const peeked = mailbox.peek();
    expect(peeked?.payload.summary).toBe('msg');
    expect(mailbox.depth).toBe(1);
  });

  it('complete marks item as completed via persistence', () => {
    const updateStatus = vi.fn();
    const { mailbox } = makeMailbox({
      save: vi.fn(),
      updateStatus,
    });

    const item = mailbox.enqueue('a2a_message', { summary: 'msg', content: 'body' });
    mailbox.dequeue();
    mailbox.complete(item.id);

    expect(updateStatus).toHaveBeenCalledWith(item.id, 'completed', expect.any(Object));
  });

  it('defer and resurface requeue deferred items', () => {
    const updateStatus = vi.fn();
    const { mailbox } = makeMailbox({
      save: vi.fn(),
      updateStatus,
      loadDeferred: vi.fn(() => []),
    });

    const item = mailbox.enqueue('a2a_message', { summary: 'msg', content: 'body' });
    mailbox.defer(item.id);
    expect(mailbox.depth).toBe(0);

    const deferred = mailbox.defer(item.id);
    expect(deferred).toBeUndefined();

    mailbox.resurface({ ...item, status: 'deferred' });
    expect(mailbox.depth).toBe(1);
  });

  it('drop removes item from queue', () => {
    const { mailbox } = makeMailbox({ save: vi.fn(), updateStatus: vi.fn() });
    const item = mailbox.enqueue('task_status_update', { summary: 'update', content: 'done' });
    const dropped = mailbox.drop(item.id);
    expect(dropped?.id).toBe(item.id);
    expect(mailbox.depth).toBe(0);
  });

  it('merge combines payload into target item', () => {
    const { mailbox } = makeMailbox({ save: vi.fn(), updateStatus: vi.fn() });
    const target = mailbox.enqueue('task_comment', {
      summary: 'comment',
      content: 'First comment',
      taskId: 'task_1',
    });
    const incoming = mailbox.enqueue('task_comment', {
      summary: 'more',
      content: 'Second comment',
      taskId: 'task_2',
    });

    const merged = mailbox.merge(incoming.id, target.id);
    expect(merged?.payload.content).toContain('Second comment');
    expect(mailbox.depth).toBe(1);
  });

  it('requeue and putBack restore items to queue', () => {
    const { mailbox } = makeMailbox({ save: vi.fn(), updateStatus: vi.fn() });
    const item = mailbox.enqueue('a2a_message', { summary: 'msg', content: 'body' });
    const dequeued = mailbox.dequeue()!;
    mailbox.requeue(dequeued);
    expect(mailbox.depth).toBe(1);

    const again = mailbox.dequeue()!;
    mailbox.putBack(again);
    expect(mailbox.peek()?.id).toBe(item.id);
  });

  it('dequeueById removes specific item', () => {
    const { mailbox } = makeMailbox();
    const a = mailbox.enqueue('a2a_message', { summary: 'a', content: 'A' });
    mailbox.enqueue('a2a_message', { summary: 'b', content: 'B' });
    const found = mailbox.dequeueById(a.id);
    expect(found?.id).toBe(a.id);
    expect(mailbox.depth).toBe(1);
  });

  it('updatePriority re-sorts queue', () => {
    const { mailbox } = makeMailbox({ save: vi.fn(), updateStatus: vi.fn() });
    const low = mailbox.enqueue('a2a_message', { summary: 'low', content: 'L' }, { priority: 3 as MailboxPriority });
    mailbox.enqueue('heartbeat', { summary: 'hb', content: 'H' }, { priority: 3 as MailboxPriority });

    expect(mailbox.updatePriority(low.id, 0)).toBe(true);
    expect(mailbox.dequeue()?.id).toBe(low.id);
  });

  it('findByTaskId and findByRequirementId locate queued items', () => {
    const { mailbox } = makeMailbox();
    mailbox.enqueue('task_comment', { summary: 'c', content: 'C', taskId: 'task_99' });
    mailbox.enqueue('requirement_comment', { summary: 'r', content: 'R', requirementId: 'req_42' });

    expect(mailbox.findByTaskId('task_99')?.payload.taskId).toBe('task_99');
    expect(mailbox.findByRequirementId('req_42')?.payload.requirementId).toBe('req_42');
  });

  it('hasItemAbovePriority detects higher-priority queued items', () => {
    const { mailbox } = makeMailbox();
    mailbox.enqueue('a2a_message', { summary: 'msg', content: 'body' }, { priority: 2 as MailboxPriority });
    expect(mailbox.hasItemAbovePriority(3 as MailboxPriority)).toBe(true);
    expect(mailbox.hasItemAbovePriority(1 as MailboxPriority)).toBe(false);
  });

  it('dropStatusUpdatesByTaskId removes matching status updates', () => {
    const { mailbox } = makeMailbox({ save: vi.fn(), updateStatus: vi.fn() });
    mailbox.enqueue('task_status_update', { summary: 's1', content: 'c1', taskId: 'task_x' });
    mailbox.enqueue('task_status_update', { summary: 's2', content: 'c2', taskId: 'task_x' });
    mailbox.enqueue('task_status_update', { summary: 's3', content: 'c3', taskId: 'task_y' });

    expect(mailbox.dropStatusUpdatesByTaskId('task_x')).toBe(2);
    expect(mailbox.depth).toBe(1);
  });
});

describe('AgentMailbox async and persistence', () => {
  it('dequeueAsync resolves when item is enqueued', async () => {
    const { mailbox } = makeMailbox();
    const waitPromise = mailbox.dequeueAsync();
    setTimeout(() => {
      mailbox.enqueue('a2a_message', { summary: 'async', content: 'body' });
    }, 20);

    const item = await waitPromise;
    expect(item.payload.summary).toBe('async');
  });

  it('dequeueAsync throws MailboxCancelledError on cancelWait', async () => {
    const { mailbox } = makeMailbox();
    const waitPromise = mailbox.dequeueAsync();
    mailbox.cancelWait();

    await expect(waitPromise).rejects.toBeInstanceOf(MailboxCancelledError);
  });

  it('recoverStaleItems restores queued items and drops expired ones', () => {
    const oldQueuedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const freshQueuedAt = new Date().toISOString();

    const staleItem: MailboxItem = {
      id: 'mbx_stale',
      agentId: AGENT_ID,
      sourceType: 'heartbeat',
      priority: 3 as MailboxPriority,
      status: 'queued',
      payload: { summary: 'old hb', content: 'expired' },
      queuedAt: oldQueuedAt,
    };
    const freshItem: MailboxItem = {
      id: 'mbx_fresh',
      agentId: AGENT_ID,
      sourceType: 'a2a_message',
      priority: 2 as MailboxPriority,
      status: 'queued',
      payload: { summary: 'fresh', content: 'restore me' },
      queuedAt: freshQueuedAt,
    };

    const updateStatus = vi.fn();
    const { mailbox } = makeMailbox({
      save: vi.fn(),
      updateStatus,
      markStaleProcessingAsDropped: vi.fn(() => 2),
      loadQueued: vi.fn(() => [staleItem, freshItem]),
    });

    const result = mailbox.recoverStaleItems();
    expect(result.dropped).toBe(2);
    expect(result.expired).toBe(1);
    expect(result.restored).toBe(1);
    expect(mailbox.depth).toBe(1);
    expect(updateStatus).toHaveBeenCalledWith('mbx_stale', 'dropped');
  });

  it('cleanStaleProcessing delegates to persistence', () => {
    const markCompleted = vi.fn(() => 3);
    const { mailbox } = makeMailbox({
      save: vi.fn(),
      updateStatus: vi.fn(),
      markStaleProcessingAsCompleted: markCompleted,
    });

    expect(mailbox.cleanStaleProcessing()).toBe(3);
    expect(markCompleted).toHaveBeenCalledWith(AGENT_ID);
  });

  it('emits mailbox:new-item on enqueue', () => {
    const { mailbox, eventBus } = makeMailbox();
    const handler = vi.fn();
    eventBus.on('mailbox:new-item', handler);

    mailbox.enqueue('human_chat', { summary: 'hello', content: 'world' });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ agentId: AGENT_ID }));
  });
});
