/**
 * OpenRouter-only credential helpers (client-side).
 * Hub connect HTTP is covered in Hub integration tests.
 */
import { describe, it, expect } from 'vitest';
import {
  isLegacyMarkusProxyBaseUrl,
  markusCatalogUrlFromHub,
  applyHubRecommendedRouting,
} from '../src/llm/hub-recommended-routing.js';
import { resolveMarkusRoute } from '../src/llm/markus-provider.js';

/** Persist Markus Provider config with OpenRouter fields only. */
function persistOpenRouterOnly(
  existing: Record<string, string | undefined>,
  patch: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const merged = { ...existing, ...patch };
  const next: Record<string, string | undefined> = {};
  if (merged.apiKey) next.apiKey = merged.apiKey;
  if (merged.baseUrl && !isLegacyMarkusProxyBaseUrl(merged.baseUrl)) next.baseUrl = merged.baseUrl;
  else next.baseUrl = 'https://openrouter.ai/api/v1';
  if (merged.modelsUrl) next.modelsUrl = merged.modelsUrl;
  if (merged.model) next.model = merged.model;
  return next;
}

describe('OpenRouter-only credential persist', () => {
  it('detects legacy proxy base and builds Hub catalog URL', () => {
    expect(isLegacyMarkusProxyBaseUrl('http://localhost:8787')).toBe(true);
    expect(isLegacyMarkusProxyBaseUrl('https://openrouter.ai/api/v1')).toBe(false);
    expect(markusCatalogUrlFromHub('https://hub.example')).toBe(
      'https://hub.example/api/models/live/markus',
    );
  });

  it('strips legacy proxy fields when OR credentials are saved', () => {
    const saved = persistOpenRouterOnly(
      {
        apiKey: 'sk-or-old',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelsUrl: 'https://hub.example/api/models/live/markus',
        subscriptionKey: 'markus_keep_me',
        proxyUrl: 'http://localhost:8787',
      },
      {
        apiKey: 'sk-or-rotated',
        baseUrl: 'https://openrouter.ai/api/v1',
      },
    );
    expect(saved.apiKey).toBe('sk-or-rotated');
    expect(saved.subscriptionKey).toBeUndefined();
    expect(saved.proxyUrl).toBeUndefined();
    expect(saved.modelsUrl).toContain('/api/models/live/markus');
  });

  it('rewrites legacy proxy baseUrl to OpenRouter', () => {
    const saved = persistOpenRouterOnly(
      {
        apiKey: 'sk-or-v1',
        baseUrl: 'http://localhost:8787',
        subscriptionKey: 'markus_sub',
        proxyUrl: 'http://localhost:8787',
      },
      { apiKey: 'sk-or-v2' },
    );
    expect(saved.apiKey).toBe('sk-or-v2');
    expect(saved.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(saved.subscriptionKey).toBeUndefined();
    expect(saved.proxyUrl).toBeUndefined();
  });
});

describe('route resolution — always OpenRouter', () => {
  it('resolves any catalog id to openrouter', () => {
    const catalog = [
      { id: 'deepseek/deepseek-v4-flash', route: 'openrouter' as const },
      { id: 'openai/gpt-4o', route: 'openrouter' as const },
    ];
    expect(resolveMarkusRoute('deepseek/deepseek-v4-flash', catalog)).toBe('openrouter');
    expect(resolveMarkusRoute('openai/gpt-4o', catalog)).toBe('openrouter');
  });

  it('Hub text restore uses OR slug on OpenRouter path', () => {
    const result = applyHubRecommendedRouting(
      { defaultProvider: 'anthropic', capabilityRouting: { assignments: {} } },
      {
        text: 'deepseek/deepseek-v4-flash',
        image_recognition: null,
        image_generation: 'openai/gpt-image-1',
        audio_tts: null,
        audio_stt: null,
        video_generation: null,
      },
      { greenfield: true, force: false },
    );
    expect(result.routingDefaultModel).toEqual({
      provider: 'markus',
      model: 'deepseek/deepseek-v4-flash',
    });
    expect(resolveMarkusRoute(result.routingDefaultModel!.model)).toBe('openrouter');
  });
});
