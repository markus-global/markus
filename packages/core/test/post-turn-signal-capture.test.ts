import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent } from '../src/agent.js';
import type { LLMRouter } from '../src/llm/router.js';
import type { RoleTemplate } from '@markus/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Regression (2026-10-21, measured in production logs).
//
// `ensureTurnCompleted` — the post-turn safety net — runs AFTER `handleMessage`
// has executed its `finally`. That finally resets two fields the safety net was
// reading:
//
//   - `activeScenario = undefined`  → `viewBudgetForScenario(undefined)` is
//     undefined → the per-scenario VIEW budget was silently skipped.
//   - `endTurnRequested = false` (consumed by the end_turn fast path before
//     returning '') → a turn that HAD ended via `end_turn` was re-judged as
//     "no end_turn signal" and got a full continuation call.
//
// Observed together on one a2a turn:
//   03:41:57.883  ended turn via end_turn tool
//   03:41:57.888  "Turn finished without an end_turn signal — continuing"
//   03:41:57.902  context assembled: historyTokens 182692  (a2a cap is 30000)
//
// Both are the same defect shape: a fact read from a field that had already been
// mutated. The fix captures the scenario and the end_turn delta at the one place
// that knows them (the handleMessage finally, before the reset) and has the
// safety net read that capture.

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-post-turn-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const MOCK_ROLE: RoleTemplate = {
  id: 'post-turn-role',
  name: 'Post Turn Role',
  description: 'Role for post-turn signal tests',
  category: 'engineering',
  systemPrompt: 'You are a test agent.',
  defaultSkills: [],
  heartbeatChecklist: '',
  defaultPolicies: [],
  builtIn: false,
};

function makeRouter(): LLMRouter {
  return {
    chat: vi.fn(async () => ({
      content: 'continuation that should never run',
      finishReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5 },
    })),
    chatStream: vi.fn(),
    getActiveModelContextWindow: () => 200000,
    getActiveModelName: () => 'test-model',
    getActiveModelMaxOutput: () => 8000,
    getModelContextWindow: () => 200000,
    getModelMaxOutput: () => 8000,
    getModelCost: () => undefined,
    isCompactionSupported: () => false,
    modelSupportsVision: () => false,
    listProviders: () => ['test'],
    getProvider: () => undefined,
    getDefaultProvider: () => 'test',
    defaultProviderName: 'test',
    resolveModalityCandidates: vi.fn(() => []),
  } as unknown as LLMRouter;
}

function createAgent(router: LLMRouter) {
  return new Agent({
    config: {
      id: 'test-post-turn-agent',
      name: 'Post Turn Agent',
      roleId: 'worker',
      llmConfig: { modelMode: 'custom', primary: 'anthropic' },
      createdAt: new Date().toISOString(),
      skills: [],
    } as never,
    role: MOCK_ROLE,
    llmRouter: router,
    dataDir: tempDir,
  });
}

type Internals = {
  ensureTurnCompleted: (reply: string, sessionId?: string) => Promise<{ text: string; completed: boolean }>;
  getPrepareBudgetOpts: () => {
    viewBudget?: { viewTokens: number };
    scenario?: string;
  };
  lastTurnScenario?: string;
  lastTurnEndedViaEndTurn: boolean;
  activeScenario?: string;
  endTurnRequested: boolean;
  memory: { getSession: (id: string) => unknown; appendMessage: (...a: unknown[]) => void };
};

describe('post-turn signals are captured before the reset', () => {
  it('a turn that ended via end_turn gets NO continuation call', async () => {
    const router = makeRouter();
    const agent = createAgent(router);
    const inner = agent as unknown as Internals;

    // handleMessage's finally captured: this turn ended deliberately.
    inner.lastTurnEndedViaEndTurn = true;
    // ...and the reply assembly already consumed the mutable flag.
    inner.endTurnRequested = false;
    // A session must exist or the net short-circuits for the wrong reason.
    vi.spyOn(inner.memory, 'getSession').mockReturnValue({ id: 's1' });

    const result = await inner.ensureTurnCompleted('the real answer', 's1');

    expect(result).toEqual({ text: 'the real answer', completed: true });
    expect(router.chat).not.toHaveBeenCalled();
  });

  it('a turn that did NOT end still triggers the safety net', async () => {
    const router = makeRouter();
    const agent = createAgent(router);
    const inner = agent as unknown as Internals;

    inner.lastTurnEndedViaEndTurn = false;
    inner.endTurnRequested = false;
    vi.spyOn(inner.memory, 'getSession').mockReturnValue({ id: 's1' });
    const append = vi.spyOn(inner.memory, 'appendMessage').mockImplementation(() => {});

    await inner.ensureTurnCompleted('half-done', 's1');

    // Assert we got PAST the early-return guard, not that a full LLM round ran:
    // the continuation's own dependencies (tool selection, real session history)
    // are outside this test's scope, and asserting on them would make a
    // construction gap look like a behavioural pass.
    expect(append).toHaveBeenCalled();
  });

  it('the scenario survives activeScenario being cleared by the finally', () => {
    const router = makeRouter();
    const agent = createAgent(router);
    const inner = agent as unknown as Internals;

    // After handleMessage's finally:
    inner.activeScenario = undefined;
    inner.lastTurnScenario = 'a2a';

    const budget = inner.getPrepareBudgetOpts();

    // The scenario drives whether the [CONTEXT] banner may name a lever
    // (session compact / pin). View budgets themselves were deleted on
    // 2026-10-23 — history is no longer trimmed per call.
    expect(budget.scenario).toBe('a2a');
  });

  it('exempt scenarios keep the no-cap behaviour', () => {
    const router = makeRouter();
    const agent = createAgent(router);
    const inner = agent as unknown as Internals;

    inner.activeScenario = undefined;
    inner.lastTurnScenario = 'memory_consolidation';

    const budget = inner.getPrepareBudgetOpts();

    // memory_consolidation must see everything; the fallback must not invent a cap.
    expect(budget.viewBudget).toBeUndefined();
  });
});
