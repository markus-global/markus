/**
 * P1-7 / P1-8 回归：上下文窗口预算的解析口径。
 *
 * - P1-7：catalog 未命中的模型曾被静默赋予 1,000,000 窗口 → 打包预算系统性
 *   高估、小窗模型每轮过度打包直至 provider 400。现在必须 fail-closed 到保守窗口。
 * - P1-8：窗口必须按「本次生效模型」（可被会话覆盖）解析，而非 provider 默认模型。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { LLMRouter, DEFAULT_CONTEXT_WINDOW_FALLBACK } from '../src/llm/router.js';

function registerUnlisted(router: LLMRouter, model = 'private/unknown-model:42') {
  router.registerProviderFromConfig('my-local', {
    provider: 'my-local' as never,
    model,
    baseUrl: 'http://127.0.0.1:9999',
  } as never);
}

afterEach(() => {
  delete process.env['MARKUS_FALLBACK_CONTEXT_WINDOW'];
});

describe('P1-7: catalog-miss fallback is conservative, never 1M', () => {
  it('an unlisted model gets the conservative fallback window, not 1,000,000', () => {
    const router = new LLMRouter('my-local');
    registerUnlisted(router);

    const win = router.getModelContextWindow('my-local');
    expect(win).toBe(DEFAULT_CONTEXT_WINDOW_FALLBACK);
    expect(win).not.toBe(1_000_000);
    expect(win).toBeLessThan(1_000_000);
    // 预算不变量：兜底窗口仍须大于兜底输出上限，避免 message budget 变负。
    expect(win).toBeGreaterThan(router.getModelMaxOutput('my-local'));
  });

  it('the fallback is not hard-coded to 1M: constant itself is conservative', () => {
    expect(DEFAULT_CONTEXT_WINDOW_FALLBACK).toBeLessThanOrEqual(64_000);
  });

  it('honors an explicit MARKUS_FALLBACK_CONTEXT_WINDOW override', () => {
    process.env['MARKUS_FALLBACK_CONTEXT_WINDOW'] = '65536';
    const router = new LLMRouter('my-local');
    registerUnlisted(router);
    expect(router.getModelContextWindow('my-local')).toBe(65_536);
  });
});

describe('P1-8: window resolves for the effective model, not the provider default', () => {
  it('an explicit (smaller) effective model wins over the provider default window', () => {
    const router = new LLMRouter('anthropic');
    router.registerProviderFromConfig('anthropic', {
      provider: 'anthropic' as never,
      model: 'claude-opus-4-6', // builtin window 1,000,000
      apiKey: 'sk-test',
    } as never);

    // Provider default model → its own (large) window.
    expect(router.getModelContextWindow('anthropic')).toBe(1_000_000);
    // Effective model override → the override's (smaller) window.
    const overridden = router.getModelContextWindow('anthropic', 'claude-3-5-haiku-20241022');
    expect(overridden).toBe(200_000);
    expect(overridden).toBeLessThan(router.getModelContextWindow('anthropic'));
  });

  it('max output also follows the effective model', () => {
    const router = new LLMRouter('anthropic');
    router.registerProviderFromConfig('anthropic', {
      provider: 'anthropic' as never,
      model: 'claude-opus-4-6', // maxOutputTokens 128,000
      apiKey: 'sk-test',
    } as never);
    expect(router.getModelMaxOutput('anthropic')).toBe(128_000);
    expect(router.getModelMaxOutput('anthropic', 'claude-3-5-haiku-20241022')).toBe(64_000);
  });
});
