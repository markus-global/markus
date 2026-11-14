import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent } from '../src/agent.js';
import { TriggerRegistry, matchesWakeCondition } from '../src/trigger.js';
import type { TriggerEvent } from '../src/trigger.js';
import type { LLMRouter } from '../src/llm/router.js';
import type { RoleTemplate } from '@markus/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * C8-C — `rest(wakeOn)`: wait for a real event, never poll.
 *
 * Contract (docs/records/cut8-c-single-clock-design-2026-11-14.md §3.4):
 *   · matching is a pure predicate over an event that already exists;
 *   · a subscription owns NO timer (registering N waits adds 0 timers);
 *   · expiry is swept by the agent's clock source (reported, not swallowed);
 *   · `rest` registers exactly one subscription and answers machine-readably;
 *   · a matching mailbox item fires `trigger:matched` once, a non-matching one never.
 *
 * Red before the change: neither the module nor the tool exists.
 */

let tempDir: string;

const MOCK_ROLE: RoleTemplate = {
  id: 'c8c-trigger-role',
  name: 'C8C Trigger Role',
  description: 'C8-C regression: rest(wakeOn) / subscriptions',
  category: 'engineering',
  systemPrompt: 'You are a C8-C trigger test agent.',
  defaultSkills: [],
  heartbeatChecklist: '- Check inbox',
  defaultPolicies: [],
  builtIn: false,
};

function makeMockRouter(): LLMRouter {
  return {
    chat: vi.fn(async () => ({ content: 'ok', finishReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } })),
    chatStream: vi.fn(async () => ({ content: 'ok', finishReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } })),
    getActiveModelContextWindow: () => 200000,
    getActiveModelName: () => 'test-model',
    getActiveModelMaxOutput: () => 8000,
    getModelContextWindow: () => 200000,
    getModelMaxOutput: () => 8000,
    getModelCost: () => undefined,
    isCompactionSupported: () => true,
    modelSupportsVision: () => false,
    listProviders: () => ['test'],
    getProvider: () => undefined,
    getDefaultProvider: () => 'test',
    defaultProviderName: 'test',
    resolveModalityCandidates: vi.fn(() => []),
  } as unknown as LLMRouter;
}

function createAgent(): Agent {
  return new Agent({
    config: {
      id: 'c8c-trigger-agent',
      name: 'C8C Trigger Agent',
      roleId: 'worker',
      llmConfig: { modelMode: 'custom', primary: 'anthropic' },
      createdAt: new Date().toISOString(),
    } as never,
    role: MOCK_ROLE,
    llmRouter: makeMockRouter(),
    dataDir: tempDir,
  });
}

function event(sourceType: TriggerEvent['sourceType'], itemId = 'mbx-1'): TriggerEvent {
  return { type: 'mailbox:new-item', agentId: 'a1', sourceType, itemId };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-c8c-trigger-'));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('matchesWakeCondition (pure)', () => {
  it('mailbox-type matches only that type', () => {
    const cond = { kind: 'mailbox-type', sourceType: 'human_chat' } as const;
    expect(matchesWakeCondition(cond, event('human_chat'))).toBe(true);
    expect(matchesWakeCondition(cond, event('task_status_update'))).toBe(false);
  });

  it('mailbox-any matches any mailbox item', () => {
    expect(matchesWakeCondition({ kind: 'mailbox-any' }, event('review_request'))).toBe(true);
    expect(matchesWakeCondition({ kind: 'mailbox-any' }, event('human_chat'))).toBe(true);
  });

  it('ignores non-mailbox events', () => {
    const other = { type: 'clock:tick', agentId: 'a1', sourceType: 'human_chat', itemId: 'x' } as unknown as TriggerEvent;
    expect(matchesWakeCondition({ kind: 'mailbox-any' }, other)).toBe(false);
  });
});

