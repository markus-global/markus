import { describe, it, expect, vi, afterEach } from 'vitest';
import { validateApiKey } from '../src/commands/model.js';

describe('validateApiKey', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects unknown provider', async () => {
    const result = await validateApiKey('not-real', 'key', 'model');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Unknown provider');
  });

  it('validates anthropic key successfully', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' }),
    );
    const result = await validateApiKey('anthropic', 'sk-test1234567890', 'claude-sonnet-4-20250514');
    expect(result.ok).toBe(true);
    expect(result.model).toBe('claude-sonnet-4-20250514');
  });

  it('reports invalid anthropic key on 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'Unauthorized' }),
    );
    const result = await validateApiKey('anthropic', 'bad-key', 'claude-sonnet-4-20250514');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Invalid API key');
  });

  it('reports anthropic rate limit on 429', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => 'Rate limited' }),
    );
    const result = await validateApiKey('anthropic', 'sk-test1234567890', 'claude-sonnet-4-20250514');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Rate limited');
  });

  it('reports anthropic HTTP errors with status code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'Server error details' }),
    );
    const result = await validateApiKey('anthropic', 'sk-test1234567890', 'claude-sonnet-4-20250514');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/HTTP 500/);
  });

  it('reports anthropic network errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
    const result = await validateApiKey('anthropic', 'sk-test1234567890', 'claude-sonnet-4-20250514');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Network error');
    expect(result.error).toContain('connection refused');
  });

  it('validates openai-compatible provider successfully', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' }),
    );
    const result = await validateApiKey('openai', 'sk-test1234567890', 'gpt-4o-mini');
    expect(result.ok).toBe(true);
    expect(result.model).toBe('gpt-4o-mini');
  });

  it('reports invalid openai key on 403', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => 'Forbidden' }),
    );
    const result = await validateApiKey('openai', 'bad-key', 'gpt-4o-mini');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Invalid API key');
  });

  it('reports openai rate limit on 429', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => 'Quota exceeded' }),
    );
    const result = await validateApiKey('openai', 'sk-test1234567890', 'gpt-4o-mini');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Rate limited');
  });

  it('reports openai network errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue('timeout'));
    const result = await validateApiKey('deepseek', 'sk-test1234567890', 'deepseek-v4-flash', 'https://api.deepseek.com');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Network error');
  });

  it('uses provider default model when model arg is empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' }),
    );
    const result = await validateApiKey('openai', 'sk-test1234567890', '');
    expect(result.ok).toBe(true);
    expect(result.model).toBeTruthy();
  });
});
