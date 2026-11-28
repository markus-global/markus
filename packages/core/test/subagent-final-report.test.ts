import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  runSubagentLoop,
  createSubagentTool,
  type SubagentContext,
} from '../src/tools/subagent.js';
import { ContextEngine } from '../src/context-engine.js';
import type { LLMRouter } from '../src/llm/router.js';
import type { AgentToolHandler } from '../src/agent.js';
import type { LLMRequest } from '@markus/shared';
import {
  SUBAGENT_FINAL_REPORT_MAX_TOKENS,
  SUBAGENT_BUDGET_NOTICE_AT,
} from '@markus/shared';
import { toolOk } from '../src/tools/result.js';

/**
 * D3 — a spend ceiling is not a gag.
 *
 * Before this, an exhausted child `break`ed out of its loop and returned whatever the model
 * had said *before its last tool call* — usually the empty string — so the parent received a
 * bare `[INCOMPLETE …]` notice and had to redo the work to learn anything (measured: 139 of
 * 494 local subagent runs ended that way; 98 of them by their own budget).
 *
 * The contract these tests pin:
 *   - a child that stops early gets ONE final turn with **no tools** (it can talk, not work),
 *     and that report is what the parent reads;
 *   - the machine-counted digest is always in the output, so the parent never depends on the
 *     model's honesty to learn how the budget was spent;
 *   - a child that finishes normally costs nothing extra (no report turn);
 *   - a report turn that fails degrades to the digest and never throws;
 *   - the child is TOLD its budget up front, and warned once before the wall.
 */

let dataDir: string;

interface Call { tools?: unknown; maxTokens?: number; messages: Array<{ role: string; content: string }> }

/** A router that records every request (deep-snapshotted) and answers from a function. */
function recordingRouter(
  respond: (req: LLMRequest, callIndex: number) => {
    content: string;
    finishReason: string;
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  },
): { router: LLMRouter; calls: Call[] } {
  const calls: Call[] = [];
  const chat = vi.fn(async (req: LLMRequest) => {
    const r = respond(req, calls.length);
    // Snapshot AFTER responding so a later in-place mutation of the loop's array cannot
    // rewrite the history these assertions read.
    calls.push({
      tools: req.tools,
      maxTokens: req.maxTokens,
      messages: JSON.parse(JSON.stringify(req.messages)) as Call['messages'],
    });
    return {
      content: r.content,
      finishReason: r.finishReason,
      toolCalls: r.toolCalls,
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  });
  return {
    router: { chat, getModelContextWindow: vi.fn(() => 32_000) } as unknown as LLMRouter,
    calls,
  };
}

function okTool(name: string): AgentToolHandler {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => toolOk({ path: 'x' }),
  };
}

function makeCtx(router: LLMRouter, tools: Map<string, AgentToolHandler>): SubagentContext {
  return {
    llmRouter: router,
    contextEngine: new ContextEngine(),
    getTools: () => tools,
    getProvider: () => 'test',
    agentId: 'agt_parent',
    offloadLargeResult: (_n, r) => r,
    dataDir,
  };
}

