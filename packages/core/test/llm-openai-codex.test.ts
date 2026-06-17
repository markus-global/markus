import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CodexResponsesProvider } from '../src/llm/openai-codex.js';

vi.mock('../src/llm/proxy-fetch.js', () => ({
  proxyFetch: vi.fn(),
}));

import { proxyFetch } from '../src/llm/proxy-fetch.js';

function createSSEStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < lines.length) {
        controller.enqueue(encoder.encode(lines[i++]));
      } else {
        controller.close();
      }
    },
  });
}

function sseLines(events: Array<{ type: string; [key: string]: unknown }>): string[] {
  return events.flatMap(ev => [
    `event: ${ev.type}\n`,
    `data: ${JSON.stringify(ev)}\n`,
    '\n',
  ]);
}

describe('CodexResponsesProvider', () => {
  const tokenResolver = vi.fn(async () => 'codex-token');

  beforeEach(() => {
    vi.mocked(tokenResolver).mockResolvedValue('codex-token');
    vi.mocked(proxyFetch).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('constructs with defaults and configures settings', () => {
    const provider = new CodexResponsesProvider(
      { provider: 'openai-codex', model: 'gpt-5.5' },
      tokenResolver,
      'acct-123',
    );
    expect(provider.name).toBe('openai-codex');
    expect(provider.model).toBe('gpt-5.5');

    provider.configure({ model: 'gpt-5.4', baseUrl: 'https://custom.example/codex', timeoutMs: 60_000 });
    provider.setAccountId('acct-456');
    expect(provider.model).toBe('gpt-5.4');
  });

  it('chatStream parses text deltas and usage from SSE', async () => {
    const provider = new CodexResponsesProvider(
      { provider: 'openai-codex', model: 'gpt-5.5', baseUrl: 'https://chatgpt.com/backend-api/codex' },
      tokenResolver,
    );

    vi.mocked(proxyFetch).mockResolvedValue({
      ok: true,
      body: createSSEStream(sseLines([
        { type: 'response.output_text.delta', delta: 'Hello' },
        { type: 'response.output_text.delta', delta: ' world' },
        {
          type: 'response.completed',
          response: {
            status: 'completed',
            usage: { input_tokens: 12, output_tokens: 4 },
          },
        },
      ])),
    } as Response);

    const events: string[] = [];
    const response = await provider.chatStream(
      { messages: [{ role: 'user', content: 'Hi' }] },
      (ev) => events.push(ev.type),
    );

    expect(response.content).toBe('Hello world');
    expect(response.usage).toEqual({ inputTokens: 12, outputTokens: 4 });
    expect(events).toContain('text_delta');
    expect(events).toContain('message_end');
    expect(vi.mocked(proxyFetch)).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/codex/responses',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer codex-token',
        }),
      }),
    );
  });

  it('chatStream handles reasoning and tool call events', async () => {
    const provider = new CodexResponsesProvider(
      { provider: 'openai-codex', model: 'gpt-5.5' },
      tokenResolver,
    );

    vi.mocked(proxyFetch).mockResolvedValue({
      ok: true,
      body: createSSEStream(sseLines([
        { type: 'response.reasoning_summary_text.delta', delta: 'Thinking...' },
        {
          type: 'response.output_item.added',
          item: { type: 'function_call', id: 'item-1', name: 'search', call_id: 'call-1' },
        },
        { type: 'response.function_call_arguments.delta', item_id: 'item-1', delta: '{"q":' },
        { type: 'response.function_call_arguments.delta', item_id: 'item-1', delta: '"test"}' },
        {
          type: 'response.output_item.done',
          item: { type: 'function_call', id: 'item-1', name: 'search', call_id: 'call-1', arguments: '{"q":"test"}' },
        },
        {
          type: 'response.completed',
          response: { status: 'completed', usage: { prompt_tokens: 5, completion_tokens: 2 } },
        },
      ])),
    } as Response);

    const response = await provider.chatStream(
      {
        messages: [{ role: 'user', content: 'Search' }],
        tools: [{ name: 'search', description: 'Search web', inputSchema: { type: 'object', properties: {} } }],
      },
      () => {},
    );

    expect(response.reasoningContent).toBe('Thinking...');
    expect(response.toolCalls).toEqual([
      { id: 'call-1', name: 'search', arguments: { q: 'test' } },
    ]);
    expect(response.finishReason).toBe('tool_use');
  });

  it('chat collects full stream into non-streaming response', async () => {
    const provider = new CodexResponsesProvider(
      { provider: 'openai-codex', model: 'gpt-5.5' },
      tokenResolver,
    );

    vi.mocked(proxyFetch).mockResolvedValue({
      ok: true,
      body: createSSEStream(sseLines([
        { type: 'response.output_text.delta', delta: 'Done' },
        {
          type: 'response.completed',
          response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } },
        },
      ])),
    } as Response);

    const response = await provider.chat({ messages: [{ role: 'user', content: 'Hi' }] });
    expect(response.content).toBe('Done');
  });

  it('converts system, tool, assistant, and image messages', async () => {
    const provider = new CodexResponsesProvider(
      { provider: 'openai-codex', model: 'gpt-5.5' },
      tokenResolver,
      'acct-1',
    );

    let capturedBody: Record<string, unknown> = {};
    vi.mocked(proxyFetch).mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        body: createSSEStream(sseLines([
          {
            type: 'response.completed',
            response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } },
          },
        ])),
      } as Response;
    });

    await provider.chatStream({
      messages: [
        { role: 'system', content: 'Be helpful' },
        { role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image_url', image_url: { url: 'https://img.example/a.png' } }] },
        { role: 'assistant', content: 'Sure', toolCalls: [{ id: 'c1', name: 'fetch', arguments: { url: 'x' } }] },
        { role: 'tool', toolCallId: 'c1', content: 'result data' },
      ],
    }, () => {});

    expect(capturedBody.instructions).toContain('Be helpful');
    expect(capturedBody.input).toBeDefined();
    expect(vi.mocked(proxyFetch)).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ 'ChatGPT-Account-Id': 'acct-1' }),
      }),
    );
  });

  it('throws on request failure and HTTP errors', async () => {
    const provider = new CodexResponsesProvider(
      { provider: 'openai-codex', model: 'gpt-5.5' },
      tokenResolver,
    );

    vi.mocked(proxyFetch).mockRejectedValue(new Error('network down'));
    await expect(provider.chatStream({ messages: [{ role: 'user', content: 'Hi' }] }, () => {}))
      .rejects.toThrow('Codex API request failed');

    vi.mocked(proxyFetch).mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    } as Response);
    await expect(provider.chatStream({ messages: [{ role: 'user', content: 'Hi' }] }, () => {}))
      .rejects.toThrow('Codex API error 401');
  });

  it('deduplicates tools with same name', async () => {
    const provider = new CodexResponsesProvider(
      { provider: 'openai-codex', model: 'gpt-5.5' },
      tokenResolver,
    );

    let capturedBody: Record<string, unknown> = {};
    vi.mocked(proxyFetch).mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        body: createSSEStream(sseLines([
          {
            type: 'response.completed',
            response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } },
          },
        ])),
      } as Response;
    });

    await provider.chatStream({
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [
        { name: 'dup', description: 'A', inputSchema: {} },
        { name: 'dup', description: 'B', inputSchema: {} },
      ],
    }, () => {});

    const tools = capturedBody.tools as Array<{ name: string }>;
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe('dup');
  });
});
