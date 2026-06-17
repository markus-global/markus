import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AnthropicProvider } from '../src/llm/anthropic.js';

describe('AnthropicProvider', () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    provider = new AnthropicProvider({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      apiKey: 'ant-key',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('constructs with defaults', () => {
    expect(provider.name).toBe('anthropic');
    expect(provider.model).toBe('claude-sonnet-4-20250514');
  });

  it('configure updates model and apiKey', () => {
    provider.configure({
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      apiKey: 'new-key',
    });
    expect(provider.model).toBe('claude-opus-4-6');
  });

  it('chat returns success response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: [{ type: 'text', text: 'Hello from Claude' }],
        usage: { input_tokens: 12, output_tokens: 8 },
        stop_reason: 'end_turn',
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const response = await provider.chat({
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(response.content).toBe('Hello from Claude');
    expect(response.usage.inputTokens).toBe(12);
    expect(response.finishReason).toBe('end_turn');
  });

  it('throws on API error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('invalid api key'),
    }));

    await expect(provider.chat({
      messages: [{ role: 'user', content: 'Hi' }],
    })).rejects.toThrow('Anthropic API error 401');
  });

  it('handles tool use in response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: [
          { type: 'text', text: 'Let me search' },
          { type: 'tool_use', id: 'toolu_1', name: 'web_search', input: { query: 'weather' } },
        ],
        usage: { input_tokens: 20, output_tokens: 15 },
        stop_reason: 'tool_use',
      }),
    }));

    const response = await provider.chat({
      messages: [{ role: 'user', content: 'weather?' }],
      tools: [{ name: 'web_search', description: 'Search', inputSchema: { type: 'object', properties: {} } }],
    });

    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls![0].name).toBe('web_search');
    expect(response.toolCalls![0].arguments).toEqual({ query: 'weather' });
    expect(response.finishReason).toBe('tool_use');
  });

  it('adds prompt caching headers on cache breakpoint messages', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 5, output_tokens: 2 },
          stop_reason: 'end_turn',
        }),
      });
    }));

    await provider.chat({
      messages: [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Remember this', cacheBreakpoint: true },
      ],
    });

    const messages = capturedBody?.messages as Array<{ content: Array<{ cache_control?: { type: string } }> }>;
    expect(messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('builds structured system cache segments', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 5, output_tokens: 2 },
          stop_reason: 'end_turn',
        }),
      });
    }));

    await provider.chat({
      messages: [{ role: 'system', content: 'ignored' }, { role: 'user', content: 'Hi' }],
      systemCacheSegments: [
        { content: 'Stable prefix', cacheBreakpoint: true },
        { content: 'Dynamic suffix' },
      ],
    });

    const system = capturedBody?.system as Array<{ text: string; cache_control?: { type: string } }>;
    expect(Array.isArray(system)).toBe(true);
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(system[1].cache_control).toBeUndefined();
  });

  it('converts base64 image messages', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          content: [{ type: 'text', text: 'I see an image' }],
          usage: { input_tokens: 100, output_tokens: 10 },
          stop_reason: 'end_turn',
        }),
      });
    }));

    await provider.chat({
      messages: [{
        role: 'user',
        content: [{
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,abc123' },
        }, {
          type: 'text',
          text: 'What is this?',
        }],
      }],
    });

    const messages = capturedBody?.messages as Array<{ content: Array<{ type: string; source?: { type: string; data: string } }> }>;
    const imageBlock = messages[0].content.find(b => b.type === 'image');
    expect(imageBlock?.source).toEqual({ type: 'base64', media_type: 'image/png', data: 'abc123' });
  });

  it('converts tool result messages to user role with tool_result blocks', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          content: [{ type: 'text', text: 'done' }],
          usage: { input_tokens: 5, output_tokens: 2 },
          stop_reason: 'end_turn',
        }),
      });
    }));

    await provider.chat({
      messages: [{
        role: 'tool',
        content: 'search results here',
        toolCallId: 'toolu_abc',
      }],
    });

    const messages = capturedBody?.messages as Array<{ role: string; content: Array<{ type: string; tool_use_id?: string }> }>;
    expect(messages[0].role).toBe('user');
    expect(messages[0].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_abc' });
  });
});
