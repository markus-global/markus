import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentMailbox, type MailboxPersistence } from '../src/mailbox.js';
import { EventBus } from '../src/events.js';
import type { MailboxItem, MailboxItemType, MailboxPayload } from '@markus/shared';
import { generateId } from '@markus/shared';

const mockEventBus = {
  emit: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  once: vi.fn(),
} as unknown as EventBus;

describe('AgentMailbox', () => {
  let mailbox: AgentMailbox;
  let mockPersistence: MailboxPersistence;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPersistence = {
      save: vi.fn(),
      updateStatus: vi.fn(),
      markStaleProcessingAsDropped: vi.fn().mockReturnValue(3),
    };
    mailbox = new AgentMailbox('test-agent', mockEventBus, mockPersistence);
  });

  describe('recoverStaleItems', () => {
    it('should call persistence.markStaleProcessingAsDropped and return count', () => {
      const result = mailbox.recoverStaleItems();
      expect(mockPersistence.markStaleProcessingAsDropped).toHaveBeenCalledWith('test-agent');
      expect(result).toBe(3);
    });

    it('should return 0 when persistence is not set', () => {
      const mailboxNoPersist = new AgentMailbox('test-agent', mockEventBus);
      const result = mailboxNoPersist.recoverStaleItems();
      expect(result).toBe(0);
    });
  });

  describe('enqueue and priority', () => {
    it('should enqueue item with default priority from registry', () => {
      const payload: MailboxPayload = { summary: 'test item', content: 'test content' };
      const item = mailbox.enqueue('human_chat', payload);
      
      expect(item).toBeDefined();
      expect(item.agentId).toBe('test-agent');
      expect(item.sourceType).toBe('human_chat');
      expect(item.status).toBe('queued');
      expect(item.priority).toBe(0); // human_chat has defaultPriority: 0
      expect(mockPersistence.save).toHaveBeenCalledWith(item);
    });

    it('should use custom priority when provided', () => {
      const payload: MailboxPayload = { summary: 'test item', content: 'test content' };
      const item = mailbox.enqueue('human_chat', payload, { priority: 3 });
      
      expect(item.priority).toBe(3);
    });

    it('should emit mailbox:new-item event on enqueue', () => {
      const payload: MailboxPayload = { summary: 'test item', content: 'test content' };
      mailbox.enqueue('human_chat', payload);
      
      expect(mockEventBus.emit).toHaveBeenCalledWith('mailbox:new-item', expect.objectContaining({
        agentId: 'test-agent',
      }));
    });
  });

  describe('queue operations', () => {
    it('should dequeue highest priority item', () => {
      const payload1: MailboxPayload = { summary: 'low priority', content: 'content1' };
      const payload2: MailboxPayload = { summary: 'high priority', content: 'content2' };
      
      mailbox.enqueue('system_event', payload1, { priority: 4 });
      mailbox.enqueue('task_comment', payload2, { priority: 0 });
      
      const item = mailbox.dequeue();
      
      expect(item?.sourceType).toBe('task_comment');
      expect(item?.status).toBe('processing');
      expect(mockPersistence.updateStatus).toHaveBeenCalled();
    });

    it('should return undefined when queue is empty', () => {
      const item = mailbox.dequeue();
      expect(item).toBeUndefined();
    });

    it('should complete item and update status', () => {
      const payload: MailboxPayload = { summary: 'test', content: 'content' };
      const item = mailbox.enqueue('human_chat', payload);
      
      mailbox.complete(item.id);
      
      expect(mockPersistence.updateStatus).toHaveBeenCalledWith(
        item.id,
        'completed',
        expect.objectContaining({ completedAt: expect.any(String) })
      );
    });

    it('should drop item from queue', () => {
      const payload: MailboxPayload = { summary: 'test', content: 'content' };
      const item = mailbox.enqueue('human_chat', payload);
      
      const dropped = mailbox.drop(item.id);
      
      expect(dropped).toBeDefined();
      expect(dropped?.status).toBe('dropped');
      expect(mailbox.depth).toBe(0);
      expect(mockPersistence.updateStatus).toHaveBeenCalledWith(item.id, 'dropped');
    });

    it('should return undefined when dropping non-existent item', () => {
      const dropped = mailbox.drop('non-existent-id');
      expect(dropped).toBeUndefined();
    });

    it('should defer item from queue', () => {
      const payload: MailboxPayload = { summary: 'test', content: 'content' };
      const item = mailbox.enqueue('human_chat', payload);
      
      const deferred = mailbox.defer(item.id, '2025-01-01T00:00:00Z');
      
      expect(deferred).toBeDefined();
      expect(deferred?.status).toBe('deferred');
      expect(deferred?.deferredUntil).toBe('2025-01-01T00:00:00Z');
      expect(mailbox.depth).toBe(0);
    });
  });

  describe('deduplication (tryMergeIntoExisting)', () => {
    it('should merge task_comment into existing queued item with same taskId', () => {
      const payload1: MailboxPayload = { 
        summary: 'first comment', 
        content: 'first content',
        taskId: 'tsk_123' 
      };
      const payload2: MailboxPayload = { 
        summary: 'second comment', 
        content: 'second content',
        taskId: 'tsk_123' 
      };
      
      mailbox.enqueue('task_comment', payload1);
      const merged = mailbox.enqueue('task_comment', payload2);
      
      expect(mailbox.depth).toBe(1);
      expect(merged?.payload.content).toContain('first content');
      expect(merged?.payload.content).toContain('second content');
      expect(merged?.payload.summary).toContain('(+1)');
    });

    it('should merge requirement_comment into existing queued item with same requirementId', () => {
      const payload1: MailboxPayload = { 
        summary: 'first req comment', 
        content: 'first content',
        requirementId: 'req_123' 
      };
      const payload2: MailboxPayload = { 
        summary: 'second req comment', 
        content: 'second content',
        requirementId: 'req_123' 
      };
      
      mailbox.enqueue('requirement_comment', payload1);
      const merged = mailbox.enqueue('requirement_comment', payload2);
      
      expect(mailbox.depth).toBe(1);
      expect(merged?.payload.content).toContain('first content');
      expect(merged?.payload.content).toContain('second content');
    });

    it('should NOT merge when taskId is different', () => {
      const payload1: MailboxPayload = { 
        summary: 'comment 1', 
        content: 'content1',
        taskId: 'tsk_123' 
      };
      const payload2: MailboxPayload = { 
        summary: 'comment 2', 
        content: 'content2',
        taskId: 'tsk_456' 
      };
      
      mailbox.enqueue('task_comment', payload1);
      mailbox.enqueue('task_comment', payload2);
      
      expect(mailbox.depth).toBe(2);
    });

    it('should NOT merge triggerExecution items', () => {
      const payload1: MailboxPayload = { 
        summary: 'normal', 
        content: 'content1',
        taskId: 'tsk_123' 
      };
      const payload2: MailboxPayload = { 
        summary: 'trigger', 
        content: 'content2',
        taskId: 'tsk_123',
        extra: { triggerExecution: true }
      };
      
      mailbox.enqueue('task_comment', payload1);
      mailbox.enqueue('task_comment', payload2);
      
      expect(mailbox.depth).toBe(2);
    });
  });

  describe('priority ordering', () => {
    it('should order items by priority (lower = higher)', () => {
      mailbox.enqueue('system_event', { summary: 'system', content: '' }, { priority: 2 });
      mailbox.enqueue('human_chat', { summary: 'chat', content: '' }, { priority: 0 });
      mailbox.enqueue('heartbeat', { summary: 'heartbeat', content: '' }, { priority: 4 });
      
      const item1 = mailbox.dequeue();
      expect(item1?.sourceType).toBe('human_chat'); // priority 0
      
      const item2 = mailbox.dequeue();
      expect(item2?.sourceType).toBe('system_event'); // priority 2
      
      const item3 = mailbox.dequeue();
      expect(item3?.sourceType).toBe('heartbeat'); // priority 4
    });
  });

  describe('findByTaskId / findByRequirementId', () => {
    it('should find item by taskId', () => {
      mailbox.enqueue('task_comment', { 
        summary: 'comment', 
        content: 'content',
        taskId: 'tsk_test123' 
      });
      
      const found = mailbox.findByTaskId('tsk_test123');
      expect(found).toBeDefined();
      expect(found?.payload.taskId).toBe('tsk_test123');
    });

    it('should find item by requirementId', () => {
      mailbox.enqueue('requirement_comment', { 
        summary: 'comment', 
        content: 'content',
        requirementId: 'req_test123' 
      });
      
      const found = mailbox.findByRequirementId('req_test123');
      expect(found).toBeDefined();
      expect(found?.payload.requirementId).toBe('req_test123');
    });
  });

  describe('resurface', () => {
    it('should resurface deferred item back to queue', () => {
      const payload: MailboxPayload = { summary: 'test', content: 'content' };
      const item = mailbox.enqueue('human_chat', payload);
      mailbox.defer(item.id);
      
      expect(mailbox.depth).toBe(0);
      
      mailbox.resurface(item);
      
      expect(mailbox.depth).toBe(1);
      expect(item.status).toBe('queued');
      expect(item.deferredUntil).toBeUndefined();
      expect(mockPersistence.updateStatus).toHaveBeenCalledWith(item.id, 'queued');
    });
  });

  describe('dropStatusUpdatesByTaskId', () => {
    it('should drop task_status_update items without triggerExecution', () => {
      // Simplified test: only test the core behavior
      mailbox.enqueue('task_status_update', {
        summary: 'status update without trigger',
        content: 'content1',
        taskId: 'tsk_123',
        extra: { triggerExecution: false }
      });
      
      const dropped = mailbox.dropStatusUpdatesByTaskId('tsk_123');
      
      expect(dropped).toBe(1);
      expect(mailbox.depth).toBe(0);
    });

    it('should NOT drop task_status_update items with triggerExecution', () => {
      mailbox.enqueue('task_status_update', {
        summary: 'status update with trigger', 
        content: 'content1',
        taskId: 'tsk_123',
        extra: { triggerExecution: true }
      });
      
      const dropped = mailbox.dropStatusUpdatesByTaskId('tsk_123');
      
      expect(dropped).toBe(0);
      expect(mailbox.depth).toBe(1);
    });
  });

  describe('getQueuedItems', () => {
    it('should return snapshot of queue', () => {
      mailbox.enqueue('human_chat', { summary: 'item1', content: 'c1' });
      mailbox.enqueue('system_event', { summary: 'item2', content: 'c2' });
      
      const items = mailbox.getQueuedItems();
      
      expect(items).toHaveLength(2);
      items.push({} as MailboxItem); // modify snapshot
      expect(mailbox.depth).toBe(2); // original queue unchanged
    });
  });

  describe('hasItemAbovePriority', () => {
    it('should return true when item priority <= threshold', () => {
      mailbox.enqueue('human_chat', { summary: 'high priority', content: '' }, { priority: 0 });
      
      expect(mailbox.hasItemAbovePriority(1)).toBe(true);
    });

    it('should return false when no items or all priorities > threshold', () => {
      expect(mailbox.hasItemAbovePriority(2)).toBe(false);
      
      mailbox.enqueue('heartbeat', { summary: 'low priority', content: '' }, { priority: 4 });
      expect(mailbox.hasItemAbovePriority(2)).toBe(false);
    });
  });

  describe('peek', () => {
    it('should return highest priority item without removing', () => {
      mailbox.enqueue('system_event', { summary: 'item2', content: '' }, { priority: 2 });
      mailbox.enqueue('human_chat', { summary: 'item1', content: '' }, { priority: 0 });
      
      const peeked = mailbox.peek();
      
      expect(peeked?.sourceType).toBe('human_chat');
      expect(mailbox.depth).toBe(2);
    });
  });
});
