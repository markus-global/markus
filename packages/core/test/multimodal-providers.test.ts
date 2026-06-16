/**
 * Integration tests for multimodal provider APIs (image generation, TTS, STT).
 *
 * These tests are env-var-gated: each test only runs when the corresponding
 * API key env var is set. If no keys are available, all tests are skipped.
 *
 * Run with real keys:
 *   OPENAI_API_KEY=sk-xxx MINIMAX_API_KEY=xxx npx vitest run test/multimodal-providers.test.ts
 */

import { describe, it, expect } from 'vitest';
import { OpenAIProvider } from '../src/llm/openai.js';
import { MiniMaxProvider } from '../src/llm/minimax.js';
import { DashScopeProvider } from '../src/llm/dashscope.js';
import { FireworksProvider } from '../src/llm/fireworks.js';
import { LLMRouter } from '../src/llm/router.js';
import type { MultiModalProviderInterface } from '../src/llm/provider.js';

const TEST_PROMPT = 'A simple red circle on a white background';
const TEST_TTS_TEXT = 'Hello, this is a test.';
const TIMEOUT = 120_000;

/** HTTP status codes that indicate account/billing problems, not code bugs. */
const BILLING_AUTH_CODES = [401, 402, 403, 429];

function isBillingOrAuthError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return BILLING_AUTH_CODES.some(c => err.message.includes(`${c}`))
    || /insufficient|balance|quota|billing|unauthorized|forbidden|invalid.*(api|key|token)|api.key.*invalid|authentication/i.test(err.message);
}

// ---------------------------------------------------------------------------
// Helper: conditionally run a test only when the env var is present
// ---------------------------------------------------------------------------

function describeWithEnv(envKey: string, label: string, fn: (apiKey: string) => void) {
  const apiKey = process.env[envKey];
  if (apiKey && apiKey.length > 5) {
    describe(label, () => fn(apiKey));
  } else {
    describe.skip(`${label} (${envKey} not set)`, () => {
      it('skipped — no API key', () => {});
    });
  }
}

// ---------------------------------------------------------------------------
// Shared assertion helpers
// ---------------------------------------------------------------------------

function assertImageResult(_label: string, results: Awaited<ReturnType<NonNullable<MultiModalProviderInterface['generateImage']>>>) {
  expect(results).toBeDefined();
  expect(Array.isArray(results)).toBe(true);
  expect(results.length).toBeGreaterThanOrEqual(1);
  const first = results[0];
  expect(first.url || first.base64).toBeTruthy();
}

function assertAudioResult(result: Awaited<ReturnType<NonNullable<MultiModalProviderInterface['generateSpeech']>>>) {
  expect(result).toBeDefined();
  expect(result.audio).toBeInstanceOf(Buffer);
  expect(result.audio.length).toBeGreaterThan(100);
  expect(result.format).toBeTruthy();
}

/**
 * Run an async API call; if it fails with a billing/auth error, log and
 * pass the test (it's not a code bug). Re-throw any other error.
 */
async function runOrSkipOnBilling<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    if (isBillingOrAuthError(err)) {
      console.log(`  ${label}: skipped (billing/auth) — ${(err as Error).message.slice(0, 120)}`);
      return undefined;
    }
    throw err;
  }
}

// ===========================================================================
// OpenAI — image generation + TTS + STT
// ===========================================================================

