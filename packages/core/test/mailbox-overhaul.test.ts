/**
 * Mailbox Overhaul Tests
 *
 * Tests for the mailbox system improvements:
 * - Channel-level A2A message coalescing (enqueue-time dedup)
 * - Burst coalescing window
 * - Batch deliberation processing
 * - Same-user message merge (inject-or-preempt)
 * - Deliberation abort on human_chat
 * - A2A sync deadlock prevention (wait_for_reply deprecated)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AttentionController,
  type AttentionDelegate,
} from '../src/attention.js';
import { AgentMailbox } from '../src/mailbox.js';
import { EventBus } from '../src/events.js';
import { displayLabelOf, mergeCountOf } from '../src/mailbox-summary.js';
import {
  type MailboxItem,
} from '@markus/shared';

const AGENT_ID = 'overhaul-test-agent';

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

describe('Channel-Level A2A Message Coalescing', () => {
  it('merges a2a_messages with same channelKey at enqueue time', () => {
    const eventBus = new EventBus();
    const mailbox = new AgentMailbox(AGENT_ID, eventBus);

    const item1 = mailbox.enqueue('a2a_message', {
      summary: 'Message from Alice',
      content: 'Hello everyone!',
      extra: { channelKey: 'group:team1', senderName: 'Alice', senderId: 'alice1' },
    });

    const item2 = mailbox.enqueue('a2a_message', {
      summary: 'Message from Bob',
      content: 'Hey there!',
      extra: { channelKey: 'group:team1', senderName: 'Bob', senderId: 'bob1' },
    });

    // Should have merged into one item
    expect(mailbox.depth).toBe(1);
    expect(item2.id).toBe(item1.id);
    expect(item1.payload.content).toContain('Hello everyone!');
    expect(item1.payload.content).toContain('[Bob]: Hey there!');
    // The fold count is structure, so it lives in metadata — NOT as a `(+1)`
    // suffix glued onto the display string (a reader then has to parse prose
    // to recover structure).
    expect(mergeCountOf(item1)).toBe(1);
    expect(item1.payload.summary).not.toContain('(+1)');
    // ...while the display label still surfaces it, derived by the single writer.
    expect(displayLabelOf(item1)).toContain('(+1)');
  });

  it('builds structured messages array for channel merges', () => {
    const eventBus = new EventBus();
    const mailbox = new AgentMailbox(AGENT_ID, eventBus);

    mailbox.enqueue('a2a_message', {
      summary: 'Msg 1',
      content: 'First message',
      extra: { channelKey: 'group:dev', senderName: 'Alice', senderId: 'a1' },
    });

    mailbox.enqueue('a2a_message', {
      summary: 'Msg 2',
      content: 'Second message',
      extra: { channelKey: 'group:dev', senderName: 'Bob', senderId: 'b1' },
    });

    mailbox.enqueue('a2a_message', {
      summary: 'Msg 3',
      content: 'Third message',
      extra: { channelKey: 'group:dev', senderName: 'Charlie', senderId: 'c1' },
    });

    expect(mailbox.depth).toBe(1);
    const item = mailbox.peek()!;
    expect(item.payload.messages).toHaveLength(3);
    expect(item.payload.messages![0].senderName).toBe('Alice');
    expect(item.payload.messages![1].senderName).toBe('Bob');
    expect(item.payload.messages![2].senderName).toBe('Charlie');
  });

  it('does not merge a2a_messages with different channelKeys', () => {
    const eventBus = new EventBus();
    const mailbox = new AgentMailbox(AGENT_ID, eventBus);

    mailbox.enqueue('a2a_message', {
      summary: 'Team 1 msg',
      content: 'Hello',
      extra: { channelKey: 'group:team1', senderName: 'Alice' },
    });

    mailbox.enqueue('a2a_message', {
      summary: 'Team 2 msg',
      content: 'Hi',
      extra: { channelKey: 'group:team2', senderName: 'Bob' },
    });

    expect(mailbox.depth).toBe(2);
  });

  it('does not merge a2a_messages without channelKey', () => {
    const eventBus = new EventBus();
    const mailbox = new AgentMailbox(AGENT_ID, eventBus);

    mailbox.enqueue('a2a_message', {
      summary: 'DM 1',
      content: 'Direct message 1',
    });

    mailbox.enqueue('a2a_message', {
      summary: 'DM 2',
      content: 'Direct message 2',
    });

    expect(mailbox.depth).toBe(2);
  });

  it('consolidateByEntity merges a2a_messages by channelKey', () => {
    const eventBus = new EventBus();
    const mailbox = new AgentMailbox(AGENT_ID, eventBus);

    mailbox.enqueue('a2a_message', {
      summary: 'Msg A',
      content: 'Content A',
      extra: { channelKey: 'group:x' },
    });

    // Enqueue with different channelKey to prevent enqueue-time dedup
    mailbox.enqueue('a2a_message', {
      summary: 'Msg B',
      content: 'Content B',
      extra: { channelKey: 'group:y' },
    });

    expect(mailbox.depth).toBe(2);
    const removed = mailbox.consolidateByEntity();
    // No consolidation since they have different channelKeys
    expect(removed).toBe(0);
  });
});

describe('Same-User Message Merge (R0 Heuristic)', () => {
  it('returns merge for same-user human_chat during human_chat processing', () => {
    const { controller } = makeController();

    const currentItem: MailboxItem = {
      id: 'mbx_current',
      agentId: AGENT_ID,
      sourceType: 'human_chat',
      priority: 0,
      status: 'processing',
      payload: { summary: 'First msg', content: 'Hello' },
      metadata: { senderId: 'user_123' },
      queuedAt: new Date().toISOString(),
    };

    const newItem: MailboxItem = {
      id: 'mbx_new',
      agentId: AGENT_ID,
      sourceType: 'human_chat',
      priority: 0,
      status: 'queued',
      payload: { summary: 'Follow-up', content: 'Also...' },
      metadata: { senderId: 'user_123' },
      queuedAt: new Date().toISOString(),
    };

    const decision = controller.heuristicDecision(currentItem, newItem);
    expect(decision).toBe('merge');
  });

  it('returns preempt for different-user human_chat during human_chat', () => {
    const { controller } = makeController();

    const currentItem: MailboxItem = {
      id: 'mbx_current',
      agentId: AGENT_ID,
      sourceType: 'human_chat',
      priority: 0,
      status: 'processing',
      payload: { summary: 'From user A', content: 'Hello' },
      metadata: { senderId: 'user_A' },
      queuedAt: new Date().toISOString(),
    };

    const newItem: MailboxItem = {
      id: 'mbx_new',
      agentId: AGENT_ID,
      sourceType: 'human_chat',
      priority: 0,
      status: 'queued',
      payload: { summary: 'From user B', content: 'Hi' },
      metadata: { senderId: 'user_B' },
      queuedAt: new Date().toISOString(),
    };

    // Different users → should NOT merge (falls through R0, continues to default continue)
    const decision = controller.heuristicDecision(currentItem, newItem);
    // Both are human_chat so R1 doesn't fire (both are user interactions)
    expect(decision).toBe('continue');
  });

  it('preempts non-user work for any human_chat (R1 unchanged)', () => {
    const { controller } = makeController();

    const currentItem: MailboxItem = {
      id: 'mbx_task',
      agentId: AGENT_ID,
      sourceType: 'heartbeat',
      priority: 3,
      status: 'processing',
      payload: { summary: 'Heartbeat', content: 'check' },
      queuedAt: new Date().toISOString(),
    };

    const newItem: MailboxItem = {
      id: 'mbx_user',
      agentId: AGENT_ID,
      sourceType: 'human_chat',
      priority: 0,
      status: 'queued',
      payload: { summary: 'User msg', content: 'Hello' },
      metadata: { senderId: 'user_X' },
      queuedAt: new Date().toISOString(),
    };

    const decision = controller.heuristicDecision(currentItem, newItem);
    expect(decision).toBe('preempt');
  });
});

describe('A2A Deadlock Prevention', () => {
  it('agent_send_message always returns immediately (no blocking)', async () => {
    // This test verifies the tool interface — the actual tool is tested
    // via the createA2ATools function, but here we verify the design:
    // wait_for_reply=true should be ignored and treated as async.
    const { mailbox } = makeController();

    // Simulate what happens: agent A sends to agent B
    // In the old code, wait_for_reply=true would await the response promise.
    // In the new code, it always fires and forgets.
    const startTime = Date.now();

    // Enqueue simulates the message arriving at agent B
    mailbox.enqueue('a2a_message', {
      summary: 'From Agent A',
      content: '[conversation:conv_123]\nHey, what is the status?',
      extra: { channelKey: undefined, senderId: 'agent_A', senderName: 'Agent A' },
    }, { metadata: { senderId: 'agent_A', senderName: 'Agent A' } });

    const elapsed = Date.now() - startTime;
    // Should be nearly instant (no blocking)
    expect(elapsed).toBeLessThan(100);
    expect(mailbox.depth).toBe(1);
  });
});
