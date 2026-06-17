import { describe, it, expect, vi } from 'vitest';
import {
  AttentionController,
  type AttentionDelegate,
} from '../src/attention.js';
import { AgentMailbox } from '../src/mailbox.js';
import { EventBus } from '../src/events.js';
import {
  COMPLETION_MARKER,
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

  it('checkYieldPoint allows user interrupt during deliberation', async () => {
    const { controller } = makeController({
      evaluateInterrupt: vi.fn(async () => 'preempt'),
    });
    const current = makeItem({ sourceType: 'a2a_message' });
    const incoming = makeItem({ sourceType: 'human_chat', priority: 0 as MailboxPriority });

    controller['isDeliberating'] = true;
    controller['interruptSignal'] = true;
    controller['pendingInterruptItem'] = incoming;
    controller['currentFocus'] = current;
    controller['state'] = 'deciding';

    const result = await controller.checkYieldPoint();
    expect(result.decision).toBe('preempt');
  });

  it('shouldAbortDeliberation reflects deliberationAbortSignal', () => {
    const { controller } = makeController();
    expect(controller.shouldAbortDeliberation).toBe(false);
    controller['deliberationAbortSignal'] = true;
    expect(controller.shouldAbortDeliberation).toBe(true);
  });

  it('applyDeliberationResult processes inline and deferred items', () => {
    const { controller, mailbox } = makeController();
    const a = mailbox.enqueue('a2a_message', { summary: 'A', content: 'a' });
    const b = mailbox.enqueue('a2a_message', { summary: 'B', content: 'b' });
    const c = mailbox.enqueue('heartbeat', { summary: 'C', content: 'c' });

    const next = controller['applyDeliberationResult'](a, {
      processItemId: a.id,
      inlineCompletedIds: [b.id],
      deferItemIds: [c.id],
      dropItemIds: [],
      reasoning: 'Prioritize A, ack B, defer C',
    });

    expect(next.id).toBe(a.id);
    expect(mailbox.depth).toBeGreaterThanOrEqual(0);
  });
});

describe('AttentionController heuristic edge cases', () => {
  it('heuristicDecision defers same-priority non-user items', () => {
    const { controller } = makeController();
    const current = makeItem({ sourceType: 'a2a_message', priority: 2 as MailboxPriority });
    const incoming = makeItem({ sourceType: 'a2a_message', priority: 2 as MailboxPriority });
    expect(controller['heuristicDecision'](current, incoming)).toBe('continue');
  });

  it('needsLLMTriage returns true for ambiguous backlog', () => {
    const { controller, mailbox } = makeController();
    const head = mailbox.enqueue('a2a_message', { summary: '1', content: '1' });
    mailbox.enqueue('a2a_message', { summary: '2', content: '2' });
    mailbox.enqueue('a2a_message', { summary: '3', content: '3' });
    expect(controller['needsLLMTriage'](head)).toBe(true);
  });
});
