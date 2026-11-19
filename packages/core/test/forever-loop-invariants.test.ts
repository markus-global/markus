import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { routeMailboxItem } from '@markus/shared';
import type { MailboxItem, RoleTemplate } from '@markus/shared';
import { Agent } from '../src/agent.js';
import type { LLMRouter } from '../src/llm/router.js';
import { resolveTarget } from '../src/session-target.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

/**
 * Forever Loop (M5/M6) — the invariants that survived the cut, re-asserted on the NEW
 * mechanism.
 *
 * Three guards were deleted together with the mechanisms they tested
 * (`heartbeat-single-clock`, `heartbeat-no-mailbox-row`, `dream-single-trigger`). Deleting a
 * mechanism is not deleting its invariant: V1 ("a beat is not a message"), the single-clock
 * rule ("no timer outside AgentClock") and "dream has exactly one producer" all still have
 * to hold, otherwise the refactor is only as good as its last hotfix. These tests state them
 * against the implementation that exists now.
 */

let tempDir: string;

const MOCK_ROLE: RoleTemplate = {
  id: 'fe-lock-invariants-role',
  name: 'Forever Loop Invariants',
  description: 'Forever Loop regression: surviving invariants',
  category: 'engineering',
  systemPrompt: 'You are an invariants test agent.',
  defaultSkills: [],
  heartbeatChecklist: '- Check inbox',
  defaultPolicies: [],
  builtIn: false,
};

function makeMockRouter(): LLMRouter {
  return {
    chat: vi.fn(async () => ({ content: 'HEARTBEAT_OK', finishReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } })),
    chatStream: vi.fn(async () => ({ content: 'HEARTBEAT_OK', finishReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } })),
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
      id: 'fe-lock-invariants-agent',
      name: 'Invariants Agent',
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
const clockOf = (a: Agent) => (a as unknown as { clock: ClockShape }).clock;
const flush = () => new Promise(r => setTimeout(r, 0));
const wakeItems = (a: Agent) =>
  a.getMailbox().getQueuedItems().filter(i => i.payload?.extra?.['triggerWake'] === true);

beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'markus-fe-lock-inv-')); });
afterEach(() => { vi.restoreAllMocks(); rmSync(tempDir, { recursive: true, force: true }); });

describe('single clock — AgentClock is the only periodic driver (M6)', () => {
  it('start() mounts exactly two time-driven sources and arms exactly one interval', async () => {
    const agent = createAgent();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    await agent.start();

    // Time-driven transitions get one runtime owner; adding a third source is a design
    // decision, not a local convenience.
    expect(clockOf(agent).getStatus().sources.map(s => s.name).sort())
      .toEqual(['mailbox-maintenance', 'trigger-expiry']);

    // The second interval in the process is the attention watchdog (turn liveness), not a
    // transition driver. What must never come back is a timer PER WAIT: declaring N waits
    // adds zero timers (the old heartbeat/`wakeup-sweep` shape).
    const timersAfterStart = setIntervalSpy.mock.calls.length;
    for (let i = 0; i < 5; i += 1) {
      agent.restOn({ wakeOn: { kind: 'mailbox-any' }, timeoutMs: 3_600_000 });
    }
    expect(setIntervalSpy.mock.calls.length).toBe(timersAfterStart);
    await agent.stop();
  });
});

describe('a heart beat is a liveness tick, not a message (V1)', () => {
  it('a patrol produces zero `heartbeat` mailbox rows', async () => {
    const agent = createAgent();
    const before = agent.getMailbox().getQueuedItems().length;

    agent.triggerHeartbeat();
    await flush();

    const heartbeatRows = agent.getMailbox().getQueuedItems()
      .filter(i => i.sourceType === 'heartbeat');
    expect(heartbeatRows).toHaveLength(0);
    // Nothing else may be invented by a beat either: a tick that enqueues work turns the
    // "idle" state into a loop that feeds itself.
    expect(agent.getMailbox().getQueuedItems().length).toBe(before);
  });
});

