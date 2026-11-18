import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent } from '../src/agent.js';
import type { LLMRouter } from '../src/llm/router.js';
import type { RoleTemplate } from '@markus/shared';
import type { MailboxItem } from '@markus/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Forever Loop (M5) — a rest window that EXPIRES must wake the agent.
 *
 * Root cause this locks down: the `trigger-expiry` clock source only dropped the
 * subscription and emitted `trigger:expired` onto a bus with no consumer. Once the periodic
 * heartbeat machinery and the wakeup sweep were deleted there was **no periodic wake source
 * left at all**, so an agent following the LOOP CONTRACT (`rest` when the queue is empty) went
 * permanently silent — the matching half (`wakeForTriggerMatch`) delivered a turn, the expiring
 * half delivered nothing.
 *
 * The invariant is therefore symmetric: *matched* ⇒ one wake item, *expired* ⇒ one wake
 * item. Both ride the mailbox, so the wake turn has a stated reason instead of having to
 * infer it.
 *
 * These assertions are red before the fix: the sweep enqueues nothing, so `depth` stays 0.
 */

let tempDir: string;

const MOCK_ROLE: RoleTemplate = {
  id: 'fe-lock-rest-expiry-role',
  name: 'Rest Expiry Role',
  description: 'Forever Loop regression: rest(timeoutMs) expiry must wake',
  category: 'engineering',
  systemPrompt: 'You are a rest-expiry test agent.',
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
      id: 'fe-lock-rest-agent',
      name: 'Rest Expiry Agent',
      roleId: 'worker',
      llmConfig: { modelMode: 'custom', primary: 'anthropic' },
      createdAt: new Date().toISOString(),
    } as never,
    role: MOCK_ROLE,
    llmRouter: makeMockRouter(),
    dataDir: tempDir,
  });
}

interface ClockShape {
  tick(at?: number): void;
  getStatus(): { sources: Array<{ name: string }> };
}

function clockOf(agent: Agent): ClockShape {
  return (agent as unknown as { clock: ClockShape }).clock;
}

/** Items whose payload marks them as a trigger-generated wake. */
function wakeItems(agent: Agent): MailboxItem[] {
  return agent.getMailbox().getQueuedItems()
    .filter(i => i.payload?.extra?.['triggerWake'] === true);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-fe-lock-rest-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('rest(timeoutMs) expiry delivers a real wake (B1)', () => {
  it('the trigger-expiry clock source is mounted on the single AgentClock', async () => {
    const agent = createAgent();
    await agent.start();
    const names = clockOf(agent).getStatus().sources.map(s => s.name);
    expect(names).toContain('trigger-expiry');
    await agent.stop();
  });

  it('an expired wait enqueues exactly one system_event with triggerWake + the subscription id', async () => {
    const agent = createAgent();
    await agent.start();

    const sub = agent.restOn({ wakeOn: { kind: 'mailbox-any' }, timeoutMs: 1 });
    await sleep(10); // let it expire (real clock, 1ms TTL)

    const before = agent.getMailbox().depth;
    // Drive the ONE clock source synchronously — this is the production path, so
    // removing the enqueue (or the clock source) from the sweep turns this red.
    clockOf(agent).tick(Date.now() + 10 * 60_000);

    const items = agent.getMailbox().getQueuedItems();
    expect(agent.getMailbox().depth).toBe(before + 1);

    const wake = items.filter(i => i.payload?.extra?.['triggerWake'] === true);
    expect(wake).toHaveLength(1);
    expect(wake[0].sourceType).toBe('system_event');
    expect(wake[0].payload.extra?.['expiredSubscriptionId']).toBe(sub.id);
    // The reason must be legible in the turn text, not only in structured fields.
    expect(String(wake[0].payload.content)).toContain('expire');

    // The wait is over: no live subscription left, so it can never wake twice.
    expect(agent.getSubscriptions()).toHaveLength(0);
    await agent.stop();
  });

  it('a live (not yet expired) wait produces no wake row', async () => {
    const agent = createAgent();
    await agent.start();

    agent.restOn({ wakeOn: { kind: 'mailbox-any' }, timeoutMs: 3_600_000 });
    const before = agent.getMailbox().depth;
    clockOf(agent).tick(Date.now() + 60_000);

    expect(wakeItems(agent)).toHaveLength(0);
    expect(agent.getMailbox().depth).toBe(before);
    expect(agent.getSubscriptions()).toHaveLength(1);
    await agent.stop();
  });

  it('the same expiry is not re-delivered on the next tick (one wake per wait)', async () => {
    const agent = createAgent();
    await agent.start();

    agent.restOn({ wakeOn: { kind: 'mailbox-any' }, timeoutMs: 1 });
    await sleep(10);

    const clock = clockOf(agent);
    clock.tick(Date.now() + 10 * 60_000);
    const afterFirst = wakeItems(agent).length;

    clock.tick(Date.now() + 20 * 60_000);
    expect(wakeItems(agent).length).toBe(afterFirst);
    expect(afterFirst).toBe(1);
    await agent.stop();
  });
});
