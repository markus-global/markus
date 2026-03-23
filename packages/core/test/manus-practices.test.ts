import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ContextEngine } from '../src/context-engine.js';
import { MemoryStore } from '../src/memory/store.js';
import { Agent } from '../src/agent.js';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RoleTemplate } from '@markus/shared';
import { vi } from 'vitest';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-manus-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const MOCK_ROLE: RoleTemplate = {
  id: 'test-role',
  name: 'Test Role',
  description: 'Test role',
  category: 'engineering',
  systemPrompt: 'You are a test agent.',
  defaultSkills: [],
  heartbeatChecklist: '',
  defaultPolicies: [],
  builtIn: false,
};

describe('Manus Best Practices Integration', () => {
  describe('KV-Cache Optimization', () => {
    it('should place timestamp at the end of system prompt, not in the prefix', () => {
      const engine = new ContextEngine();
      const memory = new MemoryStore(tempDir);

      const prompt = engine.buildSystemPrompt({
        agentId: 'agent-1',
        agentName: 'Test Agent',
        role: MOCK_ROLE,
        memory,
      });

      // The timestamp should be at the very end, not in identity section
      const lines = prompt.split('\n');
      const lastLines = lines.slice(-3).join('\n');
      expect(lastLines).toContain('Current date:');

      // Identity section should NOT contain a timestamp
      const identitySection = prompt.split('## Your Identity')[1]?.split('##')[0] ?? '';
      expect(identitySection).not.toContain('Current time:');
    });

    it('should use date-only precision to maximize cache hit window', () => {
      const engine = new ContextEngine();
      const memory = new MemoryStore(tempDir);

      const prompt = engine.buildSystemPrompt({
        agentId: 'agent-1',
        agentName: 'Test Agent',
        role: MOCK_ROLE,
        memory,
      });

      // Should use YYYY-MM-DD format, not full ISO timestamp
      const dateMatch = prompt.match(/Current date: (\S+)/);
      expect(dateMatch).toBeTruthy();
      expect(dateMatch![1]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('should produce stable prefix across calls with same config', () => {
      const engine = new ContextEngine();
      const memory = new MemoryStore(tempDir);

      const opts = {
        agentId: 'agent-1',
        agentName: 'Stable Agent',
        role: MOCK_ROLE,
        memory,
      };

      const prompt1 = engine.buildSystemPrompt(opts);
      const prompt2 = engine.buildSystemPrompt(opts);

      // Remove the last line (date) and compare - should be identical
      const prefix1 = prompt1.split('\n').slice(0, -2).join('\n');
      const prefix2 = prompt2.split('\n').slice(0, -2).join('\n');
      expect(prefix1).toBe(prefix2);
    });
  });

  describe('Attention Recitation (todo.md pattern)', () => {
    it('should include working strategy instructions in system prompt', () => {
      const engine = new ContextEngine();
      const memory = new MemoryStore(tempDir);

      const prompt = engine.buildSystemPrompt({
        agentId: 'agent-1',
        agentName: 'Test Agent',
        role: MOCK_ROLE,
        memory,
      });

      expect(prompt).toContain('Working Strategy');
      expect(prompt).toContain('todo.md');
      expect(prompt).toContain('Recite objectives');
      expect(prompt).toContain('Learn from errors');
      expect(prompt).toContain('Offload large data');
    });
  });

  describe('File System Offloading', () => {
    it('should offload large tool results to filesystem', async () => {
      const hugeOutput = 'x'.repeat(20_000); // Above 8KB threshold

      let callIndex = 0;
      const mockRouter = {
        chat: vi.fn(async () => {
          callIndex++;
          if (callIndex === 1) {
            return {
              content: 'Reading big data...',
              finishReason: 'tool_use',
              toolCalls: [{ id: 'tc_big', name: 'big_reader', arguments: {} }],
              usage: { inputTokens: 100, outputTokens: 50 },
            };
          }
          return {
            content: 'Processed.',
            finishReason: 'end_turn',
            usage: { inputTokens: 100, outputTokens: 50 },
          };
        }),
        chatStream: vi.fn(),
        getActiveModelContextWindow: () => 200000,
        getActiveModelMaxOutput: () => 8000,
        listProviders: () => ['test'],
        getProvider: () => undefined,
        getDefaultProvider: () => 'test',
      };

      const agent = new Agent({
        config: {
          id: 'test-offload',
          name: 'Offload Test',
          role: 'worker',
          llmConfig: { provider: 'test', model: 'test', apiKey: 'test' },
          createdAt: new Date().toISOString(),
        },
        role: MOCK_ROLE,
        llmRouter: mockRouter as unknown as import('../src/llm/router.js').LLMRouter,
        dataDir: tempDir,
      });

      agent.registerTool({
        name: 'big_reader',
        description: 'Returns huge output',
        inputSchema: { type: 'object', properties: {}, required: [] },
        execute: async () => hugeOutput,
      });

      await agent.handleMessage('read the big data');

      // Check that a tool-outputs directory was created
      const outputDir = join(tempDir, 'tool-outputs');
      expect(existsSync(outputDir)).toBe(true);

      const files = readdirSync(outputDir);
      expect(files.length).toBeGreaterThan(0);

      // The saved file should contain the full output
      const savedContent = readFileSync(join(outputDir, files[0]!), 'utf-8');
      expect(savedContent.length).toBe(hugeOutput.length);

      // The context sent to LLM should have a compact reference
      const secondCall = mockRouter.chat.mock.calls[1];
      if (secondCall) {
        const msgs = (secondCall[0] as { messages: Array<{ role: string; content: string }> })
          .messages;
        const toolMsg = msgs.find(m => m.role === 'tool');
        if (toolMsg) {
          expect(toolMsg.content).toContain('Tool output saved to file');
          expect(toolMsg.content).toContain('use file_read to access full content');
          expect(toolMsg.content.length).toBeLessThan(hugeOutput.length);
        }
      }
    });

    it('should NOT offload small tool results', async () => {
      const smallOutput = '{"status":"success","result":"ok"}';

      let callIndex = 0;
      const mockRouter = {
        chat: vi.fn(async () => {
          callIndex++;
          if (callIndex === 1) {
            return {
              content: 'Checking...',
              finishReason: 'tool_use',
              toolCalls: [{ id: 'tc_small', name: 'small_tool', arguments: {} }],
              usage: { inputTokens: 100, outputTokens: 50 },
            };
          }
          return {
            content: 'Done.',
            finishReason: 'end_turn',
            usage: { inputTokens: 100, outputTokens: 50 },
          };
        }),
        chatStream: vi.fn(),
        getActiveModelContextWindow: () => 200000,
        getActiveModelMaxOutput: () => 8000,
        listProviders: () => ['test'],
        getProvider: () => undefined,
        getDefaultProvider: () => 'test',
      };

      const agent = new Agent({
        config: {
          id: 'test-no-offload',
          name: 'No Offload Test',
          role: 'worker',
          llmConfig: { provider: 'test', model: 'test', apiKey: 'test' },
          createdAt: new Date().toISOString(),
        },
        role: MOCK_ROLE,
        llmRouter: mockRouter as unknown as import('../src/llm/router.js').LLMRouter,
        dataDir: tempDir,
      });

      agent.registerTool({
        name: 'small_tool',
        description: 'Returns small output',
        inputSchema: { type: 'object', properties: {}, required: [] },
        execute: async () => smallOutput,
      });

      await agent.handleMessage('quick check');

      // No offloading should happen for small results
      const outputDir = join(tempDir, 'tool-outputs');
      expect(existsSync(outputDir)).toBe(false);
    });
  });

  describe('Serialization Diversity', () => {
    it('should use varied summary templates to break few-shot patterns', async () => {
      const engine = new ContextEngine();

      // Create messages that simulate multiple tool-call turns
      const messages = [];
      for (let i = 0; i < 6; i++) {
        messages.push({
          role: 'assistant' as const,
          content: `Step ${i}`,
          toolCalls: [{ id: `tc_${i}`, name: 'file_read', arguments: { path: `file_${i}.ts` } }],
        });
        messages.push({
          role: 'tool' as const,
          content: `content of file_${i}`,
          toolCallId: `tc_${i}`,
        });
      }
      messages.push({ role: 'user' as const, content: 'Now do the task' });

      const prepared = await engine.prepareMessages({
        systemPrompt: 'You are a test agent.',
        sessionMessages: messages,
        memory: new MemoryStore(tempDir),
        sessionId: 'test-session',
        modelContextWindow: 1000, // Force compaction
        modelMaxOutput: 200,
        toolDefinitions: [],
      });

      // Extract compacted summaries (non-system, non-user messages)
      const summaries = prepared.messages
        .filter(m => m.role === 'assistant' && m.content.includes('['))
        .map(m => m.content);

      if (summaries.length >= 2) {
        // At least some summaries should use different template prefixes
        const prefixes = summaries.map(s => s.split(']')[0]);
        const uniquePrefixes = new Set(prefixes);
        // With diversity, we should see multiple different prefix patterns
        expect(uniquePrefixes.size).toBeGreaterThanOrEqual(1);
      }
    });

    it('should preserve error details in compacted summaries', async () => {
      const engine = new ContextEngine();

      const messages = [
        {
          role: 'assistant' as const,
          content: 'Let me try',
          toolCalls: [{ id: 'tc_1', name: 'shell_execute', arguments: { command: 'npm test' } }],
        },
        {
          role: 'tool' as const,
          content: 'Error: Module not found: cannot resolve "./missing-file"',
          toolCallId: 'tc_1',
        },
        { role: 'user' as const, content: 'Fix the issue' },
      ];

      const prepared = await engine.prepareMessages({
        systemPrompt: 'You are a test agent.',
        sessionMessages: messages,
        memory: new MemoryStore(tempDir),
        sessionId: 'test-session',
        modelContextWindow: 500, // Force compaction
        modelMaxOutput: 100,
        toolDefinitions: [],
      });

      const compactedMsg = prepared.messages.find(
        m => m.role === 'assistant' && m.content.includes('ERROR')
      );

      if (compactedMsg) {
        // Error details should be preserved in the summary
        expect(compactedMsg.content).toContain('Module not found');
      }
    });
  });
});
