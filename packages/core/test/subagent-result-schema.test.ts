import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  runSubagentLoop,
  createSubagentTool,
  createParallelSubagentTool,
  type SubagentContext,
} from '../src/tools/subagent.js';
import { ContextEngine } from '../src/context-engine.js';
import type { LLMRouter } from '../src/llm/router.js';
import type { AgentToolHandler } from '../src/agent.js';
import { toolOk, toolErr } from '../src/tools/result.js';

/**
 * F1–F4 — a subagent's terminal state must be auditable from its RESULT, not from a
 * manual `git status` in the parent's workspace (see
 * `docs/records/agent-platform-friction-2026-10.md`).
 *
 * H6 already made an early stop *visible* (`status` + a non-empty `[INCOMPLETE …]` note).
 * These tests pin the schema that makes it *actionable*:
 *   - F1 — `budgetHit` says WHICH budget stopped the child ('own' | 'aggregate' | 'max_iterations'),
 *          never just a bare "it stopped" boolean;
 *   - F2 — `filesTouched` is a best-effort hint of the paths a truncated child wrote via file      
 *          tools (successful, non-dry-run writes only); it never claims the workspace is untouched;
 *   - F3 — `toolCalls: { total, writes }` distinguishes "explored forever" from "wrote then
 *          stopped"; an early stop reminds the parent to verify rather than asserting a negative;
 *   - F4 — the same schema crosses the `spawn_subagent` / `spawn_subagents` tool boundary.
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

/** A tool that behaves like a successful file write (canonical `{status:'success'}` envelope). */
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
    offloadLargeResult: (_name, result) => result,
    dataDir,
  };
}

