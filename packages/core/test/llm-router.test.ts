import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  LLMRouter,
  estimateQualityScore,
  tierFromQualityScore,
  costTierFromPrice,
} from '../src/llm/router.js';
import type { LLMProviderInterface, MultiModalProviderInterface } from '../src/llm/provider.js';
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
): LLMProviderInterface & { getCapabilities?: () => ProviderCapabilities } {
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

describe('tier classification helpers', () => {
  it('estimateQualityScore uses pricing tiers', () => {
    expect(estimateQualityScore('model', false, 5)).toBe(80);
    expect(estimateQualityScore('model', false, 1)).toBe(55);
    expect(estimateQualityScore('model', false, 0.1)).toBe(38);
  });

  it('estimateQualityScore boosts reasoning models', () => {
    expect(estimateQualityScore('small-model', true, 0.1)).toBe(48);
  });

  it('estimateQualityScore parses parameter count from model id', () => {
    expect(estimateQualityScore('llama-70b', false)).toBeGreaterThanOrEqual(75);
    expect(estimateQualityScore('qwen-7b', false)).toBeLessThanOrEqual(40);
  });

  it('tierFromQualityScore maps score to tier', () => {
    expect(tierFromQualityScore(80)).toBe('max');
    expect(tierFromQualityScore(55)).toBe('pro');
    expect(tierFromQualityScore(30)).toBe('base');
  });

  it('costTierFromPrice maps input cost to badge', () => {
    expect(costTierFromPrice(0)).toBe('$');
    expect(costTierFromPrice(0.3)).toBe('$');
    expect(costTierFromPrice(1)).toBe('$$');
    expect(costTierFromPrice(3)).toBe('$$$');
    expect(costTierFromPrice(10)).toBe('$$$$');
  });
});

describe('LLMRouter.createDefault', () => {
  it('registers providers with apiKey from configs', () => {
    const router = LLMRouter.createDefault({
      anthropic: { provider: 'anthropic', model: 'claude-sonnet-4-20250514', apiKey: 'ant' },
      openai: { provider: 'openai', model: 'gpt-4o', apiKey: 'oai' },
      deepseek: { provider: 'deepseek' as any, model: 'deepseek-v4-flash', apiKey: 'ds' },
    });

    expect(router.listProviders()).toEqual(expect.arrayContaining(['anthropic', 'openai', 'deepseek']));
  });

  it('enables auto-select when multiple providers registered', () => {
    const router = LLMRouter.createDefault({
      anthropic: { provider: 'anthropic', model: 'claude-sonnet-4-20250514', apiKey: 'ant' },
      openai: { provider: 'openai', model: 'gpt-4o', apiKey: 'oai' },
    }, 'anthropic');

    expect(router.isAutoSelectEnabled()).toBe(true);
    expect(router.getDefaultProvider()).toBe('anthropic');
  });

  it('registers ollama without apiKey', () => {
    const router = LLMRouter.createDefault({
      ollama: { provider: 'ollama', model: 'llama3.1', baseUrl: 'http://localhost:11434' },
    });
    expect(router.listProviders()).toContain('ollama');
  });
});

describe('LLMRouter.setCapabilityRouting', () => {
  let router: LLMRouter;

  beforeEach(() => {
    router = new LLMRouter('anthropic');
  });

  it('accepts valid capability type assignments', () => {
    router.setCapabilityRouting({
      assignments: {
        text: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
        image_generation: { provider: 'openai', model: 'dall-e-3' },
      },
    });

    expect(router.getCapabilityAssignment('text')).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
    });
    expect(router.getCapabilityAssignment('image_generation')?.provider).toBe('openai');
  });

  it('filters invalid capability type keys', () => {
    router.setCapabilityRouting({
      assignments: {
        invalid_capability: { provider: 'openai', model: 'gpt-4o' },
        text: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
      } as any,
    });

    expect(router.capabilityRouting.assignments).not.toHaveProperty('invalid_capability');
    expect(router.getCapabilityAssignment('text')).toBeDefined();
  });
});

