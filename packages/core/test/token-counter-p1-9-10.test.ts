/**
 * P1-9 / P1-10 回归。
 *
 * - P1-9：token 计数器曾是**进程级单例**（`getDefaultTokenCounter()`），其
 *   `activeModel` + 编码器槽会被并发 agent 相互覆盖；且流式主路径从不
 *   `setActiveModel()`。现在每个 agent 用独立实例（`createTokenCounter()`）。
 * - P1-10：`initTokenCounter()` 以前只有测试调用，生产从未接线 → Claude 全程
 *   启发式。现在启动期初始化，且新计数器继承其凭据。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SmartTokenCounter,
  createTokenCounter,
  getDefaultTokenCounter,
  initTokenCounter,
  isAnthropicTokenCounterEnabled,
} from '../src/token-counter.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('P1-9: per-agent token counters do not share state', () => {
  it('two counters keep independent active models (no cross-agent contamination)', () => {
    const a = createTokenCounter();
    const b = createTokenCounter();
    expect(a).not.toBe(b);

    a.setActiveModel('gpt-4o');
    b.setActiveModel('claude-3-5-haiku-20241022');

    expect(a.getActiveModel()).toBe('gpt-4o');
    expect(b.getActiveModel()).toBe('claude-3-5-haiku-20241022');

    // Switching b must not affect a (the old singleton leaked this).
    b.setActiveModel('deepseek-chat');
    expect(a.getActiveModel()).toBe('gpt-4o');
  });

  it('alternating two model families yields stable, model-consistent counts', () => {
    const gpt = createTokenCounter();
    const claude = createTokenCounter();
    gpt.setActiveModel('gpt-4o');
    claude.setActiveModel('claude-3-5-haiku-20241022');

    const text = 'hello world '.repeat(64);
    const g1 = gpt.countTokens(text);
    const c1 = claude.countTokens(text);
    // Interleave calls — a shared counter would drift here.
    const c2 = claude.countTokens(text);
    const g2 = gpt.countTokens(text);

    expect(g2).toBe(g1);
    expect(c2).toBe(c1);
    expect(g1).toBeGreaterThan(0);
  });
});

describe('P1-10: Anthropic exact counting is wired and inheritable', () => {
  it('initTokenCounter enables Anthropic counting for new counters', () => {
    initTokenCounter({ anthropicApiKey: 'sk-ant-test' });
    expect(isAnthropicTokenCounterEnabled()).toBe(true);
  });

  it('a counter created after init can call the Anthropic count API', async () => {
    initTokenCounter({ anthropicApiKey: 'sk-ant-test' });
    const c = createTokenCounter();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ input_tokens: 7 }),
    })));

    const n = await c.countTokensViaAPI([{ role: 'user', content: 'hi' }], 'claude-3-5-haiku-20241022');
    expect(n).toBe(7);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('a counter with no Anthropic key falls back gracefully (returns null)', async () => {
    const c = new SmartTokenCounter();
    const n = await c.countTokensViaAPI([{ role: 'user', content: 'hi' }], 'claude-3-5-haiku-20241022');
    expect(n).toBeNull();
  });

  it('getDefaultTokenCounter still returns a usable counter', () => {
    initTokenCounter({ anthropicApiKey: 'sk-ant-test' });
    const c = getDefaultTokenCounter();
    expect(c.countTokens('hello')).toBeGreaterThan(0);
  });
});