/** One turn that calls a tool with no text, forever — the loop-until-budget shape. */
function loopWith(name: string, args: Record<string, unknown>): Array<{
  content: string;
  finishReason: string;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
}> {
  return [{ content: '', finishReason: 'tool_use', toolCalls: [{ id: 'tc1', name, arguments: args }] }];
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'markus-subagent-schema-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('F2/F3 — a stopped child reports what it touched and how it spent its budget', () => {
  const writeTools = new Map<string, AgentToolHandler>([
    ['file_write', okTool('file_write')],
    ['file_edit', okTool('file_edit')],
    ['apply_patch', okTool('apply_patch')],
    ['echo', okTool('echo')],
  ]);

  it('records filesTouched + toolCalls for successful writes, and names the budget it hit', async () => {
    const router = makeMockRouter([
      { content: '', finishReason: 'tool_use', toolCalls: [{ id: '1', name: 'file_write', arguments: { path: 'src/a.ts', content: 'x' } }] },
      { content: '', finishReason: 'tool_use', toolCalls: [{ id: '2', name: 'file_edit', arguments: { path: 'src/b.ts', old_string: 'x', new_string: 'y' } }] },
    ]);

    const result = await runSubagentLoop(makeCtx(router, writeTools), 'write two files', {
      iterationBudget: 2,
      maxIterations: 1000,
    });

    expect(result.status).toBe('budget_exhausted');
    expect(result.budgetHit).toBe('own');
    expect(result.filesTouched).toEqual(['src/a.ts', 'src/b.ts']);
    expect(result.toolCalls).toEqual({ total: 2, writes: 2 });
    // The prose note must carry the same facts, so a parent that only reads `output` still sees them.
    expect(result.output).toContain('src/a.ts');
    expect(result.output).toMatch(/INCOMPLETE/);
  });

  it('does NOT count an errored write, nor an apply_patch dry run — and reminds instead of claiming nothing changed', async () => {
    const tools = new Map<string, AgentToolHandler>([
      ['file_write', { ...okTool('file_write'), execute: async () => toolErr('denied: other agent workspace') }],
      ['apply_patch', okTool('apply_patch')],
    ]);
    const router = makeMockRouter([
      { content: '', finishReason: 'tool_use', toolCalls: [{ id: '1', name: 'file_write', arguments: { path: 'src/nope.ts', content: 'x' } }] },
      { content: '', finishReason: 'tool_use', toolCalls: [{ id: '2', name: 'apply_patch', arguments: { dry_run: true, patches: [{ file: 'src/nope2.ts', action: 'edit' }] } }] },
    ]);

    const result = await runSubagentLoop(makeCtx(router, tools), 'attempt writes', {
      iterationBudget: 2,
      maxIterations: 1000,
    });

    expect(result.filesTouched).toEqual([]);
    expect(result.toolCalls).toEqual({ total: 2, writes: 0 });
    expect(result.output).toContain('verify the workspace');
  });

  it('records every file in a real (non-dry-run) apply_patch', async () => {
    const tools = new Map<string, AgentToolHandler>([['apply_patch', okTool('apply_patch')]]);
    const router = makeMockRouter(loopWith('apply_patch', {
      patches: [
        { file: 'src/one.ts', action: 'edit' },
        { file: 'src/two.ts', action: 'create' },
      ],
    }));

    const result = await runSubagentLoop(makeCtx(router, tools), 'patch two files', {
      iterationBudget: 1,
      maxIterations: 1000,
    });

    expect(result.filesTouched).toEqual(['src/one.ts', 'src/two.ts']);
    expect(result.toolCalls).toEqual({ total: 1, writes: 1 });
  });

  it('a child capped by max_iterations reports budgetHit=max_iterations with zero writes', async () => {
    const tools = new Map<string, AgentToolHandler>([['echo', okTool('echo')]]);

    const result = await runSubagentLoop(makeCtx(makeMockRouter(loopWith('echo', {})), tools), 'explore only', {
      maxIterations: 1,
    });

    expect(result.status).toBe('max_iterations');
    expect(result.budgetHit).toBe('max_iterations');
    expect(result.toolCalls.writes).toBe(0);
    expect(result.output).toContain('verify the workspace');
  });

  it('the shared fan-out breaker is reported as budgetHit=aggregate, distinct from a child\'s own budget', async () => {
    const tools = new Map<string, AgentToolHandler>([['echo', okTool('echo')]]);

    const result = await runSubagentLoop(makeCtx(makeMockRouter(loopWith('echo', {})), tools), 'loop', {
      maxIterations: 1000,
      aggregateBudget: { remaining: 1 },
    });

    expect(result.status).toBe('budget_exhausted');
    expect(result.budgetHit).toBe('aggregate');
    expect(result.aggregateCeilingReached).toBe(true);
  });

  it('a clean completion reports budgetHit=null and an empty audit trail', async () => {
    const router = makeMockRouter([{ content: 'Analysis complete.', finishReason: 'end_turn' }]);

    const result = await runSubagentLoop(makeCtx(router, new Map()), 'analyze');

    expect(result.status).toBe('completed');
    expect(result.budgetHit).toBeNull();
    expect(result.filesTouched).toEqual([]);
    expect(result.toolCalls).toEqual({ total: 0, writes: 0 });
  });
});

describe('F4 — the audit schema survives the tool boundary', () => {
  const tools = new Map<string, AgentToolHandler>([['file_write', okTool('file_write')]]);

  it('spawn_subagent returns status / budgetHit / filesTouched / toolCalls', async () => {
    const router = makeMockRouter(loopWith('file_write', { path: 'src/a.ts', content: 'x' }));
    const tool = createSubagentTool(makeCtx(router, tools));

    const parsed = JSON.parse(await tool.execute({ task: 'write', iteration_budget: 1, max_iterations: 1000 }));

    expect(parsed.status).toBe('budget_exhausted');
    expect(parsed.budgetHit).toBe('own');
    expect(parsed.filesTouched).toEqual(['src/a.ts']);
    expect(parsed.toolCalls).toEqual({ total: 1, writes: 1 });
  });

  it('spawn_subagents returns the schema for every child', async () => {
    const router = makeMockRouter(loopWith('file_write', { path: 'src/a.ts', content: 'x' }));
    const tool = createParallelSubagentTool(makeCtx(router, tools));

    const parsed = JSON.parse(await tool.execute({
      tasks: [{ id: 'a', task: 'write', iteration_budget: 1, max_iterations: 1000 }],
    }));

    const child = parsed.results[0];
    expect(child.status).toBe('budget_exhausted');
    expect(child.budgetHit).toBe('own');
    expect(child.filesTouched).toEqual(['src/a.ts']);
    expect(child.toolCalls).toEqual({ total: 1, writes: 1 });
  });
});