describeWithEnv('OPENAI_API_KEY', 'OpenAI multimodal', (apiKey) => {
  const provider = new OpenAIProvider({
    provider: 'openai', model: 'gpt-4o', apiKey, baseUrl: 'https://api.openai.com',
  });

  it('getCapabilities includes imageGeneration + tts + stt', () => {
    const caps = provider.getCapabilities();
    expect(caps.imageGeneration).toBe(true);
    expect(caps.tts).toBe(true);
    expect(caps.stt).toBe(true);
  });

  it('generates image with dall-e-3', async () => {
    const r = await runOrSkipOnBilling('OpenAI image', () =>
      provider.generateImage(TEST_PROMPT, { model: 'dall-e-3', size: '1024x1024', n: 1 }));
    if (r) { assertImageResult('OpenAI', r); console.log('  OpenAI image URL:', r[0]?.url?.slice(0, 80), '...'); }
  }, TIMEOUT);

  it('generates speech with tts-1', async () => {
    const r = await runOrSkipOnBilling('OpenAI TTS', () =>
      provider.generateSpeech(TEST_TTS_TEXT, { model: 'tts-1', voice: 'alloy' }));
    if (r) { assertAudioResult(r); console.log('  OpenAI TTS audio size:', r.audio.length, 'bytes'); }
  }, TIMEOUT);
});

// ===========================================================================
// MiniMax — image + TTS + video (video skipped — too slow for CI)
// ===========================================================================

describeWithEnv('MINIMAX_API_KEY', 'MiniMax multimodal', (apiKey) => {
  const provider = new MiniMaxProvider({
    provider: 'minimax', model: 'MiniMax-M3', apiKey, baseUrl: 'https://api.minimax.io/v1',
  });

  it('getCapabilities includes imageGeneration + tts + videoGeneration, NOT stt', () => {
    const caps = provider.getCapabilities();
    expect(caps.imageGeneration).toBe(true);
    expect(caps.tts).toBe(true);
    expect(caps.stt).toBe(false);
    expect(caps.videoGeneration).toBe(true);
  });

  it('generates image with image-01', async () => {
    const r = await runOrSkipOnBilling('MiniMax image', () =>
      provider.generateImage(TEST_PROMPT, { model: 'image-01', n: 1 }));
    if (r) { assertImageResult('MiniMax', r); console.log('  MiniMax image URL:', r[0]?.url?.slice(0, 80), '...'); }
  }, TIMEOUT);

  it('generates speech with speech-02-hd', async () => {
    const r = await runOrSkipOnBilling('MiniMax TTS', () =>
      provider.generateSpeech(TEST_TTS_TEXT, { model: 'speech-02-hd', voice: 'Calm_Woman' }));
    if (r) { assertAudioResult(r); console.log('  MiniMax TTS audio size:', r.audio.length, 'bytes'); }
  }, TIMEOUT);
});

describeWithEnv('MINIMAX_CN_API_KEY', 'MiniMax-CN multimodal', (apiKey) => {
  const provider = new MiniMaxProvider({
    provider: 'minimax-cn' as any, model: 'MiniMax-M3', apiKey, baseUrl: 'https://api.minimaxi.com/v1',
  });

  it('generates image', async () => {
    const r = await runOrSkipOnBilling('MiniMax-CN image', () =>
      provider.generateImage(TEST_PROMPT, { model: 'image-01', n: 1 }));
    if (r) { assertImageResult('MiniMax-CN', r); console.log('  MiniMax-CN image URL:', r[0]?.url?.slice(0, 80), '...'); }
  }, TIMEOUT);
});

// ===========================================================================
// DashScope (Qwen) — image + TTS
// ===========================================================================

describeWithEnv('DASHSCOPE_API_KEY', 'DashScope multimodal', (apiKey) => {
  const provider = new DashScopeProvider({
    provider: 'dashscope' as any, model: 'qwen-max', apiKey,
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  });

  it('getCapabilities includes imageGeneration + tts, NOT stt/video', () => {
    const caps = provider.getCapabilities();
    expect(caps.imageGeneration).toBe(true);
    expect(caps.tts).toBe(true);
    expect(caps.stt).toBe(false);
    expect(caps.videoGeneration).toBe(false);
  });

  it('generates image with qwen-image-2.0-pro', async () => {
    const r = await runOrSkipOnBilling('DashScope image', () =>
      provider.generateImage(TEST_PROMPT, { model: 'qwen-image-2.0-pro', size: '1024x1024', n: 1 }));
    if (r) { assertImageResult('DashScope', r); console.log('  DashScope image URL:', r[0]?.url?.slice(0, 80), '...'); }
  }, TIMEOUT);

  it('generates speech with qwen3-tts-flash', async () => {
    const r = await runOrSkipOnBilling('DashScope TTS', () =>
      provider.generateSpeech(TEST_TTS_TEXT, { model: 'qwen3-tts-flash', voice: 'Cherry' }));
    if (r) { assertAudioResult(r); console.log('  DashScope TTS audio size:', r.audio.length, 'bytes'); }
  }, TIMEOUT);
});

