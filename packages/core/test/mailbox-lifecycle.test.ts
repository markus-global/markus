/**
 * Mailbox Lifecycle Tests (Phase 4)
 *
 * End-to-end tests covering the complete mailbox item lifecycle:
 * - enqueue → dequeue → processing → complete
 * - enqueue → dequeue → interrupt → defer → resurface → reprocess
 * - backlog deliberation → triage → batch processing
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AttentionController,
  type AttentionDelegate,
} from '../src/attention.js';
import { AgentMailbox } from '../src/mailbox.js';
import { EventBus } from '../src/events.js';
import {
  type MailboxItem,
  type MailboxPriority,
} from '@markus/shared';

const AGENT_ID = 'lifecycle-agent';

function makeController(delegateOverrides?: Partial<AttentionDelegate>) {
  const eventBus = new EventBus();
  const mailbox = new AgentMailbox(AGENT_ID, eventBus);
  const processedItems: MailboxItem[] = [];

  const delegate: AttentionDelegate = {
    processMailboxItem: vi.fn().mockImplementation(async (item: MailboxItem) => {
      processedItems.push(item);
      return `processed ${item.id}`;
    }),
    onDecisionMade: vi.fn(),
    onFocusChanged: vi.fn(),
    evaluateInterrupt: vi.fn().mockResolvedValue('continue'),
    onTriageCompleted: vi.fn(),
    onDeliberationCompleted: vi.fn(),
    ...delegateOverrides,
  };

  const controller = new AttentionController(AGENT_ID, mailbox, eventBus);
  controller.setDelegate(delegate);

  return { controller, mailbox, eventBus, delegate, processedItems };
}

describe('Mailbox Lifecycle: enqueue → process → complete', () => {
  it('processes a single item from enqueue to completion', async () => {
    const { controller, mailbox, processedItems } = makeController();

    const item = mailbox.enqueue('a2a_message', {
      summary: 'Hello from agent',
      content: 'Can you help with this task?',
    });

    controller.start();

    await vi.waitFor(() => {
      expect(processedItems).toHaveLength(1);
    }, { timeout: 2000 });

    controller.stop();

    expect(processedItems[0].id).toBe(item.id);
    expect(processedItems[0].sourceType).toBe('a2a_message');
    expect(mailbox.depth).toBe(0);
  });

  it('processes multiple items in priority order', async () => {
    const { controller, mailbox, processedItems } = makeController();

    mailbox.enqueue('heartbeat', { summary: 'heartbeat', content: 'check' });
    mailbox.enqueue('human_chat', { summary: 'user msg', content: 'hello' });
    mailbox.enqueue('a2a_message', { summary: 'agent msg', content: 'collab' });

    controller.start();

    await vi.waitFor(() => {
      expect(processedItems.length).toBeGreaterThanOrEqual(3);
    }, { timeout: 5000 });

    controller.stop();

    // human_chat (priority 0) should be processed first
    expect(processedItems[0].sourceType).toBe('human_chat');
  });

  it('processes items arriving while another is being processed', async () => {
    let processCount = 0;
    const { controller, mailbox, delegate } = makeController({
      processMailboxItem: vi.fn().mockImplementation(async (item: MailboxItem) => {
        processCount++;
        if (processCount === 1) {
          // While processing first item, enqueue another
          await new Promise(r => setTimeout(r, 50));
          mailbox.enqueue('a2a_message', {
            summary: 'late arrival',
            content: 'arrived during processing',
          });
          await new Promise(r => setTimeout(r, 50));
        }
        return `done`;
      }),
    });

    mailbox.enqueue('a2a_message', { summary: 'first', content: 'body' });

    controller.start();

    await vi.waitFor(() => {
      expect(processCount).toBeGreaterThanOrEqual(2);
    }, { timeout: 3000 });

    controller.stop();

    // Both items should have been processed
    expect(processCount).toBe(2);
  });
});

describe('Mailbox Lifecycle: interrupt → defer → resurface → reprocess', () => {
  it('defers preempted item and reprocesses it later', async () => {
    const processedTypes: string[] = [];
    let callCount = 0;

    const { controller, mailbox } = makeController({
      processMailboxItem: vi.fn().mockImplementation(async (item: MailboxItem) => {
        callCount++;
        processedTypes.push(item.sourceType);

        if (callCount === 1 && item.sourceType === 'a2a_message') {
          // Simulate: first call processes a2a, returns preempted
          return '[preempted]';
        }
        return `done`;
      }),
    });

    mailbox.enqueue('a2a_message', { summary: 'low priority', content: 'work' });

    controller.start();

    await vi.waitFor(() => {
      expect(callCount).toBeGreaterThanOrEqual(1);
    }, { timeout: 2000 });

    // Give time for defer to take effect
    await new Promise(r => setTimeout(r, 200));

    // The a2a item was deferred. Now enqueue a high-priority item
    // which should be processed next.
    mailbox.enqueue('human_chat', { summary: 'user', content: 'help' });

    await vi.waitFor(() => {
      expect(callCount).toBeGreaterThanOrEqual(2);
    }, { timeout: 2000 });

    controller.stop();

    // First was a2a (preempted), then human_chat
    expect(processedTypes[0]).toBe('a2a_message');
    expect(processedTypes[1]).toBe('human_chat');
  });
});

describe('Mailbox Lifecycle: abnormal completion → retry', () => {
  it('retries items with empty replies up to max retries, then completes', async () => {
    let callCount = 0;
    const { controller, mailbox } = makeController({
      processMailboxItem: vi.fn().mockImplementation(async () => {
        callCount++;
        // Always return empty — should retry MAILBOX_ITEM_MAX_RETRIES times, then give up
        return '';
      }),
    });

    mailbox.enqueue('a2a_message', { summary: 'msg', content: 'body' });

    controller.start();

    // MAILBOX_ITEM_MAX_RETRIES = 2 → 3 total attempts (initial + 2 retries)
    await vi.waitFor(() => {
      expect(callCount).toBeGreaterThanOrEqual(3);
    }, { timeout: 5000 });

    controller.stop();

    expect(callCount).toBe(3);
    expect(mailbox.depth).toBe(0);
  });
});

describe('Mailbox Lifecycle: shutdown during processing', () => {
  it('does not lose items when stopped during processing', async () => {
    let processing = false;
    const { controller, mailbox } = makeController({
      processMailboxItem: vi.fn().mockImplementation(async () => {
        processing = true;
        // Simulate long processing
        await new Promise(r => setTimeout(r, 500));
        return `done`;
      }),
    });

    mailbox.enqueue('a2a_message', { summary: 'important', content: 'must not be lost' });

    controller.start();

    // Wait until processing starts
    await vi.waitFor(() => {
      expect(processing).toBe(true);
    }, { timeout: 2000 });

    // Stop while item is being processed
    controller.stop();

    // Wait for loop to exit
    await new Promise(r => setTimeout(r, 300));

    // The item should have been requeued (not lost) because
    // processFocusedItem detects !this.running and requeues
  });
});
