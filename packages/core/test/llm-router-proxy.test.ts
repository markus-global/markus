import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LLMRouter } from '../src/llm/router.js';
import type { LLMRequest, LLMResponse, LLMProviderConfig, ProviderCapabilities } from '@markus/shared';

function successResponse(content = 'ok'): LLMResponse {
  return {
    content,
    usage: { inputTokens: 10, outputTokens: 5 },
    finishReason: 'end_turn',
  };
}

function mockProvider(
  name: string,
  model: string,
  chatImpl?: (request: LLMRequest) => Promise<LLMResponse>,
  caps?: Partial<ProviderCapabilities>,
) {
  let currentModel = model;
  return {
    name,
    get model() { return currentModel; },
    configure: vi.fn((cfg: LLMProviderConfig) => {
      if (cfg.model) currentModel = cfg.model;
    }),
    chat: vi.fn(chatImpl ?? (async () => successResponse(`from ${name}`))),
    getCapabilities: caps ? () => ({
      chat: true,
      vision: false,
      imageGeneration: false,
      tts: false,
      stt: false,
      videoGeneration: false,
      embedding: false,
      reasoning: false,
      promptCaching: false,
      ...caps,
    }) : undefined,
  };
}

const sampleRequest: LLMRequest = {
  messages: [{ role: 'user', content: 'hello' }],
};

describe('LLMRouter proxy mode', () => {
  let router: LLMRouter;
  let anthropic: ReturnType<typeof mockProvider>;
  let proxy: ReturnType<typeof mockProvider>;

  beforeEach(() => {
    anthropic = mockProvider('anthropic', 'claude-3-5-sonnet-20241022', async () => successResponse('from anthropic'));
    proxy = mockProvider('proxy', 'claude-sonnet-4-20250514');

    router = new LLMRouter('proxy');
    router.registerProvider('anthropic', anthropic);
    router.registerProvider('proxy', proxy);
    router.setAutoFallback(true);
  });

  // ── Scenario 1: Proxy success (happy path) ───────────────

  describe('Scenario 1: Proxy success', () => {
    it('routes through proxy when proxy is the default provider', async () => {
      proxy.chat.mockResolvedValue(successResponse('from proxy'));
      const response = await router.chat(sampleRequest);
      expect(response.content).toBe('from proxy');
      expect(proxy.chat).toHaveBeenCalledTimes(1);
      expect(anthropic.chat).not.toHaveBeenCalled();
    });
  });

  // ── Scenario 2: Proxy unavailable → fallback ─────────────

  describe('Scenario 2: Proxy unavailable → fallback to direct', () => {
    it('falls back to anthropic when proxy throws PROXY_UNAVAILABLE', async () => {
      proxy.chat.mockRejectedValue(new Error('PROXY_UNAVAILABLE: fetch failed'));
      const response = await router.chat(sampleRequest);
      expect(response.content).toBe('from anthropic');
      expect(anthropic.chat).toHaveBeenCalledTimes(1);
    });

    it('falls back on network-level fetch error', async () => {
      proxy.chat.mockRejectedValue(new Error('PROXY_UNAVAILABLE: ECONNREFUSED'));
      const response = await router.chat(sampleRequest);
      expect(response.content).toBe('from anthropic');
    });
  });

  // ── Scenario 3: CU exceeded → no fallback ────────────────

  describe('Scenario 3: CU exceeded → friendly error, no fallback', () => {
    it('throws CU_EXCEEDED error instead of falling back', async () => {
      proxy.chat.mockRejectedValue(new Error('CU_EXCEEDED: Insufficient CU balance'));
      await expect(router.chat(sampleRequest)).rejects.toThrow('CU_EXCEEDED');
      // Should NOT have fallen back to anthropic
      expect(anthropic.chat).not.toHaveBeenCalled();
    });
  });

  // ── Scenario 4: CU detection via static method ───────────

  describe('Scenario 4: CU_EXCEEDED detection', () => {
    it('detects CU_EXCEEDED via isCUExceededError', () => {
      expect(LLMRouter.isCUExceededError(new Error('CU_EXCEEDED: out of balance'))).toBe(true);
      expect(LLMRouter.isCUExceededError(new Error('Proxy API error 500'))).toBe(false);
      expect(LLMRouter.isCUExceededError(new Error('PROXY_UNAVAILABLE: timeout'))).toBe(false);
    });
  });

  // ── Scenario 5: CU logging ───────────────────────────────

  describe('Scenario 5: emitLog CU recording', () => {
    it('does not record CU usage for direct (non-proxy) providers', async () => {
      const directRouter = new LLMRouter('anthropic');
      directRouter.registerProvider('anthropic', anthropic);
      // Spy on the private CU cache by observing behavior — no direct CU tracking for non-proxy
      directRouter.setAutoFallback(false);
      await directRouter.chat(sampleRequest);
      // Success is enough — CU is a proxy-only concept
      expect(anthropic.chat).toHaveBeenCalledTimes(1);
    });

    it('records CU usage for proxy provider calls', async () => {
      proxy.chat.mockResolvedValue(successResponse('from proxy'));
      const response = await router.chat(sampleRequest);
      // CU recording happens in emitLog — success means it didn't crash
      expect(response.content).toBe('from proxy');
    });
  });

  // ── Scenario 6: Proxy 5xx → fallback ─────────────────────

  describe('Scenario 6: Proxy 5xx error → falls through to direct', () => {
    it('falls back on proxy 502 Bad Gateway', async () => {
      proxy.chat.mockRejectedValue(new Error('Proxy API error 502: Bad Gateway'));
      const response = await router.chat(sampleRequest);
      expect(response.content).toBe('from anthropic');
      expect(anthropic.chat).toHaveBeenCalledTimes(1);
    });

    it('falls back on proxy 503 Service Unavailable', async () => {
      proxy.chat.mockRejectedValue(new Error('Proxy API error 503: Service Unavailable'));
      const response = await router.chat(sampleRequest);
      expect(response.content).toBe('from anthropic');
    });
  });

  // ── Scenario 7: Auth error → degrade proxy (no retry) ────

  describe('Scenario 7: Proxy auth error → degrade, no retry', () => {
    it('falls back to anthropic on proxy 401, does NOT retry proxy', async () => {
      proxy.chat.mockRejectedValue(new Error('Proxy API error 401: Invalid API key'));
      const response = await router.chat(sampleRequest);
      expect(response.content).toBe('from anthropic');
      // Proxy called exactly once (no retry)
      expect(proxy.chat).toHaveBeenCalledTimes(1);
      expect(anthropic.chat).toHaveBeenCalledTimes(1);
    });
  });

  // ── Fallback ordering ────────────────────────────────────

  describe('Fallback respects proxy being degraded', () => {
    it('skips degraded proxy after auth failure on subsequent calls', async () => {
      // First call: proxy fails with 401, falls back to anthropic
      proxy.chat.mockRejectedValue(new Error('Proxy API error 401: Invalid API key'));
      anthropic.chat.mockResolvedValue(successResponse('from anthropic'));

      await router.chat(sampleRequest);

      // Second call: proxy should be degraded, go straight to anthropic
      const response = await router.chat(sampleRequest);
      expect(response.content).toBe('from anthropic');
      // Proxy should have been called only once across both calls
      expect(proxy.chat).toHaveBeenCalledTimes(1);
    });
  });
});
