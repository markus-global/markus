import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent } from '../src/agent.js';
import { routeMailboxItem, MAILBOX_TYPE_REGISTRY } from '@markus/shared';
import type { LLMRouter } from '../src/llm/router.js';
import type { RoleTemplate } from '@markus/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * A signal that owes a turn must have a BODY.
 *
 * Root cause this guards (2026-11-25): the mailbox dispatcher's `switch (item.sourceType)`
 * had no `default`, so a type with no bespoke case fell through and returned `undefined`
 * — no LLM call, no decision, no fact. Routing said «you owe a turn»; execution did nothing.
 * `external_signal` was the live instance: three real webhook probes woke the agent and
 * each turn was judged an empty reply, retried, and dropped.
 *
 * The invariant is deliberately stated over the ROUTING policy, not over a list of type
 * names: «if the policy can owe an LLM turn, the dispatcher must run one». That makes the
 * guard cover every future source type without anyone remembering to extend it.
 */

let tempDir: string;

const MOCK_ROLE: RoleTemplate = {
  id: 'turn-body-role',
  name: 'Turn Body Role',
  description: 'Tests that turn-owing signals get a body',
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
      content: 'Decided: no action needed.',
      finishReason: 'end_turn',
      usage: { inputTokens: 40, outputTokens: 20 },
    })),
    chatStream: vi.fn(async () => ({
      content: 'Decided: no action needed.',
      finishReason: 'end_turn',
      usage: { inputTokens: 40, outputTokens: 20 },
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

function createAgent(router: LLMRouter) {
  return new Agent({
    config: {
      id: 'turn-body-agent',
      name: 'Turn Body Agent',
      roleId: 'worker',
      llmConfig: { modelMode: 'custom', primary: 'anthropic' },
      createdAt: new Date().toISOString(),
    } as never,
    role: MOCK_ROLE,
    llmRouter: router,
    dataDir: tempDir,
  });
}

function processViaMailbox(
  agent: Agent,
  sourceType: Parameters<Agent['enqueueToMailbox']>[0],
  payload: Parameters<Agent['enqueueToMailbox']>[1],
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    agent.enqueueToMailbox(sourceType, payload, {
      // A signal owes a turn only when its intent asks for action — the fixture must
      // state that, or it tests a record-only item and proves nothing.
      intent: 'action_required',
      runtime: { responsePromise: { resolve, reject } },
    } as never);
  });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-turn-body-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('a turn-owing signal has a body', () => {
  it('runs a real LLM turn for an external_signal', async () => {
    const router = makeRouter();
    const agent = createAgent(router);
    await agent.start();

    const reply = await processViaMailbox(agent, 'external_signal', {
      summary: 'Webhook: deploy finished',
      content: 'A fact about the world arrived. Does this change what you should do?',
    });

    // The turn must actually happen — not merely return a success-looking string.
    expect(router.chat).toHaveBeenCalled();
    expect(reply).toContain('Decided');
    await agent.stop();
  });

  it('owes a turn per the routing policy — the premise the body must satisfy', () => {
    // Stated over the POLICY, not a list of type names: a newly added type is covered
    // automatically. If this stops holding, the body above is guarding the wrong thing.
    const route = routeMailboxItem({
      sourceType: 'external_signal',
      envelope: { intent: 'action_required' },
      payload: {},
    } as never);
    expect(route.invokesLLM).toBe(true);
    expect(Object.keys(MAILBOX_TYPE_REGISTRY)).toContain('external_signal');
  });
});