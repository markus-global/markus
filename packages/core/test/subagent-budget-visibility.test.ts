import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  runSubagentLoop,
  createParallelSubagentTool,
  type SubagentContext,
} from '../src/tools/subagent.js';
import { ContextEngine } from '../src/context-engine.js';
import type { LLMRouter } from '../src/llm/router.js';
import type { AgentToolHandler } from '../src/agent.js';

/**
 * H6 — subagent budget exhaustion must be VISIBLE and must never serialise to an
 * empty string (see docs/records/PLATFORM-HARDENING-2026-10.md §5).
 *
 * Pre-fix behaviour this file pins against:
 *   - `runSubagentLoop` returned a bare `string`. A child stopped by the iteration cap
 *     returned `''` (its last assistant turn carried only tool-calls, no text) while a
 *     shared-pool stop only appended an inline note — and BOTH were still surfaced to
 *     the parent as `status: 'completed'`. A parent could not tell a truncated/empty
 *     child from a successful one (observed in production: 2 children spawned, one
 *     silently returned empty).
 *   - A single shared decrementing pool let whichever child ran longest drain a
 *     sibling's quota.
 *
 * Target contract asserted here:
 *   - each child has an INDEPENDENT iteration budget (`iterationBudget`); the shared
 *     fan-out pool is only an overall circuit breaker (`aggregateBudget`);
 *   - the loop returns a structured `{ status, output, iterations, aggregateCeilingReached }`
 *     where `status` is `'budget_exhausted'` / `'max_iterations'` / `'completed'` and
 *     `output` is NEVER empty.
 */

let dataDir: string;

function makeMockRouter(responses: Array<{
  content: string;
  finishReason: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
}>): LLMRouter {
  let callIndex = 0;
  return {
    chat: vi.fn(async () => {
      const r = responses[callIndex] ?? responses[responses.length - 1]!;
      callIndex++;
      return {
        content: r.content,
        finishReason: r.finishReason,
        toolCalls: r.toolCalls,
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }),
    getModelContextWindow: vi.fn(() => 32000),
  } as unknown as LLMRouter;
}

/** A router whose every turn asks for a tool with NO text — the pathological case that
 *  produced empty results when a child was stopped by the iteration cap. */
function loopingRouter(): LLMRouter {
  return makeMockRouter([{
    content: '',
    finishReason: 'tool_use',
    toolCalls: [{ id: 'tc1', name: 'echo', arguments: {} }],
  }]);
}

const echoTool: AgentToolHandler = {
  name: 'echo',
  description: 'Echo',
  inputSchema: { type: 'object', properties: {} },
  execute: async () => '{"ok":true}',
};

function makeCtx(router: LLMRouter, tools: Map<string, AgentToolHandler>): SubagentContext {
  return {
    llmRouter: router,
    contextEngine: new ContextEngine(),
    getTools: () => tools,
    getProvider: () => 'test',
    agentId: 'agt_parent',
    offloadLargeResult: (_name, result) => result,
    dataDir,
  };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'markus-subagent-budget-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('H6: per-child budget exhaustion is explicit, never an empty success', () => {
  it('runSubagentLoop: own iteration budget exhaustion → status budget_exhausted + non-empty output', async () => {
    const ctx = makeCtx(loopingRouter(), new Map([['echo', echoTool]]));

    const result = await runSubagentLoop(ctx, 'Loop forever', {
      maxIterations: 1000,
      iterationBudget: 2,
    });

    // Must carry an explicit structured failure status, not a bare string.
    expect(result.status).toBe('budget_exhausted');
    // Must NEVER be empty — the parent has to see something.
    expect(result.output.trim().length).toBeGreaterThan(0);
    expect(result.output.toLowerCase()).toContain('incomplete');
    expect(result.iterations).toBeGreaterThan(0);
  });

  it('runSubagentLoop: the aggregate ceiling is a breaker, and its stop is also explicit', async () => {
    const ctx = makeCtx(loopingRouter(), new Map([['echo', echoTool]]));
    const aggregateBudget = { remaining: 1 };

    const result = await runSubagentLoop(ctx, 'Loop forever', {
      maxIterations: 1000,
      aggregateBudget,
    });

    expect(result.status).toBe('budget_exhausted');
    expect(result.aggregateCeilingReached).toBe(true);
    expect(result.output.trim().length).toBeGreaterThan(0);
  });

  it('runSubagentLoop: a clean completion keeps status completed and its text', async () => {
    const router = makeMockRouter([{ content: 'Analysis complete.', finishReason: 'end_turn' }]);
    const ctx = makeCtx(router, new Map());

    const result = await runSubagentLoop(ctx, 'Analyze');

    expect(result.status).toBe('completed');
    expect(result.output).toBe('Analysis complete.');
  });

  it('spawn_subagents: an exhausted child is surfaced as budget_exhausted, never a completed empty string', async () => {
    const tool = createParallelSubagentTool(makeCtx(loopingRouter(), new Map([['echo', echoTool]])));

    const parsed = JSON.parse(await tool.execute({
      tasks: [
        { id: 'a', task: 'loop A' },
        { id: 'b', task: 'loop B' },
      ],
    }));

    expect(parsed.results).toHaveLength(2);
    for (const r of parsed.results) {
      // The exact production symptom: a child that returns nothing.
      expect(typeof r.result).toBe('string');
      expect(r.result.trim().length).toBeGreaterThan(0);
      expect(r.status).not.toBe('completed');
    }
    // Both children were stopped by their OWN budget — one did not steal the other's.
    expect(parsed.results.every((r: { status: string }) => r.status === 'budget_exhausted')).toBe(true);
    expect(parsed.budgetExceeded).toBe(true);
    // Summary must make the partial outcome legible at a glance.
    expect(parsed.summary).toMatch(/stopped early|incomplete|budget/i);
  });
});
