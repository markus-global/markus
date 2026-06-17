import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FireworksProvider } from '../src/llm/fireworks.js';

describe('FireworksProvider', () => {
  let provider: FireworksProvider;

  beforeEach(() => {
    provider = new FireworksProvider({
      provider: 'fireworks_ai' as any,
      model: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
      apiKey: 'fw-key',
      baseUrl: 'https://api.fireworks.ai/inference/v1',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('constructs with correct defaults', () => {
    expect(provider.name).toBe('fireworks_ai');
    expect(provider.model).toContain('llama');
  });

  it('parses standard OpenAI data array response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: [{ url: 'https://cdn.example/img.png', b64_json: 'abc123' }],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const results = await provider.generateImage('a sunset');
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://cdn.example/img.png');
    expect(results[0].base64).toBe('abc123');
  });

  it('parses Fireworks base64 array response format', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        base64: ['data:image/png;base64,iVBORw0KGgo='],
        finishReason: 'SUCCESS',
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const results = await provider.generateImage('a mountain', { size: '512x768', seed: 42 });
    expect(results).toHaveLength(1);
    expect(results[0].base64).toBe('iVBORw0KGgo=');

    const body = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.width).toBe(512);
    expect(body.height).toBe(768);
    expect(body.seed).toBe(42);
  });

  it('throws on API error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('internal error'),
    }));

    await expect(provider.generateImage('test')).rejects.toThrow('Fireworks image generation API error 500');
  });

  it('returns empty array when response has no images', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ finishReason: 'SUCCESS' }),
    }));

    const results = await provider.generateImage('nothing');
    expect(results).toEqual([]);
  });
});
