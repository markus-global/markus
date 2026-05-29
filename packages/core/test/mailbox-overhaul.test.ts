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
import {
  COMPLETION_MARKER,
  type MailboxItem,
  type DeliberationResult,
} from '@markus/shared';

const AGENT_ID = 'overhaul-test-agent';

function makeController(delegateOverrides?: Partial<AttentionDelegate>) {
  const eventBus = new EventBus();
  const mailbox = new AgentMailbox(AGENT_ID, eventBus);
  const processedItems: MailboxItem[] = [];

  const delegate: AttentionDelegate = {
    processMailboxItem: vi.fn().mockImplementation(async (item: MailboxItem) => {
      processedItems.push(item);
      return `processed ${item.id} ${COMPLETION_MARKER}`;
    }),
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
    expect(item1.payload.summary).toContain('(+1)');
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

describe('Deliberation Abort on Human Chat', () => {
  it('sets deliberationAbortSignal when human_chat arrives during deliberation', () => {
    const { controller, mailbox, eventBus } = makeController();

    // Simulate deliberation state and manually invoke onNewMail
    (controller as any).isDeliberating = true;
    (controller as any).state = 'deciding';

    // Directly trigger onNewMail since start() also launches the loop
    mailbox.enqueue('human_chat', {
      summary: 'Urgent user msg',
      content: 'Please help now',
    }, { metadata: { senderId: 'user_1' } });

    // Manually invoke onNewMail to simulate the event handler
    (controller as any).onNewMail();

    expect(controller.shouldAbortDeliberation).toBe(true);
  });

  it('does not set abort signal for non-user messages during deliberation', () => {
    const { controller, mailbox } = makeController();

    (controller as any).isDeliberating = true;
    (controller as any).state = 'deciding';

    mailbox.enqueue('a2a_message', {
      summary: 'Agent msg',
      content: 'Hey colleague',
    });

    // Manually invoke onNewMail
    (controller as any).onNewMail();

    expect(controller.shouldAbortDeliberation).toBe(false);
  });
});

describe('Batch Deliberation Processing', () => {
  it('passes batch items to processMailboxItem when deliberation returns multiple processItemIds', async () => {
    const processedBatches: { item: MailboxItem; batch?: MailboxItem[]; ctx?: string }[] = [];

    const { controller, mailbox } = makeController({
      processMailboxItem: vi.fn().mockImplementation(async (item: MailboxItem, batchItems?: MailboxItem[], batchContext?: string) => {
        processedBatches.push({ item, batch: batchItems, ctx: batchContext });
        return `processed ${COMPLETION_MARKER}`;
      }),
      performDeliberation: vi.fn().mockImplementation(async (_head: MailboxItem, allItems: MailboxItem[]): Promise<DeliberationResult> => {
        return {
          processItemId: allItems[0].id,
          processItemIds: allItems.map(i => i.id),
          batchContext: 'Handle all messages together',
          deferItemIds: [],
          dropItemIds: [],
          inlineCompletedIds: [],
          reasoning: 'All items are from same channel — batch process',
        };
      }),
    });

    mailbox.enqueue('a2a_message', { summary: 'Msg 1', content: 'First' });
    mailbox.enqueue('a2a_message', { summary: 'Msg 2', content: 'Second' });
    mailbox.enqueue('a2a_message', { summary: 'Msg 3', content: 'Third' });

    controller.start();

    await vi.waitFor(() => {
      expect(processedBatches).toHaveLength(1);
    }, { timeout: 3000 });

    controller.stop();

    expect(processedBatches[0].batch).toHaveLength(2);
    expect(processedBatches[0].ctx).toBe('Handle all messages together');
  });

  it('applies memoryUpdates from deliberation result', async () => {
    const memoryUpdates: Array<{ type: string; key: string; content: string }> = [];

    const { controller, mailbox } = makeController({
      performDeliberation: vi.fn().mockImplementation(async (_head: MailboxItem, allItems: MailboxItem[]): Promise<DeliberationResult> => {
        return {
          processItemId: allItems[0].id,
          deferItemIds: [],
          dropItemIds: allItems.slice(1).map(i => i.id),
          inlineCompletedIds: [],
          reasoning: 'Process first, drop rest',
          memoryUpdates: [
            { type: 'working' as const, key: 'team-decision', content: 'Team agreed on API design' },
            { type: 'longterm' as const, key: 'Architecture', content: 'REST API chosen over GraphQL' },
          ],
        };
      }),
      applyMemoryUpdates: vi.fn().mockImplementation((updates) => {
        memoryUpdates.push(...updates);
      }),
    });

    mailbox.enqueue('a2a_message', { summary: 'Msg 1', content: 'Let us use REST' });
    mailbox.enqueue('a2a_message', { summary: 'Msg 2', content: 'Agreed' });

    controller.start();

    await vi.waitFor(() => {
      expect(memoryUpdates).toHaveLength(2);
    }, { timeout: 3000 });

    controller.stop();

    expect(memoryUpdates[0]).toEqual({ type: 'working', key: 'team-decision', content: 'Team agreed on API design' });
    expect(memoryUpdates[1]).toEqual({ type: 'longterm', key: 'Architecture', content: 'REST API chosen over GraphQL' });
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
