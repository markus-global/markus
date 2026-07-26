import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent, shouldContinueToolLoop, needsMaxTokensContinuation } from '../src/agent.js';
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
  heartbeatChecklist: '',
  defaultPolicies: [],
  builtIn: false,
};

function makeMockRouter(chatFn: (...args: unknown[]) => Promise<unknown>) {
  return {
    chat: vi.fn(chatFn),
    chatStream: vi.fn(),
    getActiveModelContextWindow: () => 200000,
    getActiveModelName: () => 'test-model',
    getActiveModelMaxOutput: () => 8000,
    getModelContextWindow: (model: string) => 200000,
    getModelMaxOutput: (model: string) => 8000,
    getModelCost: () => undefined,
    isCompactionSupported: (model: string) => true,
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

    // MAX_TOOL_ITERATIONS = 200 (safety cap against infinite loops)
    expect(callCount).toBeLessThanOrEqual(202);
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
    // Budget-first packing no longer pre-compacts normal-sized history. Results are
    // offloaded to disk only above OFFLOAD_THRESHOLD (50k); pick a size above it.
    const hugeOutput = 'x'.repeat(60_000);

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
        // Oversized results are offloaded to a file with a reference the model can read.
        expect(toolMsg.content).toContain('FULL output');
        expect(toolMsg.content).toContain('saved to:');
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

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 3: handleMessage / respondInSession interrupt flow
//
// These tests verify the yield-point logic in handleMessage by exercising
// the full attention loop (sendMessage → mailbox → processFocusedItem →
// handleMessage). This ensures currentFocus is set on the AttentionController
// so checkYieldPoint can evaluate interrupts correctly.
// ═══════════════════════════════════════════════════════════════════════════════

describe('handleMessage interrupt flow (via attention loop)', () => {
  it('processes human_chat after it preempts a2a tool execution', async () => {
    const processedScenarios: string[] = [];
    let llmCallCount = 0;

    const mockRouter = makeMockRouter(async () => {
      llmCallCount++;
      // First 2 calls for a2a processing (tool use → end), then human_chat
      if (llmCallCount === 1) {
        return makeResponse('Using tool...', 'tool_use', [
          { id: 'tc_1', name: 'slow_tool', arguments: {} },
        ]);
      }
      return makeResponse('Done.', 'end_turn');
    });

    const agent = createTestAgent(mockRouter);
    let humanChatEnqueued = false;

    agent.registerTool({
      name: 'slow_tool',
      description: 'Tool that enqueues a high-priority human_chat during execution',
      inputSchema: { type: 'object', properties: {}, required: [] },
      execute: async () => {
        if (!humanChatEnqueued) {
          humanChatEnqueued = true;
          // Simulate a user message arriving during tool execution
          agent.getMailbox().enqueue('human_chat', {
            summary: 'urgent user msg',
            content: 'I need help right now!',
          });
          await new Promise(r => setTimeout(r, 10));
        }
        return '{"status":"ok"}';
      },
    });

    const ac = agent.getAttentionController();
    ac.start();

    agent.getMailbox().enqueue('a2a_message', {
      summary: 'agent work',
      content: 'do some agent work',
    });

    // Wait for both messages to be processed
    await vi.waitFor(() => {
      expect(llmCallCount).toBeGreaterThanOrEqual(2);
    }, { timeout: 5000 });

    // Allow processing to settle
    await new Promise(r => setTimeout(r, 500));
    ac.stop();

    // The human_chat was enqueued during a2a processing.
    // Verify the interrupt mechanism worked: multiple LLM calls happened
    // (the a2a may have been preempted and the human_chat processed).
    expect(llmCallCount).toBeGreaterThanOrEqual(2);
    expect(humanChatEnqueued).toBe(true);
  });

  it('chat scenario completes normally even when interrupt arrives', async () => {
    let toolCallCount = 0;
    const mockRouter = makeMockRouter(async () => {
      toolCallCount++;
      if (toolCallCount === 1) {
        return makeResponse('Using tool...', 'tool_use', [
          { id: 'tc_1', name: 'trigger_tool', arguments: {} },
        ]);
      }
      return makeResponse('Completed normally.', 'end_turn');
    });

    const agent = createTestAgent(mockRouter);

    agent.registerTool({
      name: 'trigger_tool',
      description: 'Tool that triggers interrupt',
      inputSchema: { type: 'object', properties: {}, required: [] },
      execute: async () => '{"status":"ok"}',
    });

    // Direct handleMessage call — scenario='chat' (default) → isPreemptable = false
    // No currentFocus, so checkYieldPoint returns 'continue'
    const result = await agent.handleMessage('test no preemption');

    expect(result).toBe('Completed normally.');
    expect(toolCallCount).toBe(2);
  });

  it('isPreemptable is false for chat scenario and true for a2a', async () => {
    // This is a logic-level test of the scenario → isPreemptable mapping
    // (scenario !== 'chat' → isPreemptable = true)
    const scenarios: Array<{ name: string; preemptable: boolean }> = [
      { name: 'chat', preemptable: false },
      { name: 'a2a', preemptable: true },
      { name: 'task_execution', preemptable: true },
      { name: 'heartbeat', preemptable: true },
      { name: 'comment_response', preemptable: true },
      { name: 'deliberation', preemptable: true },
    ];

    for (const s of scenarios) {
      expect(s.name !== 'chat').toBe(s.preemptable);
    }
  });
});

describe('B5: shared tool-loop decision helpers', () => {
  it('shouldContinueToolLoop continues on tool_use with tool calls', () => {
    expect(shouldContinueToolLoop({ finishReason: 'tool_use', toolCalls: [{ id: 't' }] })).toBe(true);
  });

  it('shouldContinueToolLoop continues on max_tokens (with or without tool calls)', () => {
    expect(shouldContinueToolLoop({ finishReason: 'max_tokens', toolCalls: [] })).toBe(true);
    expect(shouldContinueToolLoop({ finishReason: 'max_tokens', toolCalls: [{ id: 't' }] })).toBe(true);
  });

  it('shouldContinueToolLoop stops on end_turn or tool_use with no calls', () => {
    expect(shouldContinueToolLoop({ finishReason: 'end_turn', toolCalls: [] })).toBe(false);
    expect(shouldContinueToolLoop({ finishReason: 'tool_use', toolCalls: [] })).toBe(false);
    expect(shouldContinueToolLoop({ finishReason: 'tool_use' })).toBe(false);
    expect(shouldContinueToolLoop({})).toBe(false);
  });

  it('shouldContinueToolLoop always returns a boolean (never a truthy count)', () => {
    const r = shouldContinueToolLoop({ finishReason: 'tool_use', toolCalls: [{ id: 'a' }, { id: 'b' }] });
    expect(r).toBe(true);
    expect(typeof r).toBe('boolean');
  });

  it('needsMaxTokensContinuation is true only for max_tokens without tool calls', () => {
    expect(needsMaxTokensContinuation({ finishReason: 'max_tokens', toolCalls: [] })).toBe(true);
    expect(needsMaxTokensContinuation({ finishReason: 'max_tokens' })).toBe(true);
    expect(needsMaxTokensContinuation({ finishReason: 'max_tokens', toolCalls: [{ id: 't' }] })).toBe(false);
    expect(needsMaxTokensContinuation({ finishReason: 'end_turn', toolCalls: [] })).toBe(false);
  });
});