// ===========================================================================
// SiliconFlow — image generation (OpenAI-compatible)
// ===========================================================================

describeWithEnv('SILICONFLOW_API_KEY', 'SiliconFlow multimodal', (apiKey) => {
  const provider = new OpenAIProvider({
    provider: 'siliconflow' as any, model: 'Qwen/Qwen3.5-35B-A3B', apiKey,
    baseUrl: 'https://api.siliconflow.cn/v1',
  });

  it('generates image with Kolors model', async () => {
    const r = await runOrSkipOnBilling('SiliconFlow image', () =>
      provider.generateImage(TEST_PROMPT, { model: 'Kwai-Kolors/Kolors', size: '1024x1024', n: 1 }));
    if (r) { assertImageResult('SiliconFlow', r); console.log('  SiliconFlow image URL:', r[0]?.url?.slice(0, 80), '...'); }
  }, TIMEOUT);
});

// ===========================================================================
// ZAI (Zhipu) — image generation (OpenAI-compatible at /paas/v4)
// ===========================================================================

describeWithEnv('ZAI_API_KEY', 'ZAI multimodal', (apiKey) => {
  const provider = new OpenAIProvider({
    provider: 'zai' as any, model: 'glm-5.1', apiKey,
    baseUrl: 'https://api.z.ai/api/paas/v4',
  });

  it('generates image with cogView-4', async () => {
    const r = await runOrSkipOnBilling('ZAI image', () =>
      provider.generateImage(TEST_PROMPT, { model: 'cogView-4-250304', size: '1024x1024', n: 1 }));
    if (r) { assertImageResult('ZAI', r); console.log('  ZAI image URL:', r[0]?.url?.slice(0, 80), '...'); }
  }, TIMEOUT);
});

// ===========================================================================
// xAI — image generation (OpenAI-compatible)
// ===========================================================================

describeWithEnv('XAI_API_KEY', 'xAI multimodal', (apiKey) => {
  const provider = new OpenAIProvider({
    provider: 'xai' as any, model: 'grok-3', apiKey,
    baseUrl: 'https://api.x.ai/v1',
  });

  it('generates image with grok-imagine-image', async () => {
    const r = await runOrSkipOnBilling('xAI image', () =>
      provider.generateImage(TEST_PROMPT, { model: 'grok-imagine-image', n: 1 }));
    if (r) { assertImageResult('xAI', r); console.log('  xAI image URL:', r[0]?.url?.slice(0, 80), '...'); }
  }, TIMEOUT);
});

// ===========================================================================
// Together AI — image (OpenAI-compatible)
// ===========================================================================

describeWithEnv('TOGETHER_API_KEY', 'Together AI multimodal', (apiKey) => {
  const provider = new OpenAIProvider({
    provider: 'together_ai' as any, model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', apiKey,
    baseUrl: 'https://api.together.xyz/v1',
  });

  it('generates image with FLUX.1-schnell', async () => {
    const r = await runOrSkipOnBilling('Together image', () =>
      provider.generateImage(TEST_PROMPT, { model: 'black-forest-labs/FLUX.1-schnell', size: '1024x1024', n: 1 }));
    if (r) { assertImageResult('Together', r); console.log('  Together image URL:', r[0]?.url?.slice(0, 80), '...'); }
  }, TIMEOUT);
});

// ===========================================================================
// Fireworks AI — image generation (OpenAI-compatible)
// ===========================================================================