const REPORT = [
  'COMPLETED: rewrote src/a.ts (the budget loop) and ran the unit test.',
  'LEFT: the docs section and the fan-out path.',
  'VERIFY: the edit in src/a.ts was half-applied when the budget ran out.',
].join('\n');

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'markus-subagent-report-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('D3 — an exhausted child still gets its last word', () => {
  it('ends an early stop with ONE no-tool turn whose text becomes the result', async () => {
    let n = 0;
    const { router, calls } = recordingRouter((req) => {
      if (!req.tools) return { content: REPORT, finishReason: 'end_turn' };
      n += 1;
      return {
        content: '',
        finishReason: 'tool_use',
        toolCalls: [{ id: `t${n}`, name: 'file_write', arguments: { path: 'src/a.ts', content: 'x' } }],
      };
    });

    const result = await runSubagentLoop(makeCtx(router, new Map([['file_write', okTool('file_write')]])), 'refactor', {
      iterationBudget: 3,
      maxIterations: 1000,
    });

    expect(result.status).toBe('budget_exhausted');
    expect(result.finalReport).toBe('model');
    // The report is what the parent reads first...
    expect(result.output.startsWith('COMPLETED:')).toBe(true);
    // ...and the machine's account is still there, appended, unremovable by the model.
    expect(result.output).toContain('[INCOMPLETE: subagent stopped early');
    expect(result.output).toContain('Observed: iterations 3/3');
    expect(result.output).toContain('src/a.ts');

    // Exactly one wrap-up turn: the last request carries NO tools and a bounded output.
    const last = calls[calls.length - 1]!;
    expect(last.tools).toBeUndefined();
    expect(last.maxTokens).toBe(SUBAGENT_FINAL_REPORT_MAX_TOKENS);
    expect(calls.length).toBe(1 + 3 + 1);
  });

  it('degrades to the digest — and never throws — when the wrap-up turn fails', async () => {
    let n = 0;
    const { router } = recordingRouter((req) => {
      if (!req.tools) throw new Error('provider exploded');
      n += 1;
      return {
        content: '',
        finishReason: 'tool_use',
        toolCalls: [{ id: `t${n}`, name: 'file_edit', arguments: { path: 'src/b.ts', old_string: 'x', new_string: 'y' } }],
      };
    });

    const result = await runSubagentLoop(makeCtx(router, new Map([['file_edit', okTool('file_edit')]])), 'edit', {
      iterationBudget: 2,
      maxIterations: 1000,
    });

    expect(result.status).toBe('budget_exhausted');
    expect(result.finalReport).toBe('digest');
    expect(result.output).toContain('verify the workspace');
    expect(result.output).toContain('no closing report');
    expect(result.output).toContain('iterations 2/2');
  });

  it('treats a wrap-up that says nothing substantive as no report', async () => {
    let n = 0;
    const { router } = recordingRouter((req) => {
      if (!req.tools) return { content: 'ok', finishReason: 'end_turn' };
      n += 1;
      return {
        content: '',
        finishReason: 'tool_use',
        toolCalls: [{ id: `t${n}`, name: 'echo', arguments: {} }],
      };
    });

    const result = await runSubagentLoop(makeCtx(router, new Map([['echo', okTool('echo')]])), 'x', {
      iterationBudget: 1,
      maxIterations: 1000,
    });

    expect(result.finalReport).toBe('digest');
    expect(result.output).not.toContain('ok\n\n[INCOMPLETE');
  });
});

describe('D3 — the report turn costs nothing when it is not needed', () => {
  it('a child that completes normally makes NO extra call', async () => {
    let n = 0;
    const { router, calls } = recordingRouter(() => {
      n += 1;
      if (n === 1) {
        return {
          content: '',
          finishReason: 'tool_use',
          toolCalls: [{ id: 't1', name: 'echo', arguments: {} }],
        };
      }
      return { content: 'All done.', finishReason: 'end_turn' };
    });

    const result = await runSubagentLoop(makeCtx(router, new Map([['echo', okTool('echo')]])), 'x', {
      iterationBudget: 10,
      maxIterations: 1000,
    });

    expect(result.status).toBe('completed');
    expect(result.finalReport).toBeNull();
    expect(calls.length).toBe(2); // initial + one after the tool turn; no wrap-up
    expect(calls.every((c) => c.tools !== undefined)).toBe(true);
  });

  it('a child stopped before doing ANY work has nothing to report and spends nothing', async () => {
    const { router, calls } = recordingRouter(() => ({
      content: '',
      finishReason: 'tool_use',
      toolCalls: [{ id: 't1', name: 'echo', arguments: {} }],
    }));

    const result = await runSubagentLoop(makeCtx(router, new Map([['echo', okTool('echo')]])), 'x', {
      iterationBudget: 5,
      maxIterations: 1000,
      aggregateBudget: { remaining: 0 },
    });

    expect(result.status).toBe('budget_exhausted');
    expect(result.iterations).toBe(0);
    expect(result.finalReport).toBe('digest');
    expect(calls.length).toBe(1);
  });
});

