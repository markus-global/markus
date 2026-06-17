import { describe, it, expect, vi, afterEach } from 'vitest';
import { validateProviderKey } from '../src/commands/doctor.js';

describe('validateProviderKey', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects unknown provider', async () => {
    const result = await validateProviderKey('fake', 'key', 'model');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Unknown provider');
  });

  it('validates anthropic keys', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const result = await validateProviderKey('anthropic', 'sk-test1234567890', 'claude-sonnet-4-20250514');
    expect(result.ok).toBe(true);
  });

  it('reports anthropic invalid key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    const result = await validateProviderKey('anthropic', 'bad', 'claude-sonnet-4-20250514');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Invalid API key');
  });

  it('validates openai-compatible keys', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const result = await validateProviderKey('openai', 'sk-test1234567890', 'gpt-4o-mini');
    expect(result.ok).toBe(true);
  });

  it('reports network errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const result = await validateProviderKey('openai', 'sk-test1234567890', 'gpt-4o-mini');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Network error');
  });
});
