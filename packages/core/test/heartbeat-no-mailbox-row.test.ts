import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent } from '../src/agent.js';
import type { LLMRouter } from '../src/llm/router.js';
import type { RoleTemplate } from '@markus/shared';
import { TRIAGE_STALE_DROP_TYPES } from '@markus/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * C8-C — a heartbeat is a liveness TICK, not a message.
 *
 * Contract (docs/records/cut8-c-single-clock-design-2026-11-14.md §3.2):
 *   · clock mode  → N triggers produce 0 `heartbeat` mailbox rows, N patrol runs.
 *   · legacy mode → N triggers produce N rows (rollback channel kept intact).
 *   · dream cleanup must not be droppable by the queue-ageing path (§3.3).
 *
 * Red before the change: today every trigger enqueues a `heartbeat` row.
 */

let tempDir: string;

const MOCK_ROLE: RoleTemplate = {
  id: 'c8c-role',
  name: 'C8C Single Clock Role',
  description: 'C8-C regression: heartbeat tick vs mailbox row',
  category: 'engineering',
  systemPrompt: 'You are a C8-C test agent.',
  defaultSkills: [],
  heartbeatChecklist: '- Check inbox',
  defaultPolicies: [],
  builtIn: false,
};

function makeMockRouter(): LLMRouter {
  return {
    chat: vi.fn(async () => ({
      content: 'HEARTBEAT_OK',
      finishReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5 },
    })),
    chatStream: vi.fn(async () => ({
      content: 'HEARTBEAT_OK',
      finishReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5 },
    })),
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

function createAgent() {
  return new Agent({
    config: {
      id: 'c8c-agent',
      name: 'C8C Agent',
      roleId: 'worker',
      llmConfig: { modelMode: 'custom', primary: 'anthropic' },
      createdAt: new Date().toISOString(),
    } as never,
    role: MOCK_ROLE,
    llmRouter: makeMockRouter(),
    dataDir: tempDir,
  });
}

/** Let the fire-and-forget patrol run (it is async by design). */
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-c8c-hb-'));
});

afterEach(() => {
  delete process.env['MARKUS_HEARTBEAT_CLOCK'];
  rmSync(tempDir, { recursive: true, force: true });
});

describe('heartbeat produces no mailbox rows (C8-C)', () => {
  it('clock mode: N triggers → 0 heartbeat rows, N patrols', async () => {
    const agent = createAgent();
    const enqueue = vi.spyOn(agent.getMailbox(), 'enqueue');
    const patrol = vi
      .spyOn(agent as unknown as { handleHeartbeat: () => Promise<string> }, 'handleHeartbeat')
      .mockResolvedValue('patrol');

    agent.triggerHeartbeat();
    await flush();
    agent.triggerHeartbeat();
    await flush();
    agent.triggerHeartbeat();
    await flush();

    const heartbeatRows = enqueue.mock.calls.filter(c => c[0] === 'heartbeat');
    expect(heartbeatRows).toHaveLength(0);
    expect(patrol).toHaveBeenCalledTimes(3);
  });

  it('clock mode: a re-entrant trigger never overlaps two patrols', async () => {
    const agent = createAgent();
    let release: (v: string) => void = () => {};
    const patrol = vi
      .spyOn(agent as unknown as { handleHeartbeat: () => Promise<string> }, 'handleHeartbeat')
      .mockImplementation(() => new Promise<string>(resolve => { release = resolve; }));

    agent.triggerHeartbeat();
    agent.triggerHeartbeat(); // previous patrol still in flight → skipped
    expect(patrol).toHaveBeenCalledTimes(1);

    release('done');
    await flush();
    agent.triggerHeartbeat();
    expect(patrol).toHaveBeenCalledTimes(2);
  });

  it('legacy mode: rows still produced (channel rollback works alone)', async () => {
    process.env['MARKUS_HEARTBEAT_CLOCK'] = 'legacy';
    const agent = createAgent();
    const enqueue = vi.spyOn(agent.getMailbox(), 'enqueue');

    agent.triggerHeartbeat();
    await flush();

    expect(enqueue.mock.calls.filter(c => c[0] === 'heartbeat')).toHaveLength(1);
  });
});

// NOTE (C8-C boundary): `memory_consolidation` being removed from
// `TRIAGE_STALE_DROP_TYPES` is owned by C8-A — that dispatch table has exactly one writer
// and it is not this cut. The assertion lives there; see
// docs/records/cut8-c-single-clock-design-2026-11-14.md §4.
void TRIAGE_STALE_DROP_TYPES;