describe('LLMRouter.resolveModalityCandidates', () => {
  it('includes only capable providers for image_generation', () => {
    const router = new LLMRouter('deepseek');
    router.registerProvider('deepseek', mockProvider('deepseek', 'deepseek-v4-flash', undefined, { imageGeneration: false }));
    router.registerProvider('minimax', mockProvider('minimax', 'MiniMax-M3', undefined, { imageGeneration: true }));
    router.setCapabilityRouting({ assignments: { image_generation: { provider: 'minimax', model: 'image-01' } } });

    const names = router.resolveModalityCandidates('image_generation').map(c => c.name);
    expect(names).toContain('minimax');
    expect(names).not.toContain('deepseek');
  });

  it('includes assignment even when provider lacks capability declaration', () => {
    const router = new LLMRouter('deepseek');
    router.registerProvider('deepseek', mockProvider('deepseek', 'deepseek-v4-flash'));
    router.setCapabilityRouting({ assignments: { image_generation: { provider: 'deepseek', model: 'some-model' } } });

    const names = router.resolveModalityCandidates('image_generation').map(c => c.name);
    expect(names).toContain('deepseek');
  });

  it('includes fallback assignment provider', () => {
    const router = new LLMRouter('deepseek');
    router.registerProvider('minimax', mockProvider('minimax', 'MiniMax-M3', undefined, { imageGeneration: true }));
    router.registerProvider('openai', mockProvider('openai', 'gpt-4o', undefined, { imageGeneration: true }));
    router.setCapabilityRouting({
      assignments: {
        image_generation: {
          provider: 'minimax',
          model: 'image-01',
          fallback: { provider: 'openai', model: 'dall-e-3' },
        },
      },
    });

    const names = router.resolveModalityCandidates('image_generation').map(c => c.name);
    expect(names).toEqual(expect.arrayContaining(['minimax', 'openai']));
  });

  it('includes text providers without capability filter for text capability', () => {
    const router = new LLMRouter('deepseek');
    router.registerProvider('deepseek', mockProvider('deepseek', 'deepseek-v4-flash'));
    router.registerProvider('minimax', mockProvider('minimax', 'MiniMax-M3', undefined, { imageGeneration: true }));
    router.setRoutingDefaultModel({ provider: 'minimax', model: 'MiniMax-M3' });

    const names = router.resolveModalityCandidates('text').map(c => c.name);
    expect(names).toContain('deepseek');
    expect(names).toContain('minimax');
  });
});

describe('LLMRouter.chat routing', () => {
  it('routes to capability assignment provider', async () => {
    const router = new LLMRouter('anthropic');
    const anthropic = mockProvider('anthropic', 'claude-sonnet-4-20250514');
    const openai = mockProvider('openai', 'gpt-4o');
    router.registerProvider('anthropic', anthropic);
    router.registerProvider('openai', openai);
    router.setCapabilityRouting({ assignments: { text: { provider: 'openai', model: 'gpt-4o' } } });

    const response = await router.chat({ messages: [{ role: 'user', content: 'Hi' }] });
    expect(response.content).toBe('from openai');
    expect(openai.chat).toHaveBeenCalled();
    expect(anthropic.chat).not.toHaveBeenCalled();
  });

  it('routes to explicit provider when specified', async () => {
    const router = new LLMRouter('anthropic');
    const anthropic = mockProvider('anthropic', 'claude-sonnet-4-20250514');
    const openai = mockProvider('openai', 'gpt-4o');
    router.registerProvider('anthropic', anthropic);
    router.registerProvider('openai', openai);

    await router.chat({ messages: [{ role: 'user', content: 'Hi' }] }, 'openai');
    expect(openai.chat).toHaveBeenCalled();
  });

  it('throws when provider not found', async () => {
    const router = new LLMRouter('anthropic');
    await expect(router.chat({ messages: [{ role: 'user', content: 'Hi' }] }))
      .rejects.toThrow('LLM provider not found');
  });
});

describe('LLMRouter fallback logic', () => {
  it('falls back to secondary provider when primary fails', async () => {
    const router = LLMRouter.createDefault({}, 'primary');
    const primary = mockProvider('primary', 'model-a', async () => {
      throw new Error('primary failed');
    });
    const secondary = mockProvider('secondary', 'model-b', async () => successResponse('fallback ok'));
    router.registerProvider('primary', primary);
    router.registerProvider('secondary', secondary);
    router.setDefaultProvider('primary');
    router.setFallbackOrder(['primary', 'secondary']);
    router.setAutoFallback(true);

    const response = await router.chat({ messages: [{ role: 'user', content: 'Hi' }] });
    expect(response.content).toBe('fallback ok');
    expect(secondary.chat).toHaveBeenCalled();
  });

  it('does not fallback when autoFallback is disabled', async () => {
    const router = new LLMRouter('primary');
    const primary = mockProvider('primary', 'model-a', async () => {
      throw new Error('primary failed');
    });
    const secondary = mockProvider('secondary', 'model-b');
    router.registerProvider('primary', primary);
    router.registerProvider('secondary', secondary);
    router.setAutoFallback(false);

    await expect(router.chat({ messages: [{ role: 'user', content: 'Hi' }] }))
      .rejects.toThrow('primary failed');
    expect(secondary.chat).not.toHaveBeenCalled();
  });

  it('still falls back to other providers on non-retryable auth errors', async () => {
    const router = new LLMRouter('primary');
    const primary = mockProvider('primary', 'model-a', async () => {
      throw new Error('OpenAI API error 401: invalid api key');
    });
    const secondary = mockProvider('secondary', 'model-b');
    router.registerProvider('primary', primary);
    router.registerProvider('secondary', secondary);
    router.setAutoFallback(true);

    const response = await router.chat({ messages: [{ role: 'user', content: 'Hi' }] });
    expect(response.content).toBe('from secondary');
    expect(primary.chat).toHaveBeenCalledTimes(1);
    expect(secondary.chat).toHaveBeenCalledTimes(1);
  });
});

