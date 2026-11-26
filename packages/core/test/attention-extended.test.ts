import { describe, it, expect, vi } from 'vitest';
import {
  AttentionController,
  type AttentionDelegate,
} from '../src/attention.js';
import { AgentMailbox } from '../src/mailbox.js';
import { EventBus } from '../src/events.js';
import {
  type MailboxItem,
  type MailboxItemType,
  type MailboxPriority,
} from '@markus/shared';

const AGENT_ID = 'attn-ext-agent';

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

function makeController(delegateOverrides?: Partial<AttentionDelegate>) {
  const eventBus = new EventBus();
  const mailbox = new AgentMailbox(AGENT_ID, eventBus);
  const delegate: AttentionDelegate = {
    processMailboxItem: vi.fn().mockResolvedValue(`done`),
    onDecisionMade: vi.fn(),
    onFocusChanged: vi.fn(),
    evaluateInterrupt: vi.fn().mockResolvedValue('continue'),
    onTriageCompleted: vi.fn(),
    onDeliberationCompleted: vi.fn(),
    ...delegateOverrides,
  };
  const controller = new AttentionController(AGENT_ID, mailbox, eventBus);
  controller.setDelegate(delegate);
  return { controller, mailbox, delegate };
}

describe('AttentionController extended yield and deliberation', () => {
  it('checkYieldPoint returns merge when delegate chooses merge', async () => {
    const { controller, mailbox } = makeController({
      evaluateInterrupt: vi.fn(async () => 'merge'),
    });

    const current = makeItem({ sourceType: 'task_execution', id: 'focus_1' });
    const incoming = makeItem({ sourceType: 'task_comment', id: 'incoming_1' });
    mailbox.enqueue('task_comment', incoming.payload, { priority: 1 as MailboxPriority });

    controller['currentFocus'] = current;
    controller['state'] = 'focused';
    controller['interruptSignal'] = true;
    controller['pendingInterruptItem'] = incoming;

    const result = await controller.checkYieldPoint();
    expect(result.decision).toBe('merge');
  });

  it('checkYieldPoint returns defer and preempt decisions', async () => {
    const { controller, mailbox } = makeController({
      evaluateInterrupt: vi.fn()
        .mockResolvedValueOnce('defer')
        .mockResolvedValueOnce('preempt'),
    });

    const current = makeItem({ sourceType: 'a2a_message' });
    const incoming = makeItem({ sourceType: 'human_chat', priority: 0 as MailboxPriority });
    mailbox.enqueue('human_chat', incoming.payload, { priority: 0 as MailboxPriority });

    controller['currentFocus'] = current;
    controller['state'] = 'focused';
    controller['interruptSignal'] = true;
    controller['pendingInterruptItem'] = incoming;

    expect((await controller.checkYieldPoint()).decision).toBe('defer');

    controller['interruptSignal'] = true;
    controller['pendingInterruptItem'] = incoming;
    expect((await controller.checkYieldPoint()).decision).toBe('preempt');
    expect(controller['lastYieldDecision']).toBe('preempt');
  });

  it('checkYieldPoint returns cancel decision', async () => {
    const { controller } = makeController({
      evaluateInterrupt: vi.fn(async () => 'cancel'),
    });
    const current = makeItem({ sourceType: 'heartbeat' });
    const incoming = makeItem({ sourceType: 'human_chat', priority: 0 as MailboxPriority });

    controller['currentFocus'] = current;
    controller['state'] = 'focused';
    controller['interruptSignal'] = true;
    controller['pendingInterruptItem'] = incoming;

    const result = await controller.checkYieldPoint();
    expect(result.decision).toBe('cancel');
    expect(controller['lastYieldDecision']).toBe('cancel');
  });

});

describe('AttentionController heuristic edge cases', () => {
  it('heuristicDecision defers same-priority non-user items', () => {
    const { controller } = makeController();
    const current = makeItem({ sourceType: 'a2a_message', priority: 2 as MailboxPriority });
    const incoming = makeItem({ sourceType: 'a2a_message', priority: 2 as MailboxPriority });
    expect(controller['heuristicDecision'](current, incoming)).toBe('continue');
  });
});