describe('dream has exactly one producer (M5)', () => {
  it('`rest` triggers one dream tick; the expiry sweep triggers none', async () => {
    const agent = createAgent();
    const dreamSpy = vi.spyOn(agent as unknown as { consolidateMemory: () => Promise<unknown> }, 'consolidateMemory');

    agent.restOn({ wakeOn: { kind: 'mailbox-any' }, timeoutMs: 1 });
    await flush();
    // A call count, not a symbol check: rest must be the ONE producer.
    expect(dreamSpy).toHaveBeenCalledTimes(1);

    await new Promise(r => setTimeout(r, 10)); // let the wait expire
    clockOf(agent).tick(Date.now() + 10 * 60_000);
    await flush();

    // The expiry sweep delivers a wake; a second dream producer there would make
    // "不睡不整理" into "醒来又整理一次" — the same double-writer disease.
    expect(dreamSpy).toHaveBeenCalledTimes(1);
  });

  it('a second rest in the same dream window does not run a second dream', async () => {
    const agent = createAgent();
    const runSpy = vi.spyOn(
      agent as unknown as { dreamConsolidateMemory: (...a: never[]) => Promise<void> },
      'dreamConsolidateMemory',
    );
    // Force "due": the guard reads typed entry count + buffer pressure.
    const mem = agent.getMemory() as unknown as {
      getObservations: () => unknown[];
      getMemoryHealth: () => { observationPercent: number };
      getDreamRecord?: () => unknown;
    };
    vi.spyOn(mem, 'getObservations').mockReturnValue(
      Array.from({ length: 40 }, (_, i) => ({ id: `o${i}`, timestamp: new Date().toISOString(), type: 'fact', content: `entry ${i}` })),
    );
    vi.spyOn(mem, 'getMemoryHealth').mockReturnValue({ observationPercent: 99 });

    agent.restOn({ wakeOn: { kind: 'mailbox-any' }, timeoutMs: 3_600_000 });
    await new Promise(r => setTimeout(r, 50));
    agent.restOn({ wakeOn: { kind: 'mailbox-any' }, timeoutMs: 3_600_000 });
    await new Promise(r => setTimeout(r, 50));

    expect(runSpy.mock.calls.length).toBeLessThanOrEqual(1);
    expect(runSpy.mock.calls.length).toBe(1);
  });
});

describe('an expiry wake is a turn the agent can rest from again (B2)', () => {
  it('the wake item is an LLM turn and its text tells the agent to rest again', async () => {
    const agent = createAgent();
    await agent.start();
    agent.restOn({ wakeOn: { kind: 'mailbox-any' }, timeoutMs: 1 });
    await new Promise(r => setTimeout(r, 10));
    clockOf(agent).tick(Date.now() + 10 * 60_000);

    const wake = wakeItems(agent)[0] as MailboxItem;
    expect(wake).toBeDefined();
    // A wake that does not schedule a turn is a log line with extra steps.
    expect(routeMailboxItem(wake).invokesLLM).toBe(true);
    // The turn must be able to re-declare the wait, or "wake up" is a one-way door.
    expect(String(wake.payload.content)).toMatch(/rest/i);
    expect(agent.getTools().has('rest')).toBe(true);
    await agent.stop();
  });

  it('the LOOP CONTRACT names the expiry wake and the re-rest step', () => {
    // The rest tool alone is not enough: the contract is what the model reads when it is
    // awake with nothing to do. Removing the paragraph must make this red.
    const src = readFileSync(join(__dirname, '..', 'src', 'context-engine.ts'), 'utf8');
    expect(src).toContain('[REST EXPIRED]');
    expect(src).toMatch(/再 `rest` 一次/);
    expect(src).toContain('等于这个 agent 从此静默');
  });
});

describe('a DM has one routing decision (M1/B3)', () => {
  it('the same DM key resolves to the same session on every delivery', () => {
    const dm = 'dm:a2a:agt_a:agt_b';
    const first = resolveTarget({ sourceType: 'a2a_message', agentId: 'agt_b', conversationId: dm, channelSessionId: dm, ts: 1_000 });
    const second = resolveTarget({ sourceType: 'a2a_message', agentId: 'agt_b', conversationId: dm, channelSessionId: dm, ts: 9_999_999 });
    expect(first!.sessionId).toBe(dm);
    expect(second!.sessionId).toBe(first!.sessionId);
  });

  it('agent-manager has no fallback path that manufactures a session from a timestamp', () => {
    // Both historical bypasses (`sys_<sender>_<ts>`, `a2a_<target>_<ts>`) built a fresh
    // session per delivery = the "a2a amnesia" defect. Assert on the source: re-adding one
    // must turn this red, and the routing must go through the import below.
    const src = readFileSync(join(__dirname, '..', 'src', 'agent-manager.ts'), 'utf8');
    expect(src).not.toMatch(/sessionId:\s*`sys_\$\{[^}]+\}_\$\{Date\.now\(\)\}`/);
    expect(src).not.toMatch(/sessionId:\s*`a2a_\$\{[^}]+\}_\$\{Date\.now\(\)\}`/);
    expect(src).toContain("import { loopSessionId, resolveTarget } from './session-target.js'");
    expect(src).toContain('sessionId: routed?.sessionId ?? loopSessionId(targetId)');
    expect(src).toContain('sessionId: loopSessionId(envelope.to)');
  });
});