describe('LLMRouter circuit breaker', () => {
  it('marks model degraded after consecutive retryable failures', async () => {
    const router = new LLMRouter('primary');
    const primary = mockProvider('primary', 'model-a', async () => {
      throw new Error('OpenAI API error 429: rate limit');
    });
    router.registerProvider('primary', primary);
    router.setAutoFallback(false);

    await expect(router.chat({ messages: [{ role: 'user', content: 'Hi' }] })).rejects.toThrow('429');
    await expect(router.chat({ messages: [{ role: 'user', content: 'Hi' }] })).rejects.toThrow('429');

    router.registerProvider('secondary', mockProvider('secondary', 'model-b'));
    router.setFallbackOrder(['primary', 'secondary']);
    router.setAutoFallback(true);

    const response = await router.chat({ messages: [{ role: 'user', content: 'Hi' }] });
    expect(response.content).toBe('from secondary');
  });

  it('immediately degrades provider on non-retryable billing error', async () => {
    const router = new LLMRouter('primary');
    const primary = mockProvider('primary', 'model-a', async () => {
      throw new Error('OpenAI API error 402: insufficient balance');
    });
    const secondary = mockProvider('secondary', 'model-b');
    router.registerProvider('primary', primary);
    router.registerProvider('secondary', secondary);
    router.setAutoFallback(true);

    const response = await router.chat({ messages: [{ role: 'user', content: 'Hi' }] });
    expect(response.content).toBe('from secondary');

    const response2 = await router.chat({ messages: [{ role: 'user', content: 'Hi again' }] });
    expect(response2.content).toBe('from secondary');
    expect(primary.chat).toHaveBeenCalledTimes(1);
  });
});

describe('LLMRouter utilities', () => {
  it('assessComplexity classifies requests', () => {
    expect(LLMRouter.assessComplexity({ messages: [{ role: 'user', content: 'hi' }] })).toBe('simple');
    expect(LLMRouter.assessComplexity({
      messages: [{ role: 'user', content: 'x'.repeat(3000) }],
      tools: [{ name: 't1', description: 'd', inputSchema: {} }],
    })).toBe('moderate');
    expect(LLMRouter.assessComplexity({
      messages: Array.from({ length: 20 }, () => ({ role: 'user' as const, content: 'msg' })),
    })).toBe('complex');
  });

  it('inferCapability detects image recognition', () => {
    const capabilityType = LLMRouter.inferCapability({
      messages: [{
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'https://example.com/img.png' } }],
      }],
    });
    expect(capabilityType).toBe('image_recognition');
  });

  it('selectForCapability uses assignment fallback when primary unavailable', () => {
    const router = new LLMRouter('anthropic');
    router.registerProvider('primary', mockProvider('primary', 'm1'));
    router.registerProvider('fallback', mockProvider('fallback', 'm2'));
    router.setProviderEnabled('primary', false);
    router.setCapabilityRouting({
      assignments: {
        text: {
          provider: 'primary',
          model: 'm1',
          fallback: { provider: 'fallback', model: 'm2' },
        },
      },
    });

    const selected = router.selectForCapability('text', { messages: [{ role: 'user', content: 'Hi' }] });
    expect(selected.provider).toBe('fallback');
  });

  it('resolveModalityProvider returns assigned provider', () => {
    const router = new LLMRouter('anthropic');
    const minimax = mockProvider('minimax', 'MiniMax-M3', undefined, { imageGeneration: true }) as MultiModalProviderInterface;
    router.registerProvider('minimax', minimax);
    router.setCapabilityRouting({ assignments: { image_generation: { provider: 'minimax', model: 'image-01' } } });

    const resolved = router.resolveModalityProvider('image_generation');
    expect(resolved?.provider).toBe(minimax);
    expect(resolved?.model).toBe('image-01');
  });
});

