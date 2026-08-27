import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MarkusProvider,
  clearMarkusModelListCache,
  formatUpstreamMediaError,
  resolveMarkusRoute,
  stripMarkusNamespace,
  normalizeMarkusHubOrigin,
  parseRetryAfterMs,
} from '../src/llm/markus-provider.js';
import {
  defaultVoiceForModel,
  parseOpenRouterAffordableTokens,
  parseOpenRouterPromptAffordableTokens,
  clampReservationMaxTokens,
  clampMaxTokensToRemainingAfford,
} from '../src/llm/provider.js';

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

function chatCompletionBody(content = 'Hello', costUsd?: number) {
  return {
    choices: [{
      message: { content },
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      ...(costUsd !== undefined ? { cost: costUsd } : {}),
    },
  };
}

describe('resolveMarkusRoute', () => {
  it('always returns openrouter', () => {
    expect(resolveMarkusRoute('deepseek/deepseek-v4-flash')).toBe('openrouter');
    expect(resolveMarkusRoute('openai/gpt-4o')).toBe('openrouter');
    expect(resolveMarkusRoute('markus/openai/gpt-image-1')).toBe('openrouter');
  });
});

describe('normalizeMarkusHubOrigin', () => {
  it('rewrites apex markus.global to www (avoids cu/sync 401 on 307)', () => {
    expect(normalizeMarkusHubOrigin('https://markus.global')).toBe('https://www.markus.global');
    expect(normalizeMarkusHubOrigin('https://markus.global/api/models/live/markus'))
      .toBe('https://www.markus.global');
    expect(normalizeMarkusHubOrigin('https://www.markus.global')).toBe('https://www.markus.global');
  });
});

describe('stripMarkusNamespace', () => {
  it('strips a leading markus/ (slash) gateway prefix', () => {
    expect(stripMarkusNamespace('markus/openai/gpt-image-1')).toBe('openai/gpt-image-1');
    expect(stripMarkusNamespace('markus/deepgram/aura-2')).toBe('deepgram/aura-2');
    expect(stripMarkusNamespace('MARKUS/openai/tts-1')).toBe('openai/tts-1');
  });

  it('leaves bare vendor slugs untouched', () => {
    expect(stripMarkusNamespace('openai/gpt-image-1')).toBe('openai/gpt-image-1');
    expect(stripMarkusNamespace('deepseek/deepseek-v4-flash')).toBe('deepseek/deepseek-v4-flash');
  });
});

describe('parseOpenRouterAffordableTokens', () => {
  it('parses can-only-afford from OpenRouter 402 bodies', () => {
    expect(parseOpenRouterAffordableTokens(
      'You requested up to 65536 tokens, but can only afford 28046.',
    )).toBe(Math.floor(28046 * 0.98));
    expect(parseOpenRouterAffordableTokens('no afford info')).toBeNull();
  });
});

describe('parseOpenRouterPromptAffordableTokens', () => {
  it('parses prompt tokens limit ceiling from OpenRouter 402 bodies', () => {
    expect(parseOpenRouterPromptAffordableTokens(
      'Prompt tokens limit exceeded: 86869 > 37406',
    )).toBe(Math.floor(37406 * 0.95));
    expect(parseOpenRouterPromptAffordableTokens('can only afford 28046')).toBeNull();
  });
});

describe('S-max-tokens-clamp-remaining (Afford.S4)', () => {
  it('clamps reservation afford with floor 512', () => {
    expect(clampReservationMaxTokens(7378)).toBeLessThanOrEqual(7378);
    expect(clampReservationMaxTokens(7378)).toBeGreaterThanOrEqual(512);
    expect(clampReservationMaxTokens(100)).toBe(512);
  });

  it('clamps first-request max_tokens to remaining afford', () => {
    const clamped = clampMaxTokensToRemainingAfford({
      requested: 13_156,
      promptAfford: 20_000,
      estimatedPrompt: 12_000,
      margin: 500,
    });
    expect(clamped).toBeLessThanOrEqual(20_000 - 12_000 - 500);
    expect(clamped).toBeLessThan(13_156);
    expect(clamped).toBeGreaterThanOrEqual(512);
  });
});

describe('formatUpstreamMediaError', () => {
  it('unwraps JSON and keeps Supported voices list for the agent to retry', () => {
    const body = JSON.stringify({
      error: { message: 'Unknown voice "alloy". Supported voices: aura-2-thalia-en, aura-2-apollo-en' },
    });
    const msg = formatUpstreamMediaError(400, body);
    expect(msg).toContain('Unknown voice "alloy"');
    expect(msg).toContain('aura-2-thalia-en');
    expect(msg).toMatch(/retry with one of the supported voices/i);
  });

  it('points missing models at llm_get_capability_routing', () => {
    const body = JSON.stringify({ error: { message: 'Model openai/tts-1 does not exist', code: 400 } });
    const msg = formatUpstreamMediaError(400, body);
    expect(msg).toContain('does not exist');
    expect(msg).toMatch(/llm_get_capability_routing/);
    expect(msg).toMatch(/usable models/i);
  });

  it('truncates huge voice lists so they do not blow the context window', () => {
    const voices = Array.from({ length: 200 }, (_, i) => `voice-${i}`).join(', ');
    const body = JSON.stringify({ error: { message: `Unknown voice "x". Supported voices: ${voices}` } });
    const msg = formatUpstreamMediaError(400, body);
    expect(msg.length).toBeLessThan(1400);
    expect(msg).toContain('truncated');
  });
});

describe('defaultVoiceForModel', () => {
  it('picks a Deepgram voice for aura models (never "alloy")', () => {
    expect(defaultVoiceForModel('deepgram/aura-2')).toMatch(/^aura-2-/);
    expect(defaultVoiceForModel('markus/deepgram/aura-2')).toMatch(/^aura-2-/);
  });

  it('picks alloy for OpenAI-family tts models', () => {
    expect(defaultVoiceForModel('openai/tts-1')).toBe('alloy');
    expect(defaultVoiceForModel('tts-1-hd')).toBe('alloy');
  });

  it('picks a MiniMax voice for speech models (never omit — upstream requires string)', () => {
    expect(defaultVoiceForModel('minimax/speech-2.8-hd')).toContain('Chinese');
    expect(defaultVoiceForModel('speech-02-hd')).toContain('Chinese');
  });

  it('returns undefined for unknown families so the caller can omit voice', () => {
    expect(defaultVoiceForModel('elevenlabs/multilingual-v2')).toBeUndefined();
    expect(defaultVoiceForModel(undefined)).toBeUndefined();
  });
});

describe('MarkusProvider CU tracking', () => {
  let provider: MarkusProvider;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    provider = new MarkusProvider({
      apiKey: 'sk-or-test',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelsUrl: 'http://hub.test/api/models/live/markus',
      model: 'deepseek/deepseek-chat',
    });
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.stubGlobal('fetch', originalFetch);
    vi.restoreAllMocks();
  });

  it('records OpenRouter usage.cost from non-streaming responses', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(chatCompletionBody('hi', 0.042)));

    const response = await provider.chat({
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(response.cuCost).toBeUndefined();
    const stats = provider.getCostUsdStats();
    expect(stats.lastCostUsd).toBe(0.042);
    expect(stats.totalCostUsd).toBe(0.042);
  });

  it('accumulates usage.cost across multiple requests', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockResponse(chatCompletionBody('a', 0.01)))
      .mockResolvedValueOnce(mockResponse(chatCompletionBody('b', 0.025)));

    await provider.chat({ messages: [{ role: 'user', content: 'one' }] });
    await provider.chat({ messages: [{ role: 'user', content: 'two' }] });

    const stats = provider.getCostUsdStats();
    expect(stats.totalCostUsd).toBeCloseTo(0.035);
    expect(stats.lastCostUsd).toBe(0.025);
  });

  it('ignores Worker x-cu-* headers on OpenRouter path', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse(chatCompletionBody('ok', 0.01), 200, {
        'x-cu-cost': '42',
        'x-cu-remaining': '900',
        'x-cu-limit': '1000',
      }),
    );
    await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(provider.getCuUsageStats().totalCuUsed).toBe(0);
    expect(provider.getCostUsdStats().lastCostUsd).toBe(0.01);
  });

  it('throws CU_EXCEEDED on 402 only when Hub confirms zero remaining', async () => {
    const p = new MarkusProvider({
      apiKey: 'sk-or-test',
      baseUrl: 'https://openrouter.ai/api/v1',
      hubUrl: 'http://hub.test',
      hubToken: 'hub_jwt',
      model: 'deepseek/deepseek-chat',
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockResponse({ error: { message: 'quota exceeded' } }, 402))
      .mockResolvedValueOnce(mockResponse({
        ok: true,
        remainingCu: 0,
        openrouter: { remainingUsd: 0 },
      }, 200));
    await expect(
      p.chat({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow('CU_EXCEEDED:');
  });

  it('throws MARKUS_UPSTREAM_ERROR on 402 when Hub sync is unavailable', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse({ error: { message: 'quota exceeded' } }, 402),
    );
    await expect(
      provider.chat({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/MARKUS_UPSTREAM_ERROR:.*Hub credit sync failed|remaining credits/i);
  });

  it('on 402: clamps max_tokens even when Hub cu/sync returns 401', async () => {
    const p = new MarkusProvider({
      apiKey: 'sk-or-test',
      baseUrl: 'https://openrouter.ai/api/v1',
      hubUrl: 'http://hub.test',
      hubToken: 'hub_jwt',
      model: 'deepseek/deepseek-v4-flash',
    });
    const affordMsg =
      'This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 28046.';
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockResponse({ error: { message: affordMsg } }, 402))
      .mockResolvedValueOnce(mockResponse({ error: 'unauthorized' }, 401)) // cu/sync
      .mockResolvedValueOnce(mockResponse(chatCompletionBody('ok-despite-sync-401', 0.01)));

    const res = await p.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.content).toBe('ok-despite-sync-401');
    const retryBody = JSON.parse(vi.mocked(fetch).mock.calls[2]![1]!.body as string);
    const affordable = parseOpenRouterAffordableTokens(affordMsg)!;
    expect(retryBody.max_tokens).toBe(clampReservationMaxTokens(affordable));
    expect(retryBody.max_tokens).toBeLessThanOrEqual(affordable);
  });

  it('on 402: calls Hub cu/sync and retries once when remaining > 0', async () => {
    const p = new MarkusProvider({
      apiKey: 'sk-or-test',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelsUrl: 'http://hub.test/api/models/live/markus',
      hubUrl: 'http://hub.test',
      hubToken: 'hub_jwt',
      model: 'deepseek/deepseek-chat',
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockResponse({ error: { message: 'key limit exceeded' } }, 402))
      .mockResolvedValueOnce(mockResponse({
        ok: true,
        remainingCu: 5000,
        openrouter: { remainingUsd: 5 },
      }, 200))
      .mockResolvedValueOnce(mockResponse(chatCompletionBody('recovered', 0.01)));

    const res = await p.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.content).toBe('recovered');
    expect(vi.mocked(fetch).mock.calls[1]?.[0]).toBe('http://hub.test/api/user/cu/sync');
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });

  it('on 402: retries with affordable max_tokens from OpenRouter error body', async () => {
    const p = new MarkusProvider({
      apiKey: 'sk-or-test',
      baseUrl: 'https://openrouter.ai/api/v1',
      hubUrl: 'http://hub.test',
      hubToken: 'hub_jwt',
      model: 'deepseek/deepseek-v4-flash',
    });
    const affordMsg =
      'This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 28046.';
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockResponse({ error: { message: affordMsg } }, 402))
      .mockResolvedValueOnce(mockResponse({
        ok: true,
        remainingCu: 3000,
        openrouter: { remainingUsd: 2 },
      }, 200))
      .mockResolvedValueOnce(mockResponse(chatCompletionBody('ok-after-clamp', 0.01)));

    const res = await p.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.content).toBe('ok-after-clamp');
    const retryBody = JSON.parse(vi.mocked(fetch).mock.calls[2]![1]!.body as string);
    const affordable = parseOpenRouterAffordableTokens(affordMsg)!;
    expect(retryBody.max_tokens).toBe(clampReservationMaxTokens(affordable));
  });

  it('S-max-tokens-clamp-remaining: 402 afford 7378 → retry max_tokens ≤ 7378; proactive clamp when promptAfford known', async () => {
    const p = new MarkusProvider({
      apiKey: 'sk-or-test',
      baseUrl: 'https://openrouter.ai/api/v1',
      hubUrl: 'http://hub.test',
      hubToken: 'hub_jwt',
      model: 'deepseek/deepseek-v4-flash',
      maxTokens: 13_156,
    });
    const affordMsg =
      'This request requires more credits, or fewer max_tokens. You requested up to 13156 tokens, but can only afford 7378.';
    // Tight prompt afford so remaining output << 13156 after margin
    const promptLimitMsg = 'Prompt tokens limit exceeded: 20000 > 8000';
    vi.mocked(fetch)
      // Turn 1: reservation 402 → clamp retry
      .mockResolvedValueOnce(mockResponse({ error: { message: affordMsg } }, 402))
      .mockResolvedValueOnce(mockResponse({
        ok: true,
        remainingCu: 3000,
        openrouter: { remainingUsd: 2 },
      }, 200))
      .mockResolvedValueOnce(mockResponse(chatCompletionBody('after-7378', 0.01)))
      // Turn 2: record prompt afford; sync 401 so request fails but hint is kept
      .mockResolvedValueOnce(mockResponse({ error: { message: promptLimitMsg } }, 402))
      .mockResolvedValueOnce(mockResponse({ error: 'unauthorized' }, 401))
      // Turn 3: first request should already be clamped (no 402)
      .mockResolvedValueOnce(mockResponse(chatCompletionBody('proactive-ok', 0.01)));

    const r1 = await p.chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 13_156 });
    expect(r1.content).toBe('after-7378');
    const retry1 = JSON.parse(vi.mocked(fetch).mock.calls[2]![1]!.body as string);
    expect(retry1.max_tokens).toBeLessThanOrEqual(7378);
    expect(retry1.max_tokens).toBeGreaterThanOrEqual(512);

    await expect(
      p.chat({ messages: [{ role: 'user', content: 'hi2' }], maxTokens: 13_156 }),
    ).rejects.toThrow(/MARKUS_UPSTREAM_ERROR/);
    expect(p.getLastPromptAffordTokens()).toBe(Math.floor(8000 * 0.95));

    const r3 = await p.chat({
      messages: [{ role: 'user', content: 'x'.repeat(4000) }],
      maxTokens: 13_156,
    });
    expect(r3.content).toBe('proactive-ok');
    const lastCall = vi.mocked(fetch).mock.calls.at(-1)!;
    const body3 = JSON.parse(lastCall[1]!.body as string);
    expect(body3.max_tokens).toBeLessThan(13_156);
    expect(body3.max_tokens).toBeGreaterThanOrEqual(512);
    // Success clears the stale ceiling
    expect(p.getLastPromptAffordTokens()).toBeNull();
  });

  it('clears cached prompt afford after successful chat', async () => {
    const p = new MarkusProvider({
      apiKey: 'sk-or-test',
      baseUrl: 'https://openrouter.ai/api/v1',
      hubUrl: 'http://hub.test',
      hubToken: 'hub_jwt',
      model: 'deepseek/deepseek-v4-flash',
    });
    const promptLimitMsg = 'Prompt tokens limit exceeded: 50000 > 20000';
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockResponse({ error: { message: promptLimitMsg } }, 402))
      .mockResolvedValueOnce(mockResponse({
        ok: true,
        remainingCu: 50,
        openrouter: { remainingUsd: 0.01 },
      }, 200))
      .mockResolvedValueOnce(mockResponse(chatCompletionBody('ok', 0.01)));

    await p.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(p.getLastPromptAffordTokens()).toBeNull();
  });

  it('on 402: still CU_EXCEEDED when sync reports zero remaining', async () => {
    const p = new MarkusProvider({
      apiKey: 'sk-or-test',
      baseUrl: 'https://openrouter.ai/api/v1',
      hubUrl: 'http://hub.test',
      hubToken: 'hub_jwt',
      model: 'deepseek/deepseek-chat',
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockResponse({ error: { message: 'key limit exceeded' } }, 402))
      .mockResolvedValueOnce(mockResponse({
        ok: true,
        remainingCu: 0,
        openrouter: { remainingUsd: 0 },
      }, 200));

    await expect(
      p.chat({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow('CU_EXCEEDED:');
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it('on 402: does not claim CU_EXCEEDED when Hub still has remaining after retry', async () => {
    const p = new MarkusProvider({
      apiKey: 'sk-or-test',
      baseUrl: 'https://openrouter.ai/api/v1',
      hubUrl: 'http://hub.test',
      hubToken: 'hub_jwt',
      model: 'deepseek/deepseek-chat',
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockResponse({ error: { message: 'key limit exceeded' } }, 402))
      .mockResolvedValueOnce(mockResponse({
        ok: true,
        remainingCu: 5000,
        openrouter: { remainingUsd: 5 },
      }, 200))
      .mockResolvedValueOnce(mockResponse({ error: { message: 'key limit exceeded' } }, 402))
      .mockResolvedValueOnce(mockResponse({
        ok: true,
        remainingCu: 5000,
        openrouter: { remainingUsd: 5 },
      }, 200));

    await expect(
      p.chat({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/MARKUS_UPSTREAM_ERROR:/);
  });

  it('throws MARKUS_RATE_LIMITED on 429 after retries exhausted', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockResponse({ error: { message: 'rate limited' } }, 429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(mockResponse({ error: { message: 'rate limited' } }, 429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(mockResponse({ error: { message: 'rate limited' } }, 429, { 'retry-after': '0' }));
    await expect(
      provider.chat({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow('MARKUS_RATE_LIMITED:');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('retries 429 honoring Retry-After then succeeds', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockResponse({ error: { message: 'rate limited' } }, 429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(mockResponse(chatCompletionBody('ok after retry')));
    const res = await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.content).toBe('ok after retry');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('parseRetryAfterMs reads seconds and caps long waits', () => {
    const res = mockResponse({}, 429, { 'retry-after': '120' });
    expect(parseRetryAfterMs(res)).toBe(60_000);
    expect(parseRetryAfterMs(mockResponse({}, 429, { 'retry-after': '2' }))).toBe(2_000);
    expect(parseRetryAfterMs(mockResponse({}, 429))).toBeNull();
  });

  it('mid-stream rate limit with partial content continues as max_tokens', async () => {
    const sseBody = [
      'data: {"choices":[{"delta":{"content":"Hello "},"finish_reason":null}]}\n',
      'data: {"error":{"code":429,"message":"Rate limit exceeded"},"choices":[{"index":0,"delta":{"content":""},"finish_reason":"error"}]}\n',
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
      headers: new Headers(),
      body: stream,
      text: async () => sseBody,
    } as Response);

    const response = await provider.chatStream(
      { messages: [{ role: 'user', content: 'hi' }] },
      () => {},
    );
    expect(response.content).toContain('Hello');
    expect(response.finishReason).toBe('max_tokens');
  });

  it('does not lower stream idle timeout when configure(timeoutMs) is set', () => {
    const p = new MarkusProvider({
      provider: 'markus',
      model: 'test',
      apiKey: 'sk-or-test',
    });
    p.configure({ provider: 'markus', model: 'test', timeoutMs: 30_000 });
    // Private fields — probe via a hanging stream + short idle would be heavy;
    // assert via casting the runtime shape used by chatStream.
    expect((p as unknown as { streamTimeoutMs: number }).streamTimeoutMs).toBe(180_000);
    expect((p as unknown as { chatTimeoutMs: number }).chatTimeoutMs).toBe(30_000);
  });

  it('returns max_tokens on idle timeout when partial content already streamed', async () => {
    const encoder = new TextEncoder();
    // Mock body is not tied to fetch AbortSignal; error it shortly after the
    // idle timer so reader.read() rejects with idleTimedOut already set.
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(
          'data: {"choices":[{"delta":{"content":"Hello partial"},"finish_reason":null}]}\n\n',
        ));
        setTimeout(() => {
          try {
            controller.error(new DOMException('The operation was aborted.', 'AbortError'));
          } catch { /* already closed */ }
        }, 120);
      },
    });
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: stream,
      text: async () => '',
    } as Response);

    const p = new MarkusProvider({
      provider: 'markus',
      model: 'test',
      apiKey: 'sk-or-test',
      streamTimeoutMs: 80,
    });

    const response = await p.chatStream(
      { messages: [{ role: 'user', content: 'hi' }] },
      () => {},
    );
    expect(response.content).toContain('Hello partial');
    expect(response.finishReason).toBe('max_tokens');
  }, 5_000);

  it('records usage.cost from streaming chunks', async () => {
    const sseBody = [
      'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}\n',
      'data: {"usage":{"prompt_tokens":80,"completion_tokens":20,"cost":0.033}}\n',
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
      headers: new Headers(),
      body: stream,
      text: async () => sseBody,
    } as Response);

    const events: unknown[] = [];
    const response = await provider.chatStream(
      { messages: [{ role: 'user', content: 'stream' }] },
      (e) => events.push(e),
    );

    expect(response.cuCost).toBeUndefined();
    expect(provider.getCostUsdStats().lastCostUsd).toBe(0.033);
    expect(events.some((e: any) => e.type === 'message_end')).toBe(true);
  });

  it('requests OpenRouter reasoning for deepseek-v4 and surfaces thinking_delta', async () => {
    const sseBody = [
      'data: {"choices":[{"delta":{"reasoning":"先打开 B 站首页。"},"finish_reason":null}]}\n',
      'data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","text":"再做快照。"}]},"finish_reason":null}]}\n',
      'data: {"choices":[{"delta":{"content":"好的"},"finish_reason":null}]}\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
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
      headers: new Headers(),
      body: stream,
      text: async () => sseBody,
    } as Response);

    const events: Array<{ type: string; thinking?: string }> = [];
    const response = await provider.chatStream(
      { messages: [{ role: 'user', content: 'open bilibili' }], model: 'deepseek/deepseek-v4-flash' },
      (e) => events.push(e as { type: string; thinking?: string }),
    );

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string);
    expect(body.reasoning).toEqual({ enabled: true, effort: 'high' });
    expect(response.reasoningContent).toBe('先打开 B 站首页。再做快照。');
    expect(events.filter((e) => e.type === 'thinking_delta').map((e) => e.thinking)).toEqual([
      '先打开 B 站首页。',
      '再做快照。',
    ]);
  });

  it('parses non-streaming reasoning_content into reasoningContent', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse({
      choices: [{
        message: { content: '答案', reasoning_content: '思考步骤' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }));

    const response = await provider.chat({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'deepseek/deepseek-v4-flash',
    });
    expect(response.reasoningContent).toBe('思考步骤');
    expect(response.content).toBe('答案');
  });

  it('parses streamed tool calls (regression: tool_use turns must carry toolCalls)', async () => {
    const sseBody = [
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'deliverable_search', arguments: '' } }] }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":' } }] }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"email"}' } }] }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    ].map(l => `data: ${l}\n`).join('') + 'data: [DONE]\n';

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode(sseBody)); controller.close(); },
    });

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: stream,
      text: async () => sseBody,
    } as Response);

    const events: any[] = [];
    const response = await provider.chatStream(
      { messages: [{ role: 'user', content: 'check email' }] },
      (e) => events.push(e),
    );

    expect(response.finishReason).toBe('tool_use');
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls![0]).toEqual({ id: 'call_1', name: 'deliverable_search', arguments: { query: 'email' } });
    expect(events.some(e => e.type === 'tool_call_start')).toBe(true);
    expect(events.some(e => e.type === 'tool_call_end')).toBe(true);
  });

  it('recovers text-emitted tool calls from non-streaming content (deepseek DSML markup)', async () => {
    // Real-world shape: the model wrote the tool call as text (Anthropic-style
    // <invoke> markup wrapped in DeepSeek token noise) instead of tool_calls.
    const leaked = '好的老板，我来创建需求和任务。\n\n<｜｜DSML｜｜tool_calls>\n<｜DSML｜｜invoke name="list_projects">\n\n</｜DSML｜｜invoke>\n</｜DSML｜｜tool_calls>';
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse({
      choices: [{ message: { content: leaked }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }));

    const response = await provider.chat({ messages: [{ role: 'user', content: 'create' }] });

    expect(response.finishReason).toBe('tool_use');
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls![0].name).toBe('list_projects');
    expect(response.toolCalls![0].arguments).toEqual({});
    // Markup stripped from the visible content; only the preamble remains.
    expect(response.content).toBe('好的老板，我来创建需求和任务。');
    expect(response.content).not.toContain('invoke');
  });

  it('recovers text-emitted tool calls with parameters and coerces string="false"', async () => {
    const leaked = 'Preamble.\n<invoke name="schedule_wakeup"><parameter name="note" string="true">check later</parameter><parameter name="in_seconds" string="false">3600</parameter></invoke>';
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse({
      choices: [{ message: { content: leaked }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }));

    const response = await provider.chat({ messages: [{ role: 'user', content: 'remind' }] });

    expect(response.finishReason).toBe('tool_use');
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls![0].name).toBe('schedule_wakeup');
    expect(response.toolCalls![0].arguments).toEqual({ note: 'check later', in_seconds: 3600 });
    expect(response.content).toBe('Preamble.');
  });

  it('does not treat plain content as tool calls', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(chatCompletionBody('Just a normal reply, no tools.')));
    const response = await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(response.finishReason).toBe('end_turn');
    expect(response.toolCalls).toBeUndefined();
    expect(response.content).toBe('Just a normal reply, no tools.');
  });

  it('getCuUsageStats returns zeros when no quota headers seen', () => {
    const stats = provider.getCuUsageStats();
    expect(stats.totalCuUsed).toBe(0);
    expect(stats.cuUsedToday).toBe(0);
    expect(stats.cuRemaining).toBe(-1);
    expect(stats.cuLimit).toBe(0);
    expect(stats.lastCuCost).toBe(0);
  });

  it('fetchModels returns fallback when modelsUrl is unset (no Worker /v1/models)', async () => {
    clearMarkusModelListCache();
    const alone = new MarkusProvider({
      apiKey: 'sk-or-test',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelsUrl: '',
      model: 'deepseek/deepseek-chat',
    });
    const result = await alone.fetchModels();
    // modelsUrl 为空：不请求远端，返回缓存（此时无）或内置兜底模型（空列表）
    expect(fetch).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('fetches Hub catalog without sending credentials', async () => {
    clearMarkusModelListCache();
    const dual = new MarkusProvider({
      apiKey: 'sk-or-member',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelsUrl: 'http://hub.test/api/models/live/markus',
      model: '',
    });
    const models = [
      {
        id: 'deepseek/deepseek-v4-flash',
        display_name: 'DeepSeek: V4 Flash',
        capability: 'text',
        tier: 'flash',
        context_window: 128000,
        max_output_tokens: 8192,
        supports_vision: false,
        supports_reasoning: false,
        is_default: true,
        route: 'openrouter',
      },
    ];
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse({ data: models, region: 'INTL' }, 200));

    const result = await dual.fetchModels();
    expect(result[0]?.id).toBe('deepseek/deepseek-v4-flash');
    expect(fetch).toHaveBeenCalledWith(
      'http://hub.test/api/models/live/markus',
      expect.objectContaining({
        headers: expect.not.objectContaining({ Authorization: expect.anything() }),
      }),
    );
  });

  it('routes all chat models to OpenRouter with member key', async () => {
    clearMarkusModelListCache();
    const dual = new MarkusProvider({
      apiKey: 'sk-or-member',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelsUrl: 'http://hub.test/api/models/live/markus',
      model: 'deepseek/deepseek-v4-pro',
    });

    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(chatCompletionBody('or'), 200));
    await dual.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'deepseek/deepseek-v4-pro' });
    expect(String(vi.mocked(fetch).mock.calls[0]![0])).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect((vi.mocked(fetch).mock.calls[0]![1] as { headers: Record<string, string> }).headers['Authorization'])
      .toBe('Bearer sk-or-member');
    const body0 = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string);
    expect(body0.model).toBe('deepseek/deepseek-v4-pro');

    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(chatCompletionBody('or'), 200));
    await dual.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'deepseek/deepseek-chat' });
    expect(String(vi.mocked(fetch).mock.calls[1]![0])).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect((vi.mocked(fetch).mock.calls[1]![1] as { headers: Record<string, string> }).headers['Authorization'])
      .toBe('Bearer sk-or-member');
  });

  it('fails when OR key missing (no Worker fallback)', async () => {
    // 屏蔽 env 回退 key（本机 CI 可能配置了 OPENROUTER_API_KEY），确保走「无 key」路径
    vi.stubEnv('MARKUS_OPENROUTER_KEY', '');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    // chat() 先做配额预检（assertCreditsAvailable 可能 fetch），给 mock 默认响应避免 res.ok 报错
    vi.mocked(fetch).mockResolvedValue(mockResponse({ ok: true, cuRemaining: 100, cuLimit: 1000 }));
    const noKey = new MarkusProvider({
      baseUrl: 'https://openrouter.ai/api/v1',
      modelsUrl: '',
      model: 'deepseek/deepseek-chat',
    });
    await expect(
      noKey.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'deepseek/deepseek-chat' }),
    ).rejects.toThrow(/apiKey|OpenRouter|reconnect/i);
    // 断言最终不发起真正的 chat/completions 请求（resolveRequestTarget 先抛错）
    expect(vi.mocked(fetch).mock.calls.filter(c => String(c[0]).includes('chat/completions'))).toHaveLength(0);
    vi.unstubAllEnvs();
  });

  it('maps OpenRouter 403 key-limit without claiming CU_EXCEEDED when Hub budget unknown', async () => {
    const dual = new MarkusProvider({
      apiKey: 'sk-or-member',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'deepseek/deepseek-chat',
    });
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse(
        {
          error: {
            message: 'Key limit exceeded (total limit). Manage at https://openrouter.ai/workspaces/xxx',
            code: 403,
          },
        },
        403,
      ),
    );
    let err: unknown;
    try {
      await dual.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'deepseek/deepseek-chat' });
    } catch (e) {
      err = e;
    }
    expect(String(err)).toMatch(/^Error: MARKUS_UPSTREAM_ERROR:/);
    expect(String(err)).not.toMatch(/openrouter\.ai/i);
  });

  it('OR path sends catalog OR slug as-is (no alias remap)', async () => {
    clearMarkusModelListCache();
    const dual = new MarkusProvider({
      apiKey: 'sk-or-member',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelsUrl: 'http://hub.test/api/models/live/markus',
      model: 'deepseek/deepseek-v4-flash',
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockResponse({
        data: [{
          id: 'deepseek/deepseek-v4-flash',
          display_name: 'DeepSeek V4 Flash',
          capability: 'text',
          tier: 'flash',
          context_window: 128000,
          max_output_tokens: 8192,
          supports_vision: false,
          supports_reasoning: false,
          route: 'openrouter',
        }],
      }, 200))
      .mockResolvedValueOnce(mockResponse(chatCompletionBody('or'), 200));
    await dual.fetchModels();
    await dual.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'deepseek/deepseek-v4-flash' });
    const body = JSON.parse(vi.mocked(fetch).mock.calls[1]![1]!.body as string);
    expect(body.model).toBe('deepseek/deepseek-v4-flash');
    expect(String(vi.mocked(fetch).mock.calls[1]![0])).toContain('openrouter.ai');
  });

  it('strips markus/ prefix before OpenRouter; unknown slug still attempts OR', async () => {
    const dual = new MarkusProvider({
      apiKey: 'sk-or-member',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'markus/openai/gpt-4o',
    });
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(chatCompletionBody('ok'), 200));
    await dual.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'markus/openai/gpt-4o' });
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string);
    expect(body.model).toBe('openai/gpt-4o');
    expect(String(vi.mocked(fetch).mock.calls[0]![0])).toBe('https://openrouter.ai/api/v1/chat/completions');
  });
});

