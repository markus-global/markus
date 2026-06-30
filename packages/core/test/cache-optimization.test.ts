/**
 * Cache & Context Engineering Optimization Tests
 *
 * Validates the cache optimization changes:
 * - Anthropic provider: cache breakpoints on messages, cache metrics parsing
 * - Context engine: duplicate tool rules removed, group_chat scenario, message cache breakpoint placement
 * - Session reuse: channel-stable session IDs for A2A/group chat
 * - Limits: CHANNEL_CONTEXT_MESSAGES value
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnthropicProvider } from '../src/llm/anthropic.js';
import { ContextEngine } from '../src/context-engine.js';
import type { LLMMessage, LLMResponse, RoleTemplate } from '@markus/shared';

const EXPECTED_CHANNEL_CONTEXT_MESSAGES = 40;

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Anthropic Provider — Cache Breakpoints & Metrics
// ═══════════════════════════════════════════════════════════════════════════════

describe('AnthropicProvider — cache optimization', () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    provider = new AnthropicProvider({ provider: 'anthropic', model: 'claude-sonnet-4-20250514', apiKey: 'test-key' });
  });

  describe('cache metrics parsing', () => {
    it('should parse cache_read_input_tokens and cache_creation_input_tokens from non-streaming response', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          content: [{ type: 'text', text: 'Hello' }],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 80,
            cache_read_input_tokens: 20,
          },
          stop_reason: 'end_turn',
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const response = await provider.chat({
        messages: [{ role: 'user', content: 'test' }],
      });

      expect(response.usage.inputTokens).toBe(100);
      expect(response.usage.outputTokens).toBe(50);
      expect(response.usage.cacheWriteTokens).toBe(80);
      expect(response.usage.cacheReadTokens).toBe(20);

      vi.unstubAllGlobals();
    });

    it('should leave cache tokens undefined when not present in response', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          content: [{ type: 'text', text: 'Hello' }],
          usage: { input_tokens: 100, output_tokens: 50 },
          stop_reason: 'end_turn',
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const response = await provider.chat({
        messages: [{ role: 'user', content: 'test' }],
      });

      expect(response.usage.cacheWriteTokens).toBeUndefined();
      expect(response.usage.cacheReadTokens).toBeUndefined();

      vi.unstubAllGlobals();
    });
  });

  describe('message cache breakpoints', () => {
    it('should add cache_control to text message with cacheBreakpoint', async () => {
      let capturedBody: Record<string, unknown> | undefined;
      const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 10, output_tokens: 5 },
            stop_reason: 'end_turn',
          }),
        });
      });
      vi.stubGlobal('fetch', mockFetch);

      await provider.chat({
        messages: [
          { role: 'user', content: 'old message' },
          { role: 'assistant', content: 'old reply', cacheBreakpoint: true },
          { role: 'user', content: 'new message' },
        ],
      });

      const msgs = capturedBody?.['messages'] as Array<Record<string, unknown>>;
      expect(msgs).toHaveLength(3);

      // The assistant message with cacheBreakpoint should be converted to content blocks
      const cachedMsg = msgs[1]!;
      expect(cachedMsg.role).toBe('assistant');
      expect(Array.isArray(cachedMsg.content)).toBe(true);
      const blocks = cachedMsg.content as Array<Record<string, unknown>>;
      expect(blocks[0]).toMatchObject({
        type: 'text',
        text: 'old reply',
        cache_control: { type: 'ephemeral' },
      });

      vi.unstubAllGlobals();
    });

    it('should add cache_control to last content block of tool_use message', async () => {
      let capturedBody: Record<string, unknown> | undefined;
      const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 10, output_tokens: 5 },
            stop_reason: 'end_turn',
          }),
        });
      });
      vi.stubGlobal('fetch', mockFetch);

      await provider.chat({
        messages: [
          {
            role: 'assistant',
            content: 'calling tool',
            toolCalls: [{ id: 'tc_1', name: 'file_read', arguments: { path: '/test' } }],
            cacheBreakpoint: true,
          },
          { role: 'tool', content: 'file contents', toolCallId: 'tc_1' },
          { role: 'user', content: 'new message' },
        ],
      });

      const msgs = capturedBody?.['messages'] as Array<Record<string, unknown>>;
      // First message is assistant with tool_use blocks — last block should have cache_control
      const assistantMsg = msgs[0]!;
      expect(assistantMsg.role).toBe('assistant');
      const blocks = assistantMsg.content as Array<Record<string, unknown>>;
      const lastBlock = blocks[blocks.length - 1]!;
      expect(lastBlock).toHaveProperty('cache_control', { type: 'ephemeral' });

      vi.unstubAllGlobals();
    });

    it('should add cache_control to tool_result message with cacheBreakpoint', async () => {
      let capturedBody: Record<string, unknown> | undefined;
      const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 10, output_tokens: 5 },
            stop_reason: 'end_turn',
          }),
        });
      });
      vi.stubGlobal('fetch', mockFetch);

      await provider.chat({
        messages: [
          { role: 'assistant', content: '', toolCalls: [{ id: 'tc_1', name: 'file_read', arguments: { path: '/test' } }] },
          { role: 'tool', content: 'file contents', toolCallId: 'tc_1', cacheBreakpoint: true },
          { role: 'user', content: 'new message' },
        ],
      });

      const msgs = capturedBody?.['messages'] as Array<Record<string, unknown>>;
      // Tool result message is the second one (converted to user role)
      const toolMsg = msgs[1]!;
      expect(toolMsg.role).toBe('user');
      const blocks = toolMsg.content as Array<Record<string, unknown>>;
      expect(blocks[0]).toHaveProperty('cache_control', { type: 'ephemeral' });

      vi.unstubAllGlobals();
    });

    it('should NOT add cache_control when cacheBreakpoint is not set', async () => {
      let capturedBody: Record<string, unknown> | undefined;
      const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 10, output_tokens: 5 },
            stop_reason: 'end_turn',
          }),
        });
      });
      vi.stubGlobal('fetch', mockFetch);

      await provider.chat({
        messages: [
          { role: 'user', content: 'old message' },
          { role: 'assistant', content: 'old reply' },
          { role: 'user', content: 'new message' },
        ],
      });

      const msgs = capturedBody?.['messages'] as Array<Record<string, unknown>>;
      // All messages should be plain strings, no cache_control
      for (const msg of msgs) {
        if (typeof msg.content === 'string') {
          // Plain string — no cache_control possible, that's fine
          continue;
        }
        const blocks = msg.content as Array<Record<string, unknown>>;
        for (const block of blocks) {
          expect(block).not.toHaveProperty('cache_control');
        }
      }

      vi.unstubAllGlobals();
    });
  });

  describe('streaming cache metrics', () => {
    it('should parse cache tokens from message_start event', async () => {
      const sseLines = [
        'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":0,"cache_creation_input_tokens":60,"cache_read_input_tokens":40}}}',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
        'data: {"type":"content_block_stop","index":0}',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
        'data: {"type":"message_stop"}',
      ].join('\n') + '\n';

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        body: {
          getReader: () => {
            let sent = false;
            return {
              read: () => {
                if (!sent) {
                  sent = true;
                  return Promise.resolve({ done: false, value: new TextEncoder().encode(sseLines) });
                }
                return Promise.resolve({ done: true, value: undefined });
              },
            };
          },
        },
      });
      vi.stubGlobal('fetch', mockFetch);

      const events: Array<Record<string, unknown>> = [];
      const response = await provider.chatStream(
        { messages: [{ role: 'user', content: 'test' }] },
        (event) => { events.push(event as Record<string, unknown>); },
      );

      expect(response.usage.cacheReadTokens).toBe(40);
      expect(response.usage.cacheWriteTokens).toBe(60);

      // The message_end event should also include cache tokens
      const endEvent = events.find(e => e.type === 'message_end');
      expect(endEvent).toBeDefined();
      const usage = endEvent!.usage as Record<string, unknown>;
      expect(usage.cacheReadTokens).toBe(40);
      expect(usage.cacheWriteTokens).toBe(60);

      vi.unstubAllGlobals();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Context Engine — Cache Optimization
// ═══════════════════════════════════════════════════════════════════════════════

function makeRole(overrides?: Partial<RoleTemplate>): RoleTemplate {
  return {
    id: 'test-role',
    name: 'Engineer',
    description: 'A test engineer',
    category: 'engineering',
    systemPrompt: 'You are a test engineer.',
    defaultSkills: [],
    heartbeatChecklist: '',
    defaultPolicies: [],
    builtIn: false,
    ...overrides,
  };
}

function makeMockMemory() {
  return {
    getMemoryPath: () => '/tmp/test-memory.md',
    readMemory: () => '',
    getLongTermMemory: () => '',
    getLongTermMemoryExcluding: () => '',
    getLongTermSection: () => '',
    addEntry: vi.fn(),
    getEntries: () => [],
    getEntriesByTag: () => [],
    search: () => [],
    listEntries: () => [],
    searchEntries: () => Promise.resolve([]),
    removeEntries: () => 0,
    replaceEntries: vi.fn(),
    removeEntriesByTag: () => 0,
    addLongTermMemory: vi.fn(),
    compressLongTermMemory: () => ({ charsBefore: 0, charsAfter: 0, sectionsBefore: 0, sectionsAfter: 0, truncatedChunks: 0 }),
    getSession: () => undefined,
    listSessions: () => [],
    getLatestSession: () => undefined,
    getLatestMainSession: () => undefined,
    createSession: () => ({ id: 'test-session', agentId: 'test', createdAt: new Date().toISOString() }),
    getOrCreateSession: () => ({ id: 'test-session', agentId: 'test', createdAt: new Date().toISOString() }),
    appendMessage: vi.fn(),
    getRecentMessages: () => [],
    getSessionMessages: () => [],
    compactSession: () => ({ summary: '', flushedCount: 0 }),
    summarizeAndTruncate: () => [],
    writeDailyLog: vi.fn(),
    getDailyLog: () => '',
    getRecentDailyLogs: () => '',
  };
}

describe('ContextEngine — cache optimization', () => {
  let engine: ContextEngine;

  beforeEach(() => {
    engine = new ContextEngine();
  });

  describe('group_chat scenario in buildScenarioSection', () => {
    it('should include group_chat rules in system prompt when scenario is group_chat', async () => {
      const result = await engine.buildSystemPrompt({
        agentId: 'test-agent',
        agentName: 'TestAgent',
        role: makeRole(),
        memory: makeMockMemory() as any,
        scenario: 'group_chat' as any,
      });

      expect(result.text).toContain('team group chat channel');
      expect(result.text).toContain('DEFAULT IS SILENCE');
      expect(result.text).toContain('@MENTION');
      expect(result.text).toContain('GROUP CHAT PROCESSING CHECKLIST');
      expect(result.text).toContain('agent_send_group_message');
    });

    it('should include manager-specific rule 4 when isTeamManager is true', async () => {
      const result = await engine.buildSystemPrompt({
        agentId: 'test-agent',
        agentName: 'TestAgent',
        role: makeRole({ name: 'Manager', description: 'A manager', systemPrompt: 'You are a manager.' }),
        memory: makeMockMemory() as any,
        scenario: 'group_chat' as any,
        isTeamManager: true,
      });

      expect(result.text).toContain('task_create');
      expect(result.text).toContain('Verbal delegation without a task is NOT allowed');
    });

    it('should include worker-specific rule 4 when isTeamManager is false', async () => {
      const result = await engine.buildSystemPrompt({
        agentId: 'test-agent',
        agentName: 'TestAgent',
        role: makeRole(),
        memory: makeMockMemory() as any,
        scenario: 'group_chat' as any,
        isTeamManager: false,
      });

      expect(result.text).toContain('verify a task has been created');
    });
  });

  describe('no duplicate Tool Usage Rules', () => {
    it('should have Tool Usage Rules only once in the system prompt', async () => {
      const result = await engine.buildSystemPrompt({
        agentId: 'test-agent',
        agentName: 'TestAgent',
        role: makeRole(),
        memory: makeMockMemory() as any,
        scenario: 'chat' as any,
      });

      const matches = result.text.match(/## Tool Usage Rules/g);
      expect(matches).not.toBeNull();
      expect(matches!.length).toBe(1);
    });
  });

  describe('prepareMessages cache breakpoint', () => {
    it('should mark the last message before current turn with cacheBreakpoint', async () => {
      const sessionMessages: LLMMessage[] = [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'second question' },
        { role: 'assistant', content: 'second answer' },
        { role: 'user', content: 'current question' },
      ];

      const result = await engine.prepareMessages({
        systemPrompt: 'You are helpful.',
        sessionMessages,
        modelContextWindow: 200000,
        memory: makeMockMemory() as any,
        sessionId: 'test-session',
        agentId: 'test-agent',
      });

      // Skip the system message (index 0), then find the breakpoint
      const nonSystemMsgs = result.messages.slice(1);
      // Current turn starts at the last user message ('current question')
      // So breakpoint should be on the message before it ('second answer')
      const breakpointMsgs = nonSystemMsgs.filter(m => m.cacheBreakpoint);
      expect(breakpointMsgs.length).toBe(1);
      expect(breakpointMsgs[0]!.content).toBe('second answer');
      expect(breakpointMsgs[0]!.role).toBe('assistant');
    });

    it('should not set cacheBreakpoint when only one user message exists', async () => {
      const sessionMessages: LLMMessage[] = [
        { role: 'user', content: 'only message' },
      ];

      const result = await engine.prepareMessages({
        systemPrompt: 'You are helpful.',
        sessionMessages,
        modelContextWindow: 200000,
        memory: makeMockMemory() as any,
        sessionId: 'test-session',
        agentId: 'test-agent',
      });

      const breakpointMsgs = result.messages.filter(m => m.cacheBreakpoint);
      expect(breakpointMsgs.length).toBe(0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Shared Constants
// ═══════════════════════════════════════════════════════════════════════════════

describe('Cache optimization constants', () => {
  it('CHANNEL_CONTEXT_MESSAGES should be 40 (reduced from 80)', async () => {
    // Read the source file directly since compiled .js may be stale
    const fs = await import('node:fs');
    const src = fs.readFileSync(
      new URL('../../shared/src/limits.ts', import.meta.url),
      'utf-8',
    );
    const match = src.match(/export const CHANNEL_CONTEXT_MESSAGES\s*=\s*(\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(EXPECTED_CHANNEL_CONTEXT_MESSAGES);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. LLMMessage type — cacheBreakpoint field
// ═══════════════════════════════════════════════════════════════════════════════

describe('LLMMessage cacheBreakpoint field', () => {
  it('should accept cacheBreakpoint as an optional boolean', () => {
    const msg: LLMMessage = {
      role: 'assistant',
      content: 'test',
      cacheBreakpoint: true,
    };
    expect(msg.cacheBreakpoint).toBe(true);
  });

  it('should default to undefined when not set', () => {
    const msg: LLMMessage = {
      role: 'user',
      content: 'test',
    };
    expect(msg.cacheBreakpoint).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. LLMResponse usage — cache token fields
// ═══════════════════════════════════════════════════════════════════════════════

describe('LLMResponse usage cache fields', () => {
  it('should include optional cacheReadTokens and cacheWriteTokens', () => {
    const response: LLMResponse = {
      content: 'test',
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 80,
        cacheWriteTokens: 20,
      },
      finishReason: 'end_turn',
    };
    expect(response.usage.cacheReadTokens).toBe(80);
    expect(response.usage.cacheWriteTokens).toBe(20);
  });
});