describe('LLMRouter provider management', () => {
  it('getSettings and getEnhancedSettings expose provider info', () => {
    const router = new LLMRouter('openai');
    router.registerProvider('openai', mockProvider('openai', 'gpt-4o'));
    const settings = router.getSettings();
    expect(settings.defaultProvider).toBe('openai');
    expect(settings.providers.openai.configured).toBe(true);

    const enhanced = router.getEnhancedSettings();
    expect(enhanced.providers.openai.displayName).toBe('OpenAI');
    expect(enhanced.providers.openai.enabled).toBe(true);
    expect(enhanced.providers.anthropic.configured).toBe(false);
  });

  it('setDefaultProvider updates default and tiers', () => {
    const router = new LLMRouter('openai');
    router.registerProvider('openai', mockProvider('openai', 'gpt-4o'));
    router.registerProvider('anthropic', mockProvider('anthropic', 'claude-sonnet-4-20250514'));
    router.setDefaultProvider('anthropic');
    expect(router.getDefaultProvider()).toBe('anthropic');
  });

  it('throws when setting default to unknown provider', () => {
    const router = new LLMRouter('openai');
    expect(() => router.setDefaultProvider('missing')).toThrow('unknown provider');
  });

  it('setProviderModel switches active model', () => {
    const router = new LLMRouter('anthropic');
    const provider = mockProvider('anthropic', 'claude-sonnet-4-20250514');
    router.registerProvider('anthropic', provider);
    router.setProviderModel('anthropic', 'claude-opus-4-20250514');
    expect(router.getActiveModelName('anthropic')).toBe('claude-opus-4-20250514');
    expect(provider.configure).toHaveBeenCalled();
  });

  it('setProviderEnabled disables provider and switches default', () => {
    const router = new LLMRouter('openai');
    router.registerProvider('openai', mockProvider('openai', 'gpt-4o'));
    router.registerProvider('anthropic', mockProvider('anthropic', 'claude-sonnet-4-20250514'));
    router.setProviderEnabled('openai', false);
    expect(router.isProviderEnabled('openai')).toBe(false);
    expect(router.getDefaultProvider()).toBe('anthropic');
  });

  it('unregisterProvider cleans up and reassigns default', () => {
    const router = new LLMRouter('openai');
    router.registerProvider('openai', mockProvider('openai', 'gpt-4o'));
    router.registerProvider('anthropic', mockProvider('anthropic', 'claude-sonnet-4-20250514'));
    router.unregisterProvider('openai');
    expect(router.listProviders()).not.toContain('openai');
    expect(router.getDefaultProvider()).toBe('anthropic');
  });

  it('addCustomModel and removeCustomModel update catalog', () => {
    const router = new LLMRouter('openai');
    router.registerProvider('openai', mockProvider('openai', 'gpt-4o'));
    router.addCustomModel('openai', {
      id: 'custom-model',
      name: 'Custom',
      provider: 'openai',
      contextWindow: 32000,
      maxOutputTokens: 4096,
      cost: { input: 1, output: 2 },
    });
    expect(router.getModelCatalog().some(m => m.id === 'custom-model')).toBe(true);
    router.removeCustomModel('openai', 'custom-model');
    expect(router.getModelCatalog().some(m => m.id === 'custom-model')).toBe(false);
  });

  it('updateProviderModelConfig overrides context window', () => {
    const router = new LLMRouter('anthropic');
    router.registerProvider('anthropic', mockProvider('anthropic', 'claude-sonnet-4-20250514'));
    router.updateProviderModelConfig('anthropic', { contextWindow: 200000, maxOutputTokens: 8192 });
    expect(router.getModelContextWindow('anthropic')).toBe(200000);
    expect(router.getModelMaxOutput('anthropic')).toBe(8192);
  });

  it('registerProviderFromConfig registers anthropic provider', () => {
    const router = new LLMRouter('anthropic');
    router.registerProviderFromConfig('anthropic', {
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      apiKey: 'test-key',
    });
    expect(router.listProviders()).toContain('anthropic');
    expect(router.getProvider('anthropic')).toBeDefined();
  });

  it('modelSupportsVision and isCompactionSupported', () => {
    const router = new LLMRouter('anthropic');
    router.registerProvider('anthropic', mockProvider('anthropic', 'claude-sonnet-4-20250514'));
    expect(router.modelSupportsVision('anthropic')).toBe(true);
    expect(router.isCompactionSupported('anthropic')).toBe(true);
    router.setProviderModel('anthropic', 'claude-3-5-haiku-20241022');
    expect(router.isCompactionSupported('anthropic')).toBe(false);
  });

  it('getModelCost returns catalog pricing', () => {
    const router = new LLMRouter('anthropic');
    router.registerProvider('anthropic', mockProvider('anthropic', 'claude-sonnet-4-20250514'));
    const cost = router.getModelCost('anthropic');
    expect(cost?.input).toBeGreaterThan(0);
  });
});

describe('LLMRouter.chatDirect', () => {
  it('calls a single provider without fallback', async () => {
    const router = new LLMRouter('openai');
    const openai = mockProvider('openai', 'gpt-4o');
    (openai as any).baseUrl = 'https://api.openai.com';
    router.registerProvider('openai', openai);
    const response = await router.chatDirect({ messages: [{ role: 'user', content: 'ping' }] }, 'openai');
    expect(response.content).toBe('from openai');
    expect(response._providerBaseUrl).toBe('https://api.openai.com');
  });

  it('throws for disabled provider', async () => {
    const router = new LLMRouter('openai');
    router.registerProvider('openai', mockProvider('openai', 'gpt-4o'));
    router.setProviderEnabled('openai', false);
    await expect(router.chatDirect({ messages: [{ role: 'user', content: 'ping' }] }, 'openai'))
      .rejects.toThrow('disabled');
  });
});