describe('MarkusProvider multimodal (OpenRouter path)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.stubGlobal('fetch', originalFetch);
    vi.restoreAllMocks();
  });

  function dualProvider() {
    return new MarkusProvider({
      apiKey: 'sk-or-member',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelsUrl: 'http://hub.test/api/models/live/markus',
      model: 'openai/gpt-image-1',
    });
  }

  it('exposes imageGeneration/tts/stt/videoGeneration when OpenRouter credentials exist', () => {
    const caps = dualProvider().getCapabilities();
    expect(caps.imageGeneration).toBe(true);
    expect(caps.tts).toBe(true);
    expect(caps.stt).toBe(true);
    expect(caps.videoGeneration).toBe(true);
  });

  it('generateImage posts to OpenRouter /images and persists b64_json locally', async () => {
    // 1x1 PNG
    const tinyPng =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse({ data: [{ b64_json: tinyPng, media_type: 'image/png' }] }, 200),
    );
    const result = await dualProvider().generateImage('a cat', { model: 'openai/gpt-image-1' });
    expect(result[0]?.path).toMatch(/img-\d+-0\.png$/);
    expect(result[0]?.base64).toBeUndefined();
    expect(result[0]?.mediaType).toBe('image/png');
    expect(fetch).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/images',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer sk-or-member' }),
      }),
    );
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string);
    expect(body.model).toBe('openai/gpt-image-1');
    expect(body.response_format).toBeUndefined();
  });

  it('generateSpeech posts to OpenRouter audio/speech', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      text: async () => '',
      headers: new Headers({ 'content-type': 'audio/mpeg' }),
    } as Response);
    const result = await dualProvider().generateSpeech('hello', { model: 'openai/tts-1' });
    expect(result.format).toBe('mp3');
    expect(fetch).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/audio/speech',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer sk-or-member' }),
      }),
    );
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string);
    expect(body.response_format).toBe('mp3');
  });

  it('does not call Hub for multimodal requests', async () => {
    const tinyPng =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse({ data: [{ b64_json: tinyPng, media_type: 'image/png' }] }, 200),
    );
    await dualProvider().generateImage('x');
    const urls = vi.mocked(fetch).mock.calls.map(c => String(c[0]));
    expect(urls.every(u => !u.includes('hub.test'))).toBe(true);
  });

  it('generateImage 402: does not claim CU_EXCEEDED when Hub still has remaining', async () => {
    const p = new MarkusProvider({
      apiKey: 'sk-or-member',
      baseUrl: 'https://openrouter.ai/api/v1',
      hubUrl: 'http://hub.test',
      hubToken: 'hub_jwt',
      model: 'bytedance-seed/seedream-4.5',
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockResponse({ error: { message: 'Insufficient credits' } }, 402))
      .mockResolvedValueOnce(mockResponse({
        ok: true,
        remainingCu: 3000,
        openrouter: { remainingUsd: 2 },
      }, 200))
      .mockResolvedValueOnce(mockResponse({ error: { message: 'Insufficient credits' } }, 402))
      .mockResolvedValueOnce(mockResponse({
        ok: true,
        remainingCu: 3000,
        openrouter: { remainingUsd: 2 },
      }, 200));

    await expect(
      p.generateImage('portrait', { model: 'bytedance-seed/seedream-4.5' }),
    ).rejects.toThrow(/MARKUS_UPSTREAM_ERROR:/);
    expect(vi.mocked(fetch).mock.calls.some(c => String(c[0]).includes('/api/user/cu/sync'))).toBe(true);
  });

  it('generateImage 402: CU_EXCEEDED only when Hub confirms zero remaining', async () => {
    const p = new MarkusProvider({
      apiKey: 'sk-or-member',
      baseUrl: 'https://openrouter.ai/api/v1',
      hubUrl: 'http://hub.test',
      hubToken: 'hub_jwt',
      model: 'bytedance-seed/seedream-4.5',
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockResponse({ error: { message: 'Insufficient credits' } }, 402))
      .mockResolvedValueOnce(mockResponse({
        ok: true,
        remainingCu: 0,
        openrouter: { remainingUsd: 0 },
      }, 200));

    await expect(
      p.generateImage('portrait', { model: 'bytedance-seed/seedream-4.5' }),
    ).rejects.toThrow(/CU_EXCEEDED:/);
  });

  it('refuses to send a text model to a media endpoint (no confusing 404)', async () => {
    clearMarkusModelListCache();
    const provider = new MarkusProvider({
      apiKey: 'sk-or-member',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'markus-old', // bare markus-* id — never a valid media OR slug
    });
    await expect(provider.generateSpeech('hello', { model: 'markus-old' })).rejects.toThrow(/TTS model configured/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('transcribeSpeech sends JSON input_audio (OpenRouter primary STT path)', async () => {
    // Preferred path: JSON body with base64 input_audio — not multipart, and never
    // response_format=text (OR rejects text/srt/vtt with 400).
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ text: 'hello world' }),
      text: async () => '{"text":"hello world"}',
      headers: new Headers(),
    } as Response);
    // Minimal RIFF/WAVE header so format detection returns wav
    const wav = Buffer.alloc(12);
    wav.write('RIFF', 0);
    wav.write('WAVE', 8);
    const text = await dualProvider().transcribeSpeech(wav, { model: 'deepgram/nova-3' });
    expect(text).toBe('hello world');
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(url)).toBe('https://openrouter.ai/api/v1/audio/transcriptions');
    expect((init as RequestInit).headers).toEqual(
      expect.objectContaining({ 'Content-Type': 'application/json' }),
    );
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe('deepgram/nova-3');
    expect(body.response_format).toBe('json');
    expect(body.input_audio.format).toBe('wav');
    expect(body.input_audio.data).toBe(wav.toString('base64'));
  });

  it('strips the markus/ gateway prefix before calling OpenRouter media', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      text: async () => '',
      headers: new Headers(),
    } as Response);
    await dualProvider().generateSpeech('hello', { model: 'markus/deepgram/aura-2' });
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string);
    expect(body.model).toBe('deepgram/aura-2');
    // And the default voice must be a Deepgram voice, never "alloy".
    expect(String(body.voice)).toMatch(/^aura-2-/);
  });

  it('generateVideo uses OpenRouter async /videos API (not chat completions)', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(fetch)
        .mockResolvedValueOnce(mockResponse({
          id: 'job-hh-1',
          polling_url: 'https://openrouter.ai/api/v1/videos/job-hh-1',
          status: 'pending',
        }, 202))
        .mockResolvedValueOnce(mockResponse({
          id: 'job-hh-1',
          status: 'completed',
          unsigned_urls: ['https://openrouter.ai/api/v1/videos/job-hh-1/content?index=0'],
        }, 200))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          arrayBuffer: async () => new Uint8Array([0, 0, 0, 1]).buffer,
          text: async () => '',
          headers: new Headers(),
        } as Response);

      const promise = dualProvider().generateVideo('a cat walking', {
        model: 'alibaba/happyhorse-1.1',
        duration: 3,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await promise;
      expect(result.status).toBe('completed');
      expect(result.taskId).toBe('job-hh-1');
      expect(result.path).toMatch(/vid-job-hh-1\.mp4$/);

      const urls = vi.mocked(fetch).mock.calls.map(c => String(c[0]));
      expect(urls[0]).toBe('https://openrouter.ai/api/v1/videos');
      expect(urls[1]).toBe('https://openrouter.ai/api/v1/videos/job-hh-1');
      expect(urls.every(u => !u.includes('chat/completions'))).toBe(true);

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string);
      expect(body.model).toBe('alibaba/happyhorse-1.1');
      expect(body.prompt).toBe('a cat walking');
      expect(body.duration).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('generateVideo normalizes input_references/frame_images to OpenAI ref shape', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(fetch)
        .mockResolvedValueOnce(mockResponse({
          id: 'job-ref-1',
          polling_url: 'https://openrouter.ai/api/v1/videos/job-ref-1',
          status: 'queued',
        }, 200))
        .mockResolvedValueOnce(mockResponse({
          id: 'job-ref-1',
          status: 'completed',
          unsigned_urls: ['https://content.test/ref-1.mp4'],
        }, 200))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          arrayBuffer: async () => new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]).buffer,
          text: async () => '',
          headers: new Headers({ 'content-type': 'video/mp4' }),
        } as Response);

      const promise = dualProvider().generateVideo('a dog on the moon', {
        model: 'bytedance/seedance-2.5',
        inputReferences: [
          { url: 'https://example.com/ref.png', type: 'image', weight: 0.7 },
        ],
        frameImages: [
          { url: 'https://example.com/first.png', frame_type: 'first_frame' },
        ],
      });

      await vi.advanceTimersByTimeAsync(5_000);
      const result = await promise;
      expect(result.status).toBe('completed');

      const createCall = vi.mocked(fetch).mock.calls[0]!;
      expect(String(createCall[0])).toBe('https://openrouter.ai/api/v1/videos');
      const body = JSON.parse(createCall[1]!.body as string);
      // Regression: upstream (OpenRouter videos API) expects OpenAI-style refs
      // { type: 'image_url', image_url: { url } }, NOT { url, type: 'image' }.
      expect(body.input_references).toEqual([
        { type: 'image_url', image_url: { url: 'https://example.com/ref.png' }, weight: 0.7 },
      ]);
      expect(body.frame_images).toEqual([
        { type: 'image_url', image_url: { url: 'https://example.com/first.png' }, frame_type: 'first_frame' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('soft-stop when remaining credits are 0', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    clearMarkusModelListCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    clearMarkusModelListCache();
  });

  it('does not soft-block when hubRemainingHint is 0 but Hub sync is unavailable', async () => {
    // Without a confirmed Hub empty balance, do not claim CU_EXCEEDED.
    vi.mocked(fetch).mockResolvedValue(mockResponse(chatCompletionBody('ok'), 200));
    const p = new MarkusProvider({
      provider: 'markus',
      apiKey: 'sk-or-test',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'deepseek/deepseek-chat',
    });
    p.setHubRemainingHint(0);
    const res = await p.chat({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'deepseek/deepseek-chat',
    });
    expect(res.content).toBe('ok');
    expect(fetch).toHaveBeenCalled();
  });

  it('refuses chat when Hub sync confirms remaining is zero', async () => {
    const p = new MarkusProvider({
      provider: 'markus',
      apiKey: 'sk-or-test',
      baseUrl: 'https://openrouter.ai/api/v1',
      hubUrl: 'http://hub.test',
      hubToken: 'hub_jwt',
      model: 'deepseek/deepseek-chat',
    });
    p.setHubRemainingHint(0);
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse({
      ok: true,
      remainingCu: 0,
      openrouter: { remainingUsd: 0 },
    }, 200));
    await expect(p.chat({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'deepseek/deepseek-chat',
    })).rejects.toThrow(/CU_EXCEEDED/);
  });

  it('allows chat again after hint is cleared', async () => {
    vi.mocked(fetch).mockResolvedValue(mockResponse(chatCompletionBody('ok'), 200, {
      'x-cu-cost': '1',
      'x-cu-remaining': '10',
      'x-cu-limit': '100',
    }));
    const p = new MarkusProvider({
      provider: 'markus',
      apiKey: 'sk-or-test',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'deepseek/deepseek-chat',
    });
    p.setHubRemainingHint(0);
    p.setHubRemainingHint(null);
    const res = await p.chat({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'deepseek/deepseek-chat',
    });
    expect(res.content).toBe('ok');
    expect(fetch).toHaveBeenCalled();
  });

  it('CACHE: splits system into stable tiers when systemCacheSegments provided (prefix-cache-friendly)', async () => {
    // Regression for slack cache hit rates: markus-provider used to call
    // convertMessagesOpenAI WITHOUT systemCacheSegments, so the assembled single
    // system message (bearing the per-turn dynamic tail) rode the request and
    // broke the implicit prefix-cache key every turn. Now it must split just like
    // the openai provider — 3 system messages, dynamic in last position.
    vi.mocked(fetch).mockResolvedValue(mockResponse(chatCompletionBody('ok'), 200, {
      'x-cu-cost': '1', 'x-cu-remaining': '10', 'x-cu-limit': '100',
    }));
    const p = new MarkusProvider({
      provider: 'markus', apiKey: 'sk-or-test',
      baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat',
    });
    await p.chat({
      messages: [
        { role: 'system', content: 'assembled' },
        { role: 'user', content: 'hi' },
      ],
      model: 'deepseek/deepseek-chat',
      systemCacheSegments: [
        { content: 'STABLE', cacheBreakpoint: true },
        { content: 'SEMI', cacheBreakpoint: true },
        { content: 'DYNAMIC' },
      ],
    });
    const last = vi.mocked(fetch).mock.calls.at(-1)!;
    const sent = JSON.parse(last[1]!.body as string);
    const sysMsgs = sent.messages.filter((m: { role: string }) => m.role === 'system');
    expect(sysMsgs.map((m: { content: string }) => m.content)).toEqual(['STABLE', 'SEMI', 'DYNAMIC']);
    expect(sent.messages[0].role).toBe('system');
  });

  it('CACHE: keeps original single-system behavior when no segments provided', async () => {
    vi.mocked(fetch).mockResolvedValue(mockResponse(chatCompletionBody('ok'), 200, {
      'x-cu-cost': '1', 'x-cu-remaining': '10', 'x-cu-limit': '100',
    }));
    const p = new MarkusProvider({
      provider: 'markus', apiKey: 'sk-or-test',
      baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat',
    });
    await p.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'deepseek/deepseek-chat' });
    const last = vi.mocked(fetch).mock.calls.at(-1)!;
    const sent = JSON.parse(last[1]!.body as string);
    expect(sent.messages.filter((m: { role: string }) => m.role === 'system')).toHaveLength(0);
  });
});
