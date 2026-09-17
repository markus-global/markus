import { describe, it, expect, vi } from 'vitest';
import {
  buildModelsEndpoint,
  buildModelsAuthHeaders,
  discoverProviderModels,
  isUsableProviderModelId,
  parseModelListPayload,
  normalizeBaseUrl,
} from '../src/llm/model-discovery.js';

describe('normalizeBaseUrl', () => {
  it('trims whitespace and trailing slashes', () => {
    expect(normalizeBaseUrl('  https://api.example.com/v1//  ')).toBe('https://api.example.com/v1');
    expect(normalizeBaseUrl('')).toBe('');
  });
});

describe('buildModelsEndpoint', () => {
  it('appends /v1/models when the base has no version segment', () => {
    expect(buildModelsEndpoint('https://api.example.com')).toBe('https://api.example.com/v1/models');
    expect(buildModelsEndpoint('https://api.openai.com')).toBe('https://api.openai.com/v1/models');
    expect(buildModelsEndpoint('https://api.anthropic.com')).toBe('https://api.anthropic.com/v1/models');
    expect(buildModelsEndpoint('https://api.deepseek.com')).toBe('https://api.deepseek.com/v1/models');
  });

  it('does not double the version segment for versioned bases', () => {
    // The regression this file exists for: `${base}/v1/models` produced
    // `/v1/v1/models` for every one of these documented defaults.
    expect(buildModelsEndpoint('https://api.example.com/v1')).toBe('https://api.example.com/v1/models');
    expect(buildModelsEndpoint('https://api.example.com/v1/')).toBe('https://api.example.com/v1/models');
    expect(buildModelsEndpoint('https://generativelanguage.googleapis.com/v1beta'))
      .toBe('https://generativelanguage.googleapis.com/v1beta/models');
    expect(buildModelsEndpoint('https://api.groq.com/openai/v1')).toBe('https://api.groq.com/openai/v1/models');
    expect(buildModelsEndpoint('https://api.z.ai/api/paas/v4')).toBe('https://api.z.ai/api/paas/v4/models');
    expect(buildModelsEndpoint('https://dashscope.aliyuncs.com/compatible-mode/v1'))
      .toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/models');
    expect(buildModelsEndpoint('https://api.fireworks.ai/inference/v1'))
      .toBe('https://api.fireworks.ai/inference/v1/models');
    expect(buildModelsEndpoint('https://ark.cn-beijing.volces.com/api/v3'))
      .toBe('https://ark.cn-beijing.volces.com/api/v3/models');
  });

  it('treats an existing models URL as final', () => {
    expect(buildModelsEndpoint('https://api.example.com/v1/models')).toBe('https://api.example.com/v1/models');
  });

  it('uses /api/tags for Ollama (it has no /v1/models)', () => {
    expect(buildModelsEndpoint('http://localhost:11434', 'ollama')).toBe('http://localhost:11434/api/tags');
    expect(buildModelsEndpoint('http://localhost:11434/v1', 'ollama')).toBe('http://localhost:11434/api/tags');
  });

  it('throws when no base url is available', () => {
    expect(() => buildModelsEndpoint('')).toThrow();
  });
});

describe('buildModelsAuthHeaders', () => {
  it('uses x-api-key + anthropic-version for Anthropic (never Bearer)', () => {
    expect(buildModelsAuthHeaders('anthropic', 'sk-ant')).toEqual({
      'x-api-key': 'sk-ant',
      'anthropic-version': '2023-06-01',
    });
  });

  it('keeps the Google key out of the URL', () => {
    expect(buildModelsAuthHeaders('google', 'g-key')).toEqual({ 'x-goog-api-key': 'g-key' });
  });

  it('defaults to Bearer for OpenAI-compatible providers', () => {
    expect(buildModelsAuthHeaders('deepseek', 'k')).toEqual({ Authorization: 'Bearer k' });
    expect(buildModelsAuthHeaders('my-custom-gateway', 'k')).toEqual({ Authorization: 'Bearer k' });
  });

  it('sends no auth header when no key is configured (Ollama)', () => {
    expect(buildModelsAuthHeaders('ollama', '')).toEqual({});
    expect(buildModelsAuthHeaders('ollama', undefined)).toEqual({});
  });
});