describe('LLMRouter.chatStream', () => {
  it('streams via provider.chatStream when available', async () => {
    const router = new LLMRouter('openai');
    const events: string[] = [];
    const openai = mockProvider('openai', 'gpt-4o');
    openai.chatStream = vi.fn(async (_req, onEvent) => {
      onEvent({ type: 'text_delta', text: 'hello' });
      onEvent({ type: 'message_end', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'end_turn' });
      return successResponse('hello');
    });
    router.registerProvider('openai', openai);
    const response = await router.chatStream(
      { messages: [{ role: 'user', content: 'Hi' }] },
      (e) => { if (e.type === 'text_delta') events.push(e.text); },
      'openai',
    );
    expect(response.content).toBe('hello');
    expect(events).toEqual(['hello']);
  });

  it('falls back to chat when chatStream is unavailable', async () => {
    const router = new LLMRouter('openai');
    const events: string[] = [];
    router.registerProvider('openai', mockProvider('openai', 'gpt-4o'));
    const response = await router.chatStream(
      { messages: [{ role: 'user', content: 'Hi' }] },
      (e) => { if (e.type === 'text_delta') events.push(e.text); },
      'openai',
    );
    expect(response.content).toBe('from openai');
    expect(events).toEqual(['from openai']);
  });
});

describe('LLMRouter alternate model fallback', () => {
  it('tries alternate model on same provider after primary is degraded', async () => {
    const router = new LLMRouter('openai');
    let callCount = 0;
    const openai = mockProvider('openai', 'gpt-4o', async () => {
      callCount++;
      if (callCount <= 2) throw new Error('OpenAI API error 429: rate limit');
      return successResponse('alt model ok');
    });
    router.registerProvider('openai', openai);
    router.addCustomModel('openai', {
      id: 'gpt-4o-mini',
      name: 'Mini',
      provider: 'openai',
      contextWindow: 128000,
      maxOutputTokens: 4096,
      cost: { input: 0.1, output: 0.2 },
    });
    router.setAutoFallback(true);

    await expect(router.chat({ messages: [{ role: 'user', content: 'Hi' }] })).rejects.toThrow('429');

    const response = await router.chat({ messages: [{ role: 'user', content: 'Hi' }] });
    expect(response.content).toBe('alt model ok');
    expect(callCount).toBeGreaterThan(2);
  });
});

describe('LLMRouter logging', () => {
  it('invokes log callback after successful chat', async () => {
    const router = new LLMRouter('openai');
    router.registerProvider('openai', mockProvider('openai', 'gpt-4o'));
    const logCb = vi.fn();
    router.setLogCallback(logCb);
    await router.chat({ messages: [{ role: 'user', content: 'Hi' }] });
    expect(logCb).toHaveBeenCalledOnce();
    expect(logCb.mock.calls[0][0].provider).toBe('openai');
  });
});

describe('LLMRouter auto-select', () => {
  it('selects provider by complexity tier', async () => {
    const router = new LLMRouter('deepseek');
    const deepseek = mockProvider('deepseek', 'deepseek-v4-flash');
    const anthropic = mockProvider('anthropic', 'claude-sonnet-4-20250514');
    router.registerProvider('deepseek', deepseek);
    router.registerProvider('anthropic', anthropic);
    router.enableAutoSelect([
      { name: 'anthropic', complexity: ['complex'] },
      { name: 'deepseek', complexity: ['simple', 'moderate'] },
    ]);

    const complexReq = {
      messages: Array.from({ length: 20 }, () => ({ role: 'user' as const, content: 'x'.repeat(200) })),
    };
    await router.chat(complexReq);
    expect(anthropic.chat).toHaveBeenCalled();
    expect(deepseek.chat).not.toHaveBeenCalled();
  });

  it('falls through when explicit provider is disabled', async () => {
    const router = new LLMRouter('openai');
    const openai = mockProvider('openai', 'gpt-4o');
    const anthropic = mockProvider('anthropic', 'claude-sonnet-4-20250514');
    router.registerProvider('openai', openai);
    router.registerProvider('anthropic', anthropic);
    router.setProviderEnabled('openai', false);
    router.setFallbackOrder(['openai', 'anthropic']);

    await router.chat({ messages: [{ role: 'user', content: 'Hi' }] }, 'openai');
    expect(anthropic.chat).toHaveBeenCalled();
    expect(openai.chat).not.toHaveBeenCalled();
  });
});

describe('LLMRouter registerProviderFromConfig variants', () => {
  it('registers google and ollama providers', () => {
    const router = new LLMRouter('google');
    router.registerProviderFromConfig('google', {
      provider: 'google',
      model: 'gemini-2.0-flash',
      apiKey: 'g-key',
    });
    router.registerProviderFromConfig('ollama', {
      provider: 'ollama',
      model: 'llama3.1',
      baseUrl: 'http://localhost:11434',
    });
    expect(router.listProviders()).toEqual(expect.arrayContaining(['google', 'ollama']));
  });
});

describe('LLMRouter model metadata', () => {
  it('returns text-only input types for unknown provider', () => {
    const router = new LLMRouter('missing');
    expect(router.getModelInputTypes('missing')).toEqual(['text']);
  });

  it('setRoutingDefaultModel is used by selectForCapability fallback', () => {
    const router = new LLMRouter('anthropic');
    router.registerProvider('anthropic', mockProvider('anthropic', 'claude-sonnet-4-20250514'));
    router.setRoutingDefaultModel({ provider: 'anthropic', model: 'claude-sonnet-4-20250514' });
    const selected = router.selectForCapability('text', { messages: [{ role: 'user', content: 'Hi' }] });
    expect(selected.provider).toBe('anthropic');
    expect(selected.model).toBe('claude-sonnet-4-20250514');
  });

  it('getActiveModelContextWindow and MaxOutput return defaults for missing provider', () => {
    const router = new LLMRouter('missing');
    expect(router.getActiveModelContextWindow()).toBe(64000);
    expect(router.getActiveModelMaxOutput()).toBe(4096);
    expect(router.getActiveModelName()).toBe('');
  });
});