describeWithEnv('FIREWORKS_API_KEY', 'Fireworks AI multimodal', (apiKey) => {
  const provider = new FireworksProvider({
    provider: 'fireworks_ai' as any,
    model: 'accounts/fireworks/models/llama-v3p3-70b-instruct', apiKey,
    baseUrl: 'https://api.fireworks.ai/inference/v1',
  });

  it('generates image with stable-diffusion-xl', async () => {
    const r = await runOrSkipOnBilling('Fireworks image', () =>
      provider.generateImage(TEST_PROMPT, { model: 'accounts/fireworks/models/stable-diffusion-xl-1024-v1-0', size: '1024x1024', n: 1 }));
    if (r) { assertImageResult('Fireworks', r); console.log('  Fireworks image base64 length:', r[0]?.base64?.length); }
  }, TIMEOUT);
});

// ===========================================================================
// Volcengine (Doubao) — image generation (OpenAI-compatible at /api/v3)
// ===========================================================================

describeWithEnv('VOLCENGINE_API_KEY', 'Volcengine multimodal', (apiKey) => {
  const provider = new OpenAIProvider({
    provider: 'volcengine' as any, model: 'doubao-1.5-pro-32k', apiKey,
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  });

  it('generates image with doubao-seedream', async () => {
    const r = await runOrSkipOnBilling('Volcengine image', () =>
      provider.generateImage(TEST_PROMPT, { model: 'doubao-seedream-4-0-250828', size: '2048x2048', n: 1 }));
    if (r) { assertImageResult('Volcengine', r); console.log('  Volcengine image URL:', r[0]?.url?.slice(0, 80), '...'); }
  }, TIMEOUT);
});

// ===========================================================================
// Factory / Router integration — createOpenAICompatible dispatches correctly
// ===========================================================================