describe('isUsableProviderModelId', () => {
  it('drops non-conversational utility models', () => {
    // These are the real ids the old `\b`-anchored regex silently let through.
    expect(isUsableProviderModelId('text-embedding-3-small')).toBe(false);
    expect(isUsableProviderModelId('text-moderation-latest')).toBe(false);
    expect(isUsableProviderModelId('bge-reranker-v2-m3')).toBe(false);
    expect(isUsableProviderModelId('')).toBe(false);
  });

  it('keeps chat and multimodal models (image / tts / stt / video)', () => {
    for (const id of ['gpt-4o', 'deepseek-chat', 'qwen-max', 'dall-e-3', 'tts-1-hd', 'whisper-1', 'gpt-image-1']) {
      expect(isUsableProviderModelId(id)).toBe(true);
    }
  });
});

describe('parseModelListPayload', () => {
  it('parses the OpenAI { data: [...] } shape', () => {
    const models = parseModelListPayload({
      object: 'list',
      data: [{ id: 'gpt-4o', object: 'model' }, { id: 'text-embedding-3-small' }],
    });
    expect(models.map(m => m.id)).toEqual(['gpt-4o']);
  });

  it('reads OpenRouter capability + window hints', () => {
    const [m] = parseModelListPayload({
      data: [{
        id: 'anthropic/claude-sonnet-4',
        context_length: 200000,
        architecture: { input_modalities: ['text', 'image'] },
        supported_parameters: ['reasoning', 'tools'],
      }],
    });
    expect(m.id).toBe('anthropic/claude-sonnet-4');
    expect(m.contextWindow).toBe(200000);
    expect(m.vision).toBe(true);
    expect(m.reasoning).toBe(true);
  });

  it('parses the Gemini { models: [...] } shape and strips the models/ prefix', () => {
    const [m] = parseModelListPayload({
      models: [{ name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', inputTokenLimit: 1048576, outputTokenLimit: 65536 }],
    });
    expect(m.id).toBe('gemini-2.5-flash');
    expect(m.name).toBe('Gemini 2.5 Flash');
    expect(m.contextWindow).toBe(1048576);
    expect(m.maxOutputTokens).toBe(65536);
  });

  it('parses the Ollama { models: [{ name }] } shape', () => {
    const models = parseModelListPayload({ models: [{ name: 'qwen3:8b' }, { name: 'llama3.2:latest' }] });
    expect(models.map(m => m.id)).toEqual(['qwen3:8b', 'llama3.2:latest']);
  });

  it('accepts a bare array / string array and de-duplicates', () => {
    expect(parseModelListPayload(['a', 'b', 'a']).map(m => m.id)).toEqual(['a', 'b']);
    expect(parseModelListPayload([{ id: 'x' }]).map(m => m.id)).toEqual(['x']);
  });

  it('returns [] for unusable payloads instead of throwing', () => {
    expect(parseModelListPayload(null)).toEqual([]);
    expect(parseModelListPayload({ error: 'nope' })).toEqual([]);
    expect(parseModelListPayload([{ foo: 1 }])).toEqual([]);
  });
});

describe('discoverProviderModels', () => {
  it('asks the provider for its own list with the right URL and auth header', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ data: [{ id: 'deepseek-chat' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;

    const models = await discoverProviderModels({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'k',
      fetchImpl,
    });

    expect(models.map(m => m.id)).toEqual(['deepseek-chat']);
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toBe('https://api.deepseek.com/v1/models');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer k');
  });

  it('falls back to the documented default base url when none is configured', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;
    await discoverProviderModels({ provider: 'openrouter', apiKey: 'k', fetchImpl });
    const [url] = (fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/models');
  });

  it('throws a descriptive error on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    await expect(discoverProviderModels({
      provider: 'custom',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'k',
      fetchImpl,
    })).rejects.toThrow(/HTTP 404/);
  });
});