describe('LLMRouter resolveModalityProvider fallbacks', () => {
  it('uses assignment fallback when primary is unavailable', () => {
    const router = new LLMRouter('openai');
    const openai = mockProvider('openai', 'dall-e-3', undefined, { imageGeneration: true }) as MultiModalProviderInterface;
    const minimax = mockProvider('minimax', 'image-01', undefined, { imageGeneration: true }) as MultiModalProviderInterface;
    router.registerProvider('openai', openai);
    router.registerProvider('minimax', minimax);
    router.setProviderEnabled('openai', false);
    router.setCapabilityRouting({
      assignments: {
        image_generation: {
          provider: 'openai',
          model: 'dall-e-3',
          fallback: { provider: 'minimax', model: 'image-01' },
        },
      },
    });

    const resolved = router.resolveModalityProvider('image_generation');
    expect(resolved?.provider).toBe(minimax);
    expect(resolved?.model).toBe('image-01');
  });

  it('falls back to routingDefaultModel when no assignment exists', () => {
    const router = new LLMRouter('minimax');
    const minimax = mockProvider('minimax', 'image-01', undefined, { imageGeneration: true }) as MultiModalProviderInterface;
    router.registerProvider('minimax', minimax);
    router.setRoutingDefaultModel({ provider: 'minimax', model: 'image-01' });

    const resolved = router.resolveModalityProvider('image_generation');
    expect(resolved?.provider).toBe(minimax);
    expect(resolved?.model).toBe('image-01');
  });

  it('returns undefined when no providers are available', () => {
    const router = new LLMRouter('openai');
    router.registerProvider('openai', mockProvider('openai', 'gpt-4o'));
    router.setProviderEnabled('openai', false);
    expect(router.resolveModalityProvider('image_generation')).toBeUndefined();
  });
});

describe('LLMRouter selectForCapability fallthrough', () => {
  it('falls through to selectProvider when assignment and default are unavailable', () => {
    const router = new LLMRouter('anthropic');
    router.registerProvider('anthropic', mockProvider('anthropic', 'claude-sonnet-4-20250514'));
    router.registerProvider('openai', mockProvider('openai', 'gpt-4o'));
    router.setCapabilityRouting({
      assignments: { text: { provider: 'missing', model: 'x' } },
    });
    router.setProviderEnabled('anthropic', false);

    const selected = router.selectForCapability('text', { messages: [{ role: 'user', content: 'Hi' }] });
    expect(selected.provider).toBe('openai');
  });
});

describe('LLMRouter.createDefault extended', () => {
  it('registers deepseek via openai-compatible factory', () => {
    const router = LLMRouter.createDefault({
      deepseek: { provider: 'deepseek' as any, model: 'deepseek-chat', apiKey: 'ds' },
    });
    expect(router.listProviders()).toContain('deepseek');
  });
});

describe('LLMRouter.setProviderModel errors', () => {
  it('throws when provider is not registered', () => {
    const router = new LLMRouter('openai');
    expect(() => router.setProviderModel('missing', 'gpt-4o')).toThrow('Provider not found');
  });
});