describe('D3 — the child is told its rope, and warned once before the wall', () => {
  it('states the budget in the first user turn (tail, not the system prompt)', async () => {
    const { router, calls } = recordingRouter(() => ({ content: 'done', finishReason: 'end_turn' }));

    await runSubagentLoop(makeCtx(router, new Map()), 'summarise the repo', { iterationBudget: 12 });

    const first = calls[0]!;
    const user = first.messages.find((m) => m.role === 'user')!;
    expect(user.content).toContain('summarise the repo');
    expect(user.content).toContain('[BUDGET: you have at most 12 tool iterations');
    // Head stays stable: the system prompt must not carry the per-spawn value.
    const system = first.messages.find((m) => m.role === 'system')!;
    expect(system.content).not.toContain('12 tool iterations');
  });

  it('injects the near-the-wall notice exactly once, and the loop still stops at the budget', async () => {
    let n = 0;
    const { router, calls } = recordingRouter((req) => {
      if (!req.tools) return { content: REPORT, finishReason: 'end_turn' };
      n += 1;
      return {
        content: '',
        finishReason: 'tool_use',
        toolCalls: [{ id: `t${n}`, name: 'echo', arguments: {} }],
      };
    });

    const budget = 10;
    const result = await runSubagentLoop(makeCtx(router, new Map([['echo', okTool('echo')]])), 'x', {
      iterationBudget: budget,
      maxIterations: 1000,
    });

    expect(result.iterations).toBe(budget);
    const noticed = calls.filter((c) => c.messages.some((m) => m.content.includes('[BUDGET NOTICE')));
    expect(noticed.length).toBeGreaterThan(1); // injected at the threshold, seen by every later turn
    // Exactly ONE occurrence in the history — a second injection would mean the guard leaked.
    const occurrences = noticed[noticed.length - 1]!.messages
      .flatMap((m) => m.content.match(/\[BUDGET NOTICE/g) ?? []).length;
    expect(occurrences).toBe(1);
    // It fires at the documented fraction, not at the first turn.
    // calls[0] is the pre-loop turn; calls[k] is the turn AFTER iteration k, so the notice
    // written at the end of iteration ceil(budget × 0.8) first appears in calls[that index].
    const firstNoticedAt = calls.findIndex((c) => c.messages.some((m) => m.content.includes('[BUDGET NOTICE')));
    expect(firstNoticedAt).toBe(Math.ceil(budget * SUBAGENT_BUDGET_NOTICE_AT));
  });
});

describe('D3 — the schema crosses the tool boundary', () => {
  it('spawn_subagent echoes finalReport next to the existing audit fields', async () => {
    let n = 0;
    const { router } = recordingRouter((req) => {
      if (!req.tools) return { content: REPORT, finishReason: 'end_turn' };
      n += 1;
      return {
        content: '',
        finishReason: 'tool_use',
        toolCalls: [{ id: `t${n}`, name: 'file_write', arguments: { path: 'src/c.ts', content: 'x' } }],
      };
    });

    const tool = createSubagentTool(makeCtx(router, new Map([['file_write', okTool('file_write')]])));
    const parsed = JSON.parse(await tool.execute({ task: 'write', iteration_budget: 2 })) as Record<string, unknown>;

    expect(parsed['status']).toBe('budget_exhausted');
    expect(parsed['finalReport']).toBe('model');
    expect(parsed['filesTouched']).toEqual(['src/c.ts']);
    expect(String(parsed['result'])).toContain('Observed: iterations 2/2');
  });
});
