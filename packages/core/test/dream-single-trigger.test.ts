import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent } from '../src/agent.js';
import type { LLMRouter } from '../src/llm/router.js';
import type { RoleTemplate } from '@markus/shared';
import { TRIAGE_STALE_DROP_TYPES } from '@markus/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * C8-C — the dream must have exactly ONE trigger.
 *
 * Contract (docs/records/cut8-c-single-clock-design-2026-11-14.md §3.3):
 *   · the named clock source `memory-consolidation` is the only producer of a dream,
 *     and emits `dream:trigger` exactly once per due tick (1:1 with the schedule);
 *   · `ran` distinguishes "due and ran" from "due but deduped in this window";
 *   · `memory_consolidation` is NOT in `TRIAGE_STALE_DROP_TYPES` — a maintenance job
 *     must never be discarded by the queue-ageing path;
 *   · a legacy `memory_consolidation` mailbox row does not replay a dream in clock mode
 *     (that would be a second writer of the same decision).
 *
 * Red before the change: no `dream:trigger` event exists, the type is droppable, and a
 * mailbox row runs an extra LLM turn.
 */

let tempDir: string;

const MOCK_ROLE: RoleTemplate = {
  id: 'c8c-dream-role',
  name: 'C8C Dream Role',
  description: 'C8-C regression: single dream trigger',
  category: 'engineering',
  systemPrompt: 'You are a C8-C dream test agent.',
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

type AgentInternals = {
  clock: { tick(at?: number): void; getStatus(): { sources: Array<{ name: string }> } };
  memory: { getMemoryHealth(): { observationPercent: number }; getObservations(): unknown[]; getLastConsolidatedAt?: () => string | null; markConsolidated?: () => void };
  scheduleConsolidationTimer(): void;
  dreamConsolidateMemory(entries: unknown): Promise<void>;
  processMailboxItemCore(item: unknown): Promise<string | void>;
};

function createAgent(): { agent: Agent; internals: AgentInternals } {
  const agent = new Agent({
    config: {
      id: 'c8c-dream-agent',
      name: 'C8C Dream Agent',
      roleId: 'worker',
      llmConfig: { modelMode: 'custom', primary: 'anthropic' },
      createdAt: new Date().toISOString(),
    } as never,
    role: MOCK_ROLE,
    llmRouter: makeMockRouter(),
    dataDir: tempDir,
  });
  return { agent, internals: agent as unknown as AgentInternals };
}

/** Pressure the buffer so `shouldRunDreamCycle` returns true, without an LLM. */
function pressurise(internals: AgentInternals) {
  vi.spyOn(internals.memory, 'getMemoryHealth').mockReturnValue({
    observationPercent: 100,
    entries: 1,
    chars: 1,
    maxChars: 1,
    lastConsolidatedAt: null,
  } as never);
  vi.spyOn(internals.memory, 'getObservations').mockReturnValue([
    { id: 'obs-1', content: 'x', timestamp: new Date().toISOString(), type: 'note' },
  ] as never);
  internals.memory.getLastConsolidatedAt = () => null;
  internals.memory.markConsolidated = () => {};
  return vi.spyOn(internals, 'dreamConsolidateMemory').mockResolvedValue(undefined);
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-c8c-dream-'));
});

afterEach(() => {
  delete process.env['MARKUS_DREAM_PATH'];
  rmSync(tempDir, { recursive: true, force: true });
});

describe('dream single trigger (C8-C)', () => {
  // `TRIAGE_STALE_DROP_TYPES` membership for `memory_consolidation` is C8-A's table
  // (single writer); this cut only guarantees the producer side.
  void TRIAGE_STALE_DROP_TYPES;

  it('one due clock tick ⇒ one dream:trigger, and the dream runs once', async () => {
    const { agent, internals } = createAgent();
    const dream = pressurise(internals);
    const events: Array<Record<string, unknown>> = [];
    agent.getEventBus().on('dream:trigger', e => events.push(e as Record<string, unknown>));
    internals.scheduleConsolidationTimer();

    internals.clock.tick(Date.now() + 7 * 3600_000);
    await new Promise(r => setTimeout(r, 0));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ agentId: 'c8c-dream-agent', ran: true });
    expect(dream).toHaveBeenCalledTimes(1);
  });

  it('second tick in the same window emits one event with ran:false (dedup, not a miss)', async () => {
    const { agent, internals } = createAgent();
    const dream = pressurise(internals);
    const events: Array<Record<string, unknown>> = [];
    agent.getEventBus().on('dream:trigger', e => events.push(e as Record<string, unknown>));
    internals.scheduleConsolidationTimer();

    const first = Date.now() + 7 * 3600_000;
    internals.clock.tick(first);
    await new Promise(r => setTimeout(r, 0));
    internals.clock.tick(first + 7 * 3600_000);
    await new Promise(r => setTimeout(r, 0));

    expect(events).toHaveLength(2);
    expect(events[0]?.['ran']).toBe(true);
    expect(events[1]?.['ran']).toBe(false);
    expect(dream).toHaveBeenCalledTimes(1);
  });

  it('clock mode: a legacy memory_consolidation row does not replay a dream', async () => {
    const { agent, internals } = createAgent();
    const dream = pressurise(internals);
    const chat = (agent as unknown as { llmRouter: { chat: ReturnType<typeof vi.fn> } }).llmRouter.chat;

    const item = agent.enqueueToMailbox('memory_consolidation', {
      summary: 'legacy dream row',
      content: 'dream please',
    });
    const reply = await internals.processMailboxItemCore(item);

    expect(String(reply)).toMatch(/skip/i);
    expect(dream).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
  });

  it('dual mode (rollback): the row replays the dream again', async () => {
    process.env['MARKUS_DREAM_PATH'] = 'dual';
    const { agent, internals } = createAgent();
    const dream = pressurise(internals);
    const chat = (agent as unknown as { llmRouter: { chat: ReturnType<typeof vi.fn> } }).llmRouter.chat;

    const item = agent.enqueueToMailbox('memory_consolidation', {
      summary: 'legacy dream row',
      content: 'dream please',
    });
    await internals.processMailboxItemCore(item);

    // Rollback channel: the row is turned into an LLM turn exactly as before C8-C.
    expect(chat).toHaveBeenCalled();
    expect(dream).not.toHaveBeenCalled();
  });
});