describe('LLMRouter settings and metadata', () => {
  it('getSettings includes configured and unconfigured providers', () => {
    const router = new LLMRouter('openai');
    router.registerProvider('openai', mockProvider('openai', 'gpt-4o'));
    const settings = router.getSettings();
    expect(settings.defaultProvider).toBe('openai');
    expect(settings.providers.openai.configured).toBe(true);
    expect(settings.providers.anthropic.configured).toBe(false);
  });

  it('getEnhancedSettings returns enriched provider info', () => {
    const router = new LLMRouter('anthropic');
    router.registerProvider('anthropic', mockProvider('anthropic', 'claude-sonnet-4-20250514'));
    const settings = router.getEnhancedSettings();
    expect(settings.providers.anthropic.configured).toBe(true);
    expect(settings.providers.anthropic.models.length).toBeGreaterThan(0);
    expect(settings.autoFallback).toBeDefined();
  });

  it('updateProviderModelConfig overrides context window and cost', () => {
    const router = new LLMRouter('openai');
    router.registerProvider('openai', mockProvider('openai', 'gpt-4o'));
    router.updateProviderModelConfig('openai', {
      contextWindow: 128000,
      maxOutputTokens: 8192,
      cost: { inputPer1M: 2, outputPer1M: 8 },
    });
    expect(router.getModelContextWindow('openai')).toBe(128000);
    expect(router.getModelMaxOutput('openai')).toBe(8192);
    expect(router.getModelCost('openai')).toEqual({ inputPer1M: 2, outputPer1M: 8 });
  });

  it('isCompactionSupported detects Claude 4 models', () => {
    const router = new LLMRouter('anthropic');
    router.registerProvider('anthropic', mockProvider('anthropic', 'claude-sonnet-4-20250514'));
    router.registerProvider('openai', mockProvider('openai', 'gpt-4o'));
    expect(router.isCompactionSupported('anthropic')).toBe(true);
    expect(router.isCompactionSupported('openai')).toBe(false);
  });

  it('modelSupportsVision uses catalog input types', () => {
    const router = new LLMRouter('openai');
    router.registerProvider('openai', mockProvider('openai', 'gpt-4o'));
    expect(router.modelSupportsVision('openai')).toBe(true);
  });

  it('unregisterProvider removes provider from registry', () => {
    const router = new LLMRouter('openai');
    router.registerProvider('openai', mockProvider('openai', 'gpt-4o'));
    router.unregisterProvider('openai');
    expect(router.listProviders()).not.toContain('openai');
  });

  it('addCustomModel and removeCustomModel manage catalog', () => {
    const router = new LLMRouter('openai');
    router.registerProvider('openai', mockProvider('openai', 'gpt-4o'));
    router.addCustomModel('openai', {
      id: 'custom-model',
      name: 'Custom',
      provider: 'openai',
      contextWindow: 32000,
      maxOutputTokens: 4096,
      cost: { inputPer1M: 1, outputPer1M: 2 },
    });
    expect(router.getModelCatalog().some(m => m.id === 'custom-model')).toBe(true);
    router.removeCustomModel('openai', 'custom-model');
    expect(router.getModelCatalog().some(m => m.id === 'custom-model')).toBe(false);
  });

  it('setProviderEnabled switches default when disabling current default', () => {
    const router = new LLMRouter('openai');
    router.registerProvider('openai', mockProvider('openai', 'gpt-4o'));
    router.registerProvider('anthropic', mockProvider('anthropic', 'claude-sonnet-4-20250514'));
    router.setProviderEnabled('openai', false);
    expect(router.getDefaultProvider()).toBe('anthropic');
  });
});

describe('LLMRouter.chatStream', () => {
  it('streams events and returns final response', async () => {
    const router = new LLMRouter('openai');
    const streamProvider = mockProvider('openai', 'gpt-4o');
    streamProvider.chatStream = vi.fn(async (_req, onEvent) => {
      onEvent({ type: 'content_delta', delta: 'Hello' });
      onEvent({ type: 'message_end', usage: { inputTokens: 5, outputTokens: 2 }, finishReason: 'end_turn' });
      return successResponse('Hello');
    });
    router.registerProvider('openai', streamProvider);

    const events: string[] = [];
    const response = await router.chatStream(
      { messages: [{ role: 'user', content: 'Hi' }] },
      (ev) => events.push(ev.type),
    );

    expect(response.content).toBe('Hello');
    expect(events).toContain('content_delta');
    expect(streamProvider.chatStream).toHaveBeenCalled();
  });

  it('log callback errors do not break chat', async () => {
    const router = new LLMRouter('openai');
    router.registerProvider('openai', mockProvider('openai', 'gpt-4o'));
    router.setLogCallback(() => { throw new Error('log failed'); });
    await expect(router.chat({ messages: [{ role: 'user', content: 'Hi' }] })).resolves.toBeDefined();
  });
});

describe('LLMRouter OAuth integration', () => {
  it('initOAuth creates profile store and oauth manager once', () => {
    const router = new LLMRouter('openai');
    const first = router.initOAuth('/tmp/markus-oauth-test');
    const second = router.initOAuth('/tmp/markus-oauth-test-other');
    expect(first.profileStore).toBe(second.profileStore);
    expect(first.oauthManager).toBe(second.oauthManager);
    expect(router.profileStore).toBe(first.profileStore);
    expect(router.oauthManager).toBe(first.oauthManager);
  });

  it('registerOAuthProvider registers openai-codex backed provider', () => {
    const router = new LLMRouter('openai-codex');
    const { oauthManager } = router.initOAuth('/tmp/markus-oauth-codex');
    vi.spyOn(oauthManager, 'getValidToken').mockResolvedValue('codex-token');

    router.registerOAuthProvider('openai-codex', {
      id: 'codex-profile',
      provider: 'openai-codex',
      authType: 'oauth',
      label: 'Codex OAuth',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      oauth: {
        accessToken: 'token',
        expiresAt: Date.now() + 3600_000,
        accountId: 'acct-1',
      },
    }, { model: 'gpt-5.5' });

    expect(router.listProviders()).toContain('openai-codex');
    expect(router.getProvider('openai-codex')?.model).toBe('gpt-5.5');
  });

  it('registerOAuthProvider throws when OAuth not initialized', () => {
    const router = new LLMRouter('openai');
    expect(() => router.registerOAuthProvider('openai-codex', {
      id: 'p1',
      provider: 'openai-codex',
      authType: 'oauth',
      label: 'x',
      createdAt: 0,
      updatedAt: 0,
      oauth: { accessToken: 't', expiresAt: Date.now() + 1000 },
    })).toThrow('OAuth not initialized');
  });
});