describe('TriggerRegistry — match, once, expire (no timers)', () => {
  it('fires once by default and reports the match', () => {
    const reg = new TriggerRegistry(() => 1000);
    const sub = reg.subscribe({ agentId: 'a1', wakeOn: { kind: 'mailbox-type', sourceType: 'human_chat' } });

    const first = reg.dispatch(event('human_chat'));
    expect(first.map(s => s.id)).toEqual([sub.id]);

    // One-shot: the same condition never fires twice.
    expect(reg.dispatch(event('human_chat'))).toEqual([]);
    expect(reg.size()).toBe(0);
  });

  it('stays subscribed while once=false', () => {
    const reg = new TriggerRegistry(() => 1000);
    reg.subscribe({ agentId: 'a1', wakeOn: { kind: 'mailbox-any' }, once: false });
    expect(reg.dispatch(event('human_chat'))).toHaveLength(1);
    expect(reg.dispatch(event('task_status_update'))).toHaveLength(1);
  });

  it('never fires for another agent', () => {
    const reg = new TriggerRegistry(() => 1000);
    reg.subscribe({ agentId: 'a1', wakeOn: { kind: 'mailbox-any' } });
    const foreign = { ...event('human_chat'), agentId: 'a2' };
    expect(reg.dispatch(foreign)).toEqual([]);
  });

  it('sweepExpired drops and reports expired waits', () => {
    let now = 1000;
    const reg = new TriggerRegistry(() => now);
    const sub = reg.subscribe({ agentId: 'a1', wakeOn: { kind: 'mailbox-any' }, timeoutMs: 500 });

    now = 1600;
    const expired = reg.sweepExpired();
    expect(expired.map(s => s.id)).toEqual([sub.id]);
    expect(reg.size()).toBe(0);
    // A wait that expired must not match afterwards.
    expect(reg.dispatch(event('human_chat'))).toEqual([]);
  });

  it('registering subscriptions creates no timer at all', () => {
    vi.useFakeTimers();
    const reg = new TriggerRegistry();
    for (let i = 0; i < 25; i++) {
      reg.subscribe({ agentId: 'a1', wakeOn: { kind: 'mailbox-type', sourceType: 'human_chat' } });
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('rest(wakeOn) tool on a live Agent', () => {
  it('registers exactly one subscription and answers machine-readably', async () => {
    const agent = createAgent();
    const rest = agent.getTools().get('rest');
    expect(rest).toBeDefined();

    const out = JSON.parse(await rest!.execute({
      wakeOn: { kind: 'mailbox-type', sourceType: 'task_status_update' },
      note: 'waiting for the review of C8-C',
    })) as Record<string, unknown>;

    expect(out['status']).toBe('resting');
    expect(out['wakeOn']).toEqual({ kind: 'mailbox-type', sourceType: 'task_status_update' });
    expect(typeof out['subscriptionId']).toBe('string');
    expect(out['note']).toBe('waiting for the review of C8-C');
    expect(agent.getSubscriptions()).toHaveLength(1);
  });

  it('rejects an unusable condition instead of claiming to rest', async () => {
    const agent = createAgent();
    const rest = agent.getTools().get('rest')!;
    const out = JSON.parse(await rest.execute({ wakeOn: { kind: 'bogus' } })) as Record<string, unknown>;
    expect(out['status']).toBe('error');
    expect(agent.getSubscriptions()).toHaveLength(0);
  });

  it('a matching mailbox item fires trigger:matched once, a non-matching one never', async () => {
    const agent = createAgent();
    const rest = agent.getTools().get('rest')!;
    await rest.execute({ wakeOn: { kind: 'mailbox-type', sourceType: 'task_status_update' } });

    const matched: unknown[] = [];
    agent.getEventBus().on('trigger:matched', e => matched.push(e));

    agent.enqueueToMailbox('human_chat', { summary: 'unrelated', content: 'hi' });
    expect(matched).toHaveLength(0);

    agent.enqueueToMailbox('task_status_update', { summary: 'review ready', content: 'go' });
    expect(matched).toHaveLength(1);
    expect(matched[0]).toMatchObject({ agentId: 'c8c-trigger-agent' });

    // One-shot: no second wake from a second matching item.
    agent.enqueueToMailbox('task_status_update', { summary: 'again', content: 'go' });
    expect(matched).toHaveLength(1);
    expect(agent.getSubscriptions()).toHaveLength(0);
  });

  it('list_waits shows the wait and cancel_wait removes it', async () => {
    const agent = createAgent();
    const rest = agent.getTools().get('rest')!;
    const list = agent.getTools().get('list_waits')!;
    const cancel = agent.getTools().get('cancel_wait')!;

    const created = JSON.parse(await rest.execute({ wakeOn: { kind: 'mailbox-any' } })) as Record<string, unknown>;

    const listed = JSON.parse(await list.execute({})) as { waits: Array<{ subscriptionId: string }> };
    expect(listed.waits).toHaveLength(1);

    const cancelled = JSON.parse(await cancel.execute({ subscriptionId: created['subscriptionId'] })) as Record<string, unknown>;
    expect(cancelled['status']).toBe('cancelled');
    expect(agent.getSubscriptions()).toHaveLength(0);
  });
});
