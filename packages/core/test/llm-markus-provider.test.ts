import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MarkusProvider } from '../src/llm/markus-provider.js';

function mockResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => JSON.stringify(body),
    body: null,
  } as Response;
}

function chatCompletionBody(content = 'Hello') {
  return {
    choices: [{
      message: { content },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  };
}

describe('MarkusProvider CU tracking', () => {
  let provider: MarkusProvider;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    provider = new MarkusProvider({
      apiKey: 'test-key',
      baseUrl: 'http://localhost:8787',
      model: 'markus-lite',
    });
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.stubGlobal('fetch', originalFetch);
    vi.restoreAllMocks();
  });

  it('parses CU headers from non-streaming responses', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse(chatCompletionBody(), 200, {
        'x-cu-cost': '42',
        'x-cu-remaining': '900',
        'x-cu-limit': '1000',
      }),
    );

    const response = await provider.chat({
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(response.cuCost).toBe(42);
    const stats = provider.getCuUsageStats();
    expect(stats.totalCuUsed).toBe(42);
    expect(stats.cuUsedToday).toBe(42);
    expect(stats.cuRemaining).toBe(900);
    expect(stats.cuLimit).toBe(1000);
    expect(stats.lastCuCost).toBe(42);
  });

  it('accumulates CU across multiple requests', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        mockResponse(chatCompletionBody('a'), 200, {
          'x-cu-cost': '10',
          'x-cu-remaining': '990',
          'x-cu-limit': '1000',
        }),
      )
      .mockResolvedValueOnce(
        mockResponse(chatCompletionBody('b'), 200, {
          'x-cu-cost': '25',
          'x-cu-remaining': '965',
          'x-cu-limit': '1000',
        }),
      );

    await provider.chat({ messages: [{ role: 'user', content: 'one' }] });
    await provider.chat({ messages: [{ role: 'user', content: 'two' }] });

    const stats = provider.getCuUsageStats();
    expect(stats.totalCuUsed).toBe(35);
    expect(stats.cuUsedToday).toBe(35);
    expect(stats.lastCuCost).toBe(25);
  });

  it('resets cuUsedToday on date rollover', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-28T12:00:00.000Z'));

    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse(chatCompletionBody(), 200, {
        'x-cu-cost': '15',
        'x-cu-remaining': '985',
        'x-cu-limit': '1000',
      }),
    );
    await provider.chat({ messages: [{ role: 'user', content: 'day1' }] });

    vi.setSystemTime(new Date('2026-06-29T12:00:00.000Z'));
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse(chatCompletionBody(), 200, {
        'x-cu-cost': '8',
        'x-cu-remaining': '977',
        'x-cu-limit': '1000',
      }),
    );
    await provider.chat({ messages: [{ role: 'user', content: 'day2' }] });

    const stats = provider.getCuUsageStats();
    expect(stats.totalCuUsed).toBe(23);
    expect(stats.cuUsedToday).toBe(8);

    vi.useRealTimers();
  });

  it('throws CU_EXCEEDED on 402 and 429', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse({ error: { message: 'quota exceeded' } }, 402),
    );
    await expect(
      provider.chat({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow('CU_EXCEEDED:');

    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse('rate limited', 429),
    );
    await expect(
      provider.chat({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow('CU_EXCEEDED:');
  });

  it('extracts CU from streaming response headers', async () => {
    const sseBody = [
      'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}\n',
      'data: {"usage":{"prompt_tokens":80,"completion_tokens":20}}\n',
      'data: [DONE]\n',
    ].join('');

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseBody));
        controller.close();
      },
    });

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({
        'x-cu-cost': '33',
        'x-cu-remaining': '967',
        'x-cu-limit': '1000',
      }),
      body: stream,
      text: async () => sseBody,
    } as Response);

    const events: unknown[] = [];
    const response = await provider.chatStream(
      { messages: [{ role: 'user', content: 'stream' }] },
      (e) => events.push(e),
    );

    expect(response.cuCost).toBe(33);
    expect(provider.getCuUsageStats().totalCuUsed).toBe(33);
    expect(events.some((e: any) => e.type === 'message_end')).toBe(true);
  });

  it('getCuUsageStats returns zeros when no quota headers seen', () => {
    const stats = provider.getCuUsageStats();
    expect(stats.totalCuUsed).toBe(0);
    expect(stats.cuUsedToday).toBe(0);
    expect(stats.cuRemaining).toBe(-1);
    expect(stats.cuLimit).toBe(0);
    expect(stats.lastCuCost).toBe(0);
  });

  it('fetchModels calls /v1/models endpoint', async () => {
    const models = [
      {
        id: 'markus-lite',
        display_name: 'Markus Lite',
        capability: 'text',
        tier: 'flash',
        context_window: 65536,
        max_output_tokens: 8192,
        supports_vision: false,
        supports_reasoning: false,
      },
    ];

    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse({ data: models }, 200),
    );

    const result = await provider.fetchModels();
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:8787/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-key' },
      }),
    );
    expect(result).toEqual(models);
  });
});