describe('LLMRouter session model override', () => {
  it('setSessionModel and getSessionModel store/retrieve override', () => {
    const router = new LLMRouter('anthropic');
    router.setSessionModel('sess-1', { provider: 'anthropic', model: 'claude-sonnet-4-20250514' });
    const result = router.getSessionModel('sess-1');
    expect(result).toBeDefined();
    expect(result!.provider).toBe('anthropic');
    expect(result!.model).toBe('claude-sonnet-4-20250514');
    expect(result!.setAt).toBeDefined();
  });

  it('getSessionModel returns undefined for unknown session', () => {
    const router = new LLMRouter('anthropic');
    expect(router.getSessionModel('nonexistent')).toBeUndefined();
  });

  it('clearSessionModel removes only the specified override', () => {
    const router = new LLMRouter('anthropic');
    router.setSessionModel('sess-1', { provider: 'anthropic', model: 'claude-sonnet-4' });
    router.setSessionModel('sess-2', { provider: 'openai', model: 'gpt-4' });
    router.clearSessionModel('sess-1');
    expect(router.getSessionModel('sess-1')).toBeUndefined();
    expect(router.getSessionModel('sess-2')).toBeDefined();
  });

  it('clearAllSessionModels removes all overrides', () => {
    const router = new LLMRouter('anthropic');
    router.setSessionModel('sess-1', { provider: 'anthropic' });
    router.setSessionModel('sess-2', { provider: 'openai' });
    router.clearAllSessionModels();
    expect(router.getSessionModel('sess-1')).toBeUndefined();
    expect(router.getSessionModel('sess-2')).toBeUndefined();
  });

  it('setAt is set to a valid ISO timestamp', () => {
    const router = new LLMRouter('anthropic');
    router.setSessionModel('sess-1', { provider: 'anthropic', model: 'claude-sonnet-4' });
    const result = router.getSessionModel('sess-1')!;
    expect(result.setAt).toBeDefined();
    // Should not throw - valid ISO string
    expect(() => new Date(result.setAt!).toISOString()).not.toThrow();
  });

  it('duplicate overwrite updates provider, model, and setAt', () => {
    const router = new LLMRouter('anthropic');
    router.setSessionModel('sess-1', { provider: 'anthropic', model: 'claude-sonnet-4' });
    const first = router.getSessionModel('sess-1')!;
    const firstSetAt = first.setAt!;

    // Small delay so second setAt is strictly later
    const later = new Date(Date.now() + 100);
    vi.useFakeTimers();
    vi.setSystemTime(later);
    router.setSessionModel('sess-1', { provider: 'openai', model: 'gpt-4o' });
    vi.useRealTimers();

    const second = router.getSessionModel('sess-1')!;
    expect(second.provider).toBe('openai');
    expect(second.model).toBe('gpt-4o');
    expect(new Date(second.setAt!).getTime()).toBeGreaterThan(new Date(firstSetAt).getTime());
  });

  it('stores session model for unregistered provider (validation deferred to routing)', () => {
    const router = new LLMRouter('anthropic');
    // Provider 'nonexistent' is not registered — setSessionModel still stores it
    router.setSessionModel('sess-1', { provider: 'nonexistent', model: 'v1' });
    const stored = router.getSessionModel('sess-1');
    expect(stored).toBeDefined();
    expect(stored!.provider).toBe('nonexistent');
    expect(stored!.model).toBe('v1');
    // selectForCapability should skip it because isAvailable returns false
    const result = router.selectForCapability('text', { messages: [] }, 'sess-1');
    // Should fall through to default routing since 'nonexistent' isn't registered
    expect(result.provider).toBe('anthropic');
  });

  it('selectForCapability returns session override when sessionId is provided', () => {
    const router = new LLMRouter('anthropic');
    router.registerProvider('anthropic', mockProvider('anthropic', 'claude-sonnet-4-20250514'));
    router.setSessionModel('sess-1', { provider: 'anthropic', model: 'claude-sonnet-4' });

    // Without sessionId — falls through to default routing
    const withoutSession = router.selectForCapability('text', { messages: [] });
    expect(withoutSession.provider).toBe('anthropic');

    // With sessionId — returns session override
    const withSession = router.selectForCapability('text', { messages: [] }, 'sess-1');
    expect(withSession.provider).toBe('anthropic');
    expect(withSession.model).toBe('claude-sonnet-4');
  });

  it('selectForCapability ignores session override when provider is disabled', () => {
    const router = new LLMRouter('anthropic');
    router.registerProvider('anthropic', mockProvider('anthropic', 'claude-sonnet-4-20250514'));
    router.registerProvider('openai', mockProvider('openai', 'gpt-4o'));
    router.setSessionModel('sess-1', { provider: 'openai', model: 'gpt-4o' });
    router.setProviderEnabled('openai', false);

    // Session override points to disabled provider → selectForCapability skips it
    const result = router.selectForCapability('text', { messages: [] }, 'sess-1');
    // Falls through to default
    expect(result.provider).toBe('anthropic');
  });
});
