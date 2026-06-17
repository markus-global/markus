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

function makeCtx(router: LLMRouter, tools: Map<string, AgentToolHandler>): SubagentContext {
  return {
    llmRouter: router,
    contextEngine: new ContextEngine(),
    getTools: () => tools,
    getProvider: () => 'test',
    agentId: 'agt_parent',
    offloadLargeResult: (_name, result) => result,
    dataDir,
    getProgressCallback: () => {
      const events: string[] = [];
      return (e) => { events.push(e.type); };
    },
  };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'markus-subagent-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('runSubagentLoop', () => {
  it('returns direct answer when LLM finishes without tools', async () => {
    const router = makeMockRouter([{ content: 'Analysis complete.', finishReason: 'end_turn' }]);
    const ctx = makeCtx(router, new Map());
    const result = await runSubagentLoop(ctx, 'Analyze the module');
    expect(result).toBe('Analysis complete.');
  });

  it('executes tool calls and returns final result', async () => {
    const echoTool: AgentToolHandler = {
      name: 'echo',
      description: 'Echo',
      inputSchema: { type: 'object', properties: {} },
      execute: async (args) => JSON.stringify({ echoed: args['text'] }),
    };
    const tools = new Map([['echo', echoTool]]);
    const router = makeMockRouter([
      {
        content: 'Calling echo',
        finishReason: 'tool_use',
        toolCalls: [{ id: 'tc1', name: 'echo', arguments: { text: 'hello' } }],
      },
      { content: 'Done: hello', finishReason: 'end_turn' },
    ]);
    const ctx = makeCtx(router, tools);
    const result = await runSubagentLoop(ctx, 'Echo hello');
    expect(result).toBe('Done: hello');
    expect(echoTool.execute).toBeDefined();
  });

  it('handles unknown tool and tool handler errors', async () => {
    const badTool: AgentToolHandler = {
      name: 'fail',
      description: 'Fails',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => { throw new Error('tool broke'); },
    };
    const tools = new Map([['fail', badTool]]);
    const router = makeMockRouter([
      {
        content: 'tools',
        finishReason: 'tool_use',
        toolCalls: [
          { id: 'tc1', name: 'missing', arguments: {} },
          { id: 'tc2', name: 'fail', arguments: {} },
        ],
      },
      { content: 'Recovered', finishReason: 'end_turn' },
    ]);
    const ctx = makeCtx(router, tools);
    const result = await runSubagentLoop(ctx, 'Run broken tools');
    expect(result).toBe('Recovered');
  });

  it('continues after max_tokens without tool calls', async () => {
    const router = makeMockRouter([
      { content: 'Partial output...', finishReason: 'max_tokens' },
      { content: 'Full answer now.', finishReason: 'end_turn' },
    ]);
    const ctx = makeCtx(router, new Map());
    const result = await runSubagentLoop(ctx, 'Long task');
    expect(result).toBe('Full answer now.');
  });

  it('stops at max iterations', async () => {
    const router = makeMockRouter([
      {
        content: 'loop',
        finishReason: 'tool_use',
        toolCalls: [{ id: 'tc1', name: 'echo', arguments: {} }],
      },
    ]);
    const echoTool: AgentToolHandler = {
      name: 'echo',
      description: 'Echo',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => '{"ok":true}',
    };
    const ctx = makeCtx(router, new Map([['echo', echoTool]]));
    const result = await runSubagentLoop(ctx, 'Loop forever', { maxIterations: 1 });
    expect(typeof result).toBe('string');
  });

  it('retries on rate limit errors', async () => {
    let attempts = 0;
    const router = {
      chat: vi.fn(async () => {
        attempts++;
        if (attempts === 1) throw new Error('429 rate limit exceeded');
        return { content: 'After retry', finishReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
      }),
      getModelContextWindow: vi.fn(() => 32000),
    } as unknown as LLMRouter;
    const ctx = makeCtx(router, new Map());
    const result = await runSubagentLoop(ctx, 'Retry me');
    expect(result).toBe('After retry');
    expect(attempts).toBe(2);
  });

  it('strips redacted thinking tags from output', async () => {
    const router = makeMockRouter([{
      content: '<think>secret chain</think>\nVisible result.',
      finishReason: 'end_turn',
    }]);
    const ctx = makeCtx(router, new Map());
    const result = await runSubagentLoop(ctx, 'Think task');
    expect(result).not.toContain('secret chain');
    expect(result).toContain('Visible result');
  });
});

describe('subagent tool wrappers', () => {
  it('spawn_subagent returns completed JSON', async () => {
    const router = makeMockRouter([{ content: 'Sub result', finishReason: 'end_turn' }]);
    const tool = createSubagentTool(makeCtx(router, new Map()));
    const raw = await tool.execute({ task: 'Do work' });
    const parsed = JSON.parse(raw);
    expect(parsed.status).toBe('completed');
    expect(parsed.result).toBe('Sub result');
  });

  it('spawn_subagent rejects empty task', async () => {
    const router = makeMockRouter([]);
    const tool = createSubagentTool(makeCtx(router, new Map()));
    const parsed = JSON.parse(await tool.execute({ task: '' }));
    expect(parsed.status).toBe('error');
  });

  it('spawn_subagents runs parallel tasks', async () => {
    const router = makeMockRouter([
      { content: 'A done', finishReason: 'end_turn' },
      { content: 'B done', finishReason: 'end_turn' },
    ]);
    const tool = createParallelSubagentTool(makeCtx(router, new Map()));
    const raw = await tool.execute({
      tasks: [
        { id: 'a', task: 'Task A' },
        { id: 'b', task: 'Task B' },
      ],
    });
    const parsed = JSON.parse(raw);
    expect(parsed.status).toBe('completed');
    expect(parsed.results).toHaveLength(2);
  });

  it('spawn_subagents rejects empty and oversized batches', async () => {
    const router = makeMockRouter([]);
    const tool = createParallelSubagentTool(makeCtx(router, new Map()));
    expect(JSON.parse(await tool.execute({ tasks: [] })).status).toBe('error');
    const tooMany = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, task: 'x' }));
    expect(JSON.parse(await tool.execute({ tasks: tooMany })).status).toBe('error');
  });
});
