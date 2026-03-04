import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent } from '../src/agent.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RoleTemplate } from '@markus/shared';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-loop-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const MOCK_ROLE: RoleTemplate = {
  id: 'test-role',
  name: 'Test Role',
  description: 'Test role for agent loop tests',
  category: 'engineering',
  systemPrompt: 'You are a test agent.',
  defaultSkills: [],
  defaultHeartbeatTasks: [],
  defaultPolicies: [],
  builtIn: false,
};

function makeMockRouter(chatFn: (...args: unknown[]) => Promise<unknown>) {
  return {
    chat: vi.fn(chatFn),
    chatStream: vi.fn(),
    getActiveModelContextWindow: () => 200000,
    getActiveModelMaxOutput: () => 8000,
    listProviders: () => ['test'],
    getProvider: () => undefined,
    getDefaultProvider: () => 'test',
  } as unknown;
}

function makeResponse(
  content: string,
  finishReason: string,
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
) {
  return {
    content,
    finishReason,
    toolCalls,
    usage: { inputTokens: 100, outputTokens: 50 },
  };
}

function createTestAgent(mockRouter: unknown) {
  const agent = new Agent({
    config: {
      id: 'test-loop-agent',
      name: 'Loop Test Agent',
      role: 'worker',
      llmConfig: { provider: 'anthropic', model: 'test-model', apiKey: 'test' },
      createdAt: new Date().toISOString(),
    },
    role: MOCK_ROLE,
    llmRouter: mockRouter as import('../src/llm/router.js').LLMRouter,
    dataDir: tempDir,
  });
  return agent;
}

describe('Agent Loop Improvements', () => {
  it('should break out of tool loop after max iterations', async () => {
    let callCount = 0;
    const mockRouter = makeMockRouter(async () => {
      callCount++;
      return makeResponse('thinking...', 'tool_use', [
        { id: `tc_${callCount}`, name: 'shell_execute', arguments: { command: 'echo hi' } },
      ]);
    });

    const agent = createTestAgent(mockRouter);

    agent.registerTool({
      name: 'shell_execute',
      description: 'test',
      inputSchema: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
      execute: async () => '{"status":"success","stdout":"hi"}',
    });

    const result = await agent.handleMessage('infinite loop test');

    // MAX_TOOL_ITERATIONS = 25, so total calls = 1 (initial) + 25 (loop) = 26
    expect(callCount).toBeLessThanOrEqual(27);
    expect(callCount).toBeGreaterThan(1);
    expect(result).toBeDefined();
  });

  it('should execute multiple tool calls in parallel', async () => {
    const executionOrder: string[] = [];

    let callIndex = 0;
    const mockRouter = makeMockRouter(async () => {
      callIndex++;
      if (callIndex === 1) {
        return makeResponse('Let me check both...', 'tool_use', [
          { id: 'tc_a', name: 'tool_a', arguments: {} },
          { id: 'tc_b', name: 'tool_b', arguments: {} },
        ]);
      }
      return makeResponse('Done with both tools.', 'end_turn');
    });

    const agent = createTestAgent(mockRouter);

    agent.registerTool({
      name: 'tool_a',
      description: 'Tool A',
      inputSchema: { type: 'object', properties: {}, required: [] },
      execute: async () => {
        executionOrder.push('a_start');
        await new Promise(r => setTimeout(r, 50));
        executionOrder.push('a_end');
        return '{"result":"a"}';
      },
    });

    agent.registerTool({
      name: 'tool_b',
      description: 'Tool B',
      inputSchema: { type: 'object', properties: {}, required: [] },
      execute: async () => {
        executionOrder.push('b_start');
        await new Promise(r => setTimeout(r, 50));
        executionOrder.push('b_end');
        return '{"result":"b"}';
      },
    });

    const result = await agent.handleMessage('run both tools');

    // With parallel execution (Promise.all), both tools start concurrently.
    // b_start should happen before a_end.
    expect(executionOrder.indexOf('b_start')).toBeLessThan(executionOrder.indexOf('a_end'));
    expect(result).toBe('Done with both tools.');
  });

  it('should offload oversized tool results to filesystem', async () => {
    const hugeOutput = 'x'.repeat(20_000);

    let callIndex = 0;
    const mockRouter = makeMockRouter(async () => {
      callIndex++;
      if (callIndex === 1) {
        return makeResponse('Reading...', 'tool_use', [
          { id: 'tc_big', name: 'big_tool', arguments: {} },
        ]);
      }
      return makeResponse('Processed the data.', 'end_turn');
    });

    const agent = createTestAgent(mockRouter);

    agent.registerTool({
      name: 'big_tool',
      description: 'Returns huge output',
      inputSchema: { type: 'object', properties: {}, required: [] },
      execute: async () => hugeOutput,
    });

    const result = await agent.handleMessage('get big data');
    expect(result).toBe('Processed the data.');

    // The second LLM call should have received an offloaded file reference
    const chat = (mockRouter as { chat: { mock: { calls: unknown[][] } } }).chat;
    const secondCall = chat.mock.calls[1];
    if (secondCall) {
      const msgs = (secondCall[0] as { messages: Array<{ role: string; content: string }> })
        .messages;
      const toolMsg = msgs.find(m => m.role === 'tool');
      if (toolMsg) {
        expect(toolMsg.content.length).toBeLessThan(hugeOutput.length);
        expect(toolMsg.content).toContain('Tool output saved to file');
        expect(toolMsg.content).toContain('file_read');
      }
    }
  });

  it('should handle max_tokens by continuing generation', async () => {
    let callIndex = 0;
    const mockRouter = makeMockRouter(async () => {
      callIndex++;
      if (callIndex === 1) {
        return makeResponse('Here is the first part of my answer...', 'max_tokens');
      }
      if (callIndex === 2) {
        return makeResponse('And here is the rest.', 'end_turn');
      }
      return makeResponse('Unexpected call', 'end_turn');
    });

    const agent = createTestAgent(mockRouter);

    const result = await agent.handleMessage('write a long essay');

    expect(callIndex).toBe(2);
    expect(result).toBe('And here is the rest.');
  });
});
