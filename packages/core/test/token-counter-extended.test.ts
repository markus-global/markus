import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SmartTokenCounter } from '../src/token-counter.js';

describe('SmartTokenCounter extended', () => {
  it('uses tiktoken for gpt-4o after ensureReady', async () => {
    const counter = new SmartTokenCounter();
    counter.setActiveModel('gpt-4o');
    await counter.ensureReady();
    const tokens = counter.countTokens('Hello world from OpenAI model');
    expect(tokens).toBeGreaterThan(0);
    expect(counter.getActiveModel()).toBe('gpt-4o');
  });

  it('selects cl100k_base encoding for gpt-3.5 models', async () => {
    const counter = new SmartTokenCounter();
    counter.setActiveModel('gpt-3.5-turbo');
    await counter.ensureReady();
    expect(counter.countTokens('test')).toBeGreaterThan(0);
  });

  it('countMessageTokens uses tiktoken path when loaded', async () => {
    const counter = new SmartTokenCounter();
    counter.setActiveModel('gpt-4o');
    await counter.ensureReady();
    const msgTokens = counter.countMessageTokens('Assistant reply text', 'assistant');
    expect(msgTokens).toBeGreaterThan(5);
  });

  it('countTokensViaAPI returns token count for claude models', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ input_tokens: 42 }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const counter = new SmartTokenCounter({ anthropicApiKey: 'sk-test', anthropicBaseUrl: 'https://api.test' });
    const count = await counter.countTokensViaAPI(
      [{ role: 'user', content: 'Hello' }],
      'claude-sonnet-4',
    );
    expect(count).toBe(42);
    expect(fetchMock).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('countTokensViaAPI returns null without api key or on failure', async () => {
    const counter = new SmartTokenCounter();
    expect(await counter.countTokensViaAPI([], 'claude-3')).toBeNull();
    expect(await counter.countTokensViaAPI([], 'gpt-4o')).toBeNull();

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    const withKey = new SmartTokenCounter({ anthropicApiKey: 'sk-test' });
    expect(await withKey.countTokensViaAPI([], 'claude-3')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('skips calibration when tiktoken encoder is active', async () => {
    const counter = new SmartTokenCounter();
    counter.setActiveModel('gpt-4o');
    await counter.ensureReady();
    counter.calibrate(100, 200);
    expect(counter.getCalibrationFactor()).toBe(1.0);
  });
});
