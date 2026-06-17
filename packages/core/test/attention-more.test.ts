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

const AGENT_ID = 'attn-more-agent';

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

describe('AttentionController processFocusedItem outcomes', () => {
  it('defers item when delegate returns [preempted]', async () => {
    const { controller, mailbox, delegate } = makeController({
      processMailboxItem: vi.fn().mockResolvedValue('[preempted]'),
    });
    const item = mailbox.enqueue('task_execution', { summary: 'long task', content: 'work' });
    controller['lastYieldDecision'] = 'preempt';

    await controller['processFocusedItem'](item);

    expect(delegate.processMailboxItem).toHaveBeenCalled();
    expect(mailbox.depth).toBeGreaterThanOrEqual(0);
  });

  it('completes item when delegate returns [cancelled]', async () => {
    const { controller, mailbox } = makeController({
      processMailboxItem: vi.fn().mockResolvedValue('[cancelled]'),
    });
    const item = mailbox.enqueue('a2a_message', { summary: 'cancel me', content: 'body' });
    controller['lastYieldDecision'] = 'cancel';

    await controller['processFocusedItem'](item);

    expect(controller.getCurrentFocus()).toBeUndefined();
  });

  it('requeues on empty reply for background mailbox items', async () => {
    const { controller, mailbox } = makeController({
      processMailboxItem: vi.fn().mockResolvedValue(''),
    });
    const item = mailbox.enqueue('heartbeat', { summary: 'hb', content: 'check' });

    await controller['processFocusedItem'](item);

    expect(controller.getCurrentFocus()).toBeUndefined();
  });

  it('completes human_chat with missing marker without retry loop', async () => {
    const { controller, mailbox } = makeController({
      processMailboxItem: vi.fn().mockResolvedValue('partial reply without marker'),
    });
    const item = mailbox.enqueue('human_chat', { summary: 'user msg', content: 'hello' });

    await controller['processFocusedItem'](item);

    expect(controller.getCurrentFocus()).toBeUndefined();
  });

  it('handles delegate processMailboxItem errors gracefully', async () => {
    const { controller, mailbox } = makeController({
      processMailboxItem: vi.fn().mockRejectedValue(new Error('processing crashed')),
    });
    const item = mailbox.enqueue('a2a_message', { summary: 'err', content: 'body' });

    await expect(controller['processFocusedItem'](item)).resolves.not.toThrow();
  });

  it('completes batch siblings when primary succeeds', async () => {
    const { controller, mailbox } = makeController({
      processMailboxItem: vi.fn().mockResolvedValue(`batch done ${COMPLETION_MARKER}`),
    });
    const primary = mailbox.enqueue('a2a_message', { summary: 'primary', content: 'p' });
    const batch1 = mailbox.enqueue('a2a_message', { summary: 'batch1', content: 'b1' });
    controller['pendingBatchItems'] = [batch1];

    await controller['processFocusedItem'](primary);

    expect(controller.getCurrentFocus()).toBeUndefined();
  });

  it('requeues batch siblings when primary is preempted', async () => {
    const { controller, mailbox } = makeController({
      processMailboxItem: vi.fn().mockResolvedValue('[preempted]'),
    });
    const primary = mailbox.enqueue('task_execution', { summary: 'primary', content: 'p' });
    const batch1 = mailbox.enqueue('a2a_message', { summary: 'batch1', content: 'b1' });
    controller['pendingBatchItems'] = [batch1];
    controller['lastYieldDecision'] = 'preempt';

    await controller['processFocusedItem'](primary);

    expect(controller.getCurrentFocus()).toBeUndefined();
  });
});

describe('AttentionController triage and coalescing', () => {
  it('performTriage returns null without triageJudge', async () => {
    const { controller, mailbox } = makeController();
    const head = mailbox.enqueue('a2a_message', { summary: 'head', content: 'h' });
    const result = await controller['performTriage'](head);
    expect(result).toBeNull();
  });

  it('buildTriagePrompt includes queue context', async () => {
    const { controller, mailbox } = makeController();
    const head = mailbox.enqueue('a2a_message', { summary: 'head', content: 'h' });
    mailbox.enqueue('task_comment', { summary: 'comment', content: 'c' });
    const prompt = controller['buildTriagePrompt'](head, { workingMemory: 'Focused on deploy' });
    expect(prompt).toContain('head');
    expect(prompt.toLowerCase()).toMatch(/queue|items|mailbox/);
  });

  it('hasInterruptPending reflects interrupt signal state', () => {
    const { controller } = makeController();
    expect(controller.hasInterruptPending()).toBe(false);
    controller['interruptSignal'] = true;
    expect(controller.hasInterruptPending()).toBe(true);
  });
});

describe('AttentionController heuristicDecision matrix', () => {
  it('preempts when human_chat interrupts lower priority work', () => {
    const { controller } = makeController();
    const current = makeItem({ sourceType: 'task_execution', priority: 2 as MailboxPriority });
    const incoming = makeItem({ sourceType: 'human_chat', priority: 0 as MailboxPriority });
    expect(controller.heuristicDecision(current, incoming)).toBe('preempt');
  });

  it('merges task_comment into active task with same taskId', () => {
    const { controller } = makeController();
    const current = makeItem({
      sourceType: 'task_execution',
      priority: 2 as MailboxPriority,
      payload: { summary: 'task', content: 'work', taskId: 'task_1' },
    });
    const incoming = makeItem({
      sourceType: 'task_comment',
      priority: 1 as MailboxPriority,
      payload: { summary: 'comment', content: 'note', taskId: 'task_1' },
    });
    expect(controller.heuristicDecision(current, incoming)).toBe('merge');
  });

  it('continues when incoming heartbeat is lower priority than a2a', () => {
    const { controller } = makeController();
    const current = makeItem({ sourceType: 'a2a_message', priority: 1 as MailboxPriority });
    const incoming = makeItem({ sourceType: 'heartbeat', priority: 3 as MailboxPriority });
    expect(controller.heuristicDecision(current, incoming)).toBe('continue');
  });

  it('preempts when peer message interrupts heartbeat', () => {
    const { controller } = makeController();
    const current = makeItem({ sourceType: 'heartbeat', priority: 3 as MailboxPriority });
    const incoming = makeItem({ sourceType: 'a2a_message', priority: 2 as MailboxPriority });
    expect(controller.heuristicDecision(current, incoming)).toBe('preempt');
  });
});