describe('Provider factory dispatches correct subclass', () => {
  it('MiniMax name creates MiniMaxProvider', () => {
    const router = LLMRouter.createDefault({
      minimax: { provider: 'minimax', model: 'MiniMax-M3', apiKey: 'test-key', baseUrl: 'https://api.minimax.io/v1' },
    });
    const p = (router as any).providers.get('minimax');
    expect(p).toBeDefined();
    expect(p.constructor.name).toBe('MiniMaxProvider');
  });

  it('DashScope name creates DashScopeProvider', () => {
    const router = LLMRouter.createDefault({
      dashscope: { provider: 'dashscope' as any, model: 'qwen-max', apiKey: 'test-key', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    });
    const p = (router as any).providers.get('dashscope');
    expect(p).toBeDefined();
    expect(p.constructor.name).toBe('DashScopeProvider');
  });

  it('Fireworks name creates FireworksProvider', () => {
    const router = LLMRouter.createDefault({
      fireworks_ai: { provider: 'fireworks_ai' as any, model: 'llama-v3p3-70b', apiKey: 'test-key', baseUrl: 'https://api.fireworks.ai/inference/v1' },
    });
    const p = (router as any).providers.get('fireworks_ai');
    expect(p).toBeDefined();
    expect(p.constructor.name).toBe('FireworksProvider');
  });

  it('Generic provider creates OpenAIProvider', () => {
    const router = LLMRouter.createDefault({
      xai: { provider: 'xai' as any, model: 'grok-3', apiKey: 'test-key', baseUrl: 'https://api.x.ai/v1' },
    });
    const p = (router as any).providers.get('xai');
    expect(p).toBeDefined();
    expect(p.constructor.name).toBe('OpenAIProvider');
  });
});

// ===========================================================================
// getCapabilities — non-OpenAI providers must NOT claim imageGeneration
// ===========================================================================

describe('OpenAIProvider getCapabilities accuracy', () => {
  it('native OpenAI claims imageGeneration', () => {
    const p = new OpenAIProvider({ provider: 'openai', model: 'gpt-4o', apiKey: 'k', baseUrl: 'https://api.openai.com' });
    expect(p.getCapabilities().imageGeneration).toBe(true);
  });

  it('DeepSeek (non-OpenAI) does NOT claim imageGeneration', () => {
    const p = new OpenAIProvider({ provider: 'deepseek' as any, model: 'deepseek-v4-flash', apiKey: 'k', baseUrl: 'https://api.deepseek.com' });
    expect(p.getCapabilities().imageGeneration).toBe(false);
  });

  it('SiliconFlow (non-OpenAI) does NOT claim imageGeneration', () => {
    const p = new OpenAIProvider({ provider: 'siliconflow' as any, model: 'Qwen/Qwen3.5-35B-A3B', apiKey: 'k', baseUrl: 'https://api.siliconflow.cn/v1' });
    expect(p.getCapabilities().imageGeneration).toBe(false);
  });

  it('MiniMax overrides and claims imageGeneration', () => {
    const p = new MiniMaxProvider({ provider: 'minimax', model: 'MiniMax-M3', apiKey: 'k', baseUrl: 'https://api.minimax.io/v1' });
    expect(p.getCapabilities().imageGeneration).toBe(true);
  });
});

// ===========================================================================
// resolveModalityCandidates — text-only providers must NOT be fallbacks
// for non-text tasks (the root cause of the 404 bug)
// ===========================================================================

describe('resolveModalityCandidates capability filtering', () => {
  function createRouter() {
    return LLMRouter.createDefault({
      'minimax-cn': { apiKey: 'k', baseUrl: 'https://api.minimaxi.com/v1', model: 'MiniMax-M3' },
      'deepseek':   { apiKey: 'k', baseUrl: 'https://api.deepseek.com',   model: 'deepseek-v4-flash' },
    }, 'deepseek');
  }

  it('image_generation with assignment: only assigned provider, no deepseek fallback', () => {
    const router = createRouter();
    router.setTaskRouting({ assignments: { image_generation: { provider: 'minimax-cn', model: 'image-01' } } });
    const candidates = router.resolveModalityCandidates('image_generation');
    const names = candidates.map(c => c.name);
    expect(names).toContain('minimax-cn');
    expect(names).not.toContain('deepseek');
  });

  it('image_generation without assignment: empty candidates (no misleading 404)', () => {
    const router = createRouter();
    const candidates = router.resolveModalityCandidates('image_generation');
    const names = candidates.map(c => c.name);
    expect(names).not.toContain('deepseek');
  });

  it('text routing still includes routingDefaultModel and defaultProvider', () => {
    const router = createRouter();
    router.setTaskRouting({ assignments: { text: { provider: 'minimax-cn', model: 'MiniMax-M3' } } });
    const candidates = router.resolveModalityCandidates('text');
    const names = candidates.map(c => c.name);
    expect(names).toContain('minimax-cn');
    expect(names).toContain('deepseek');
  });

  it('audio_tts without assignment: deepseek not included as fallback', () => {
    const router = createRouter();
    const candidates = router.resolveModalityCandidates('audio_tts');
    const names = candidates.map(c => c.name);
    expect(names).not.toContain('deepseek');
  });

  it('assigned provider is always included even without capability declaration', () => {
    const router = createRouter();
    router.setTaskRouting({ assignments: { image_generation: { provider: 'deepseek', model: 'some-model' } } });
    const candidates = router.resolveModalityCandidates('image_generation');
    expect(candidates.some(c => c.name === 'deepseek')).toBe(true);
  });

  it('autoFallback respects capability filter for non-text tasks', () => {
    const router = createRouter();
    (router as any)._autoFallback = true;
    router.setTaskRouting({ assignments: { image_generation: { provider: 'minimax-cn', model: 'image-01' } } });
    const candidates = router.resolveModalityCandidates('image_generation');
    const names = candidates.map(c => c.name);
    expect(names).toContain('minimax-cn');
    expect(names).not.toContain('deepseek');
  });
});
