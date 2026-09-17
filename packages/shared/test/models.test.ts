import { describe, it, expect } from 'vitest';
import { PROVIDERS, getProvider, getProviderBootstrapModel, resolveProviderBaseUrl, isPlaceholder } from '../src/models.js';

describe('PROVIDERS', () => {
  it('is a non-empty array', () => {
    expect(PROVIDERS.length).toBeGreaterThan(0);
  });

  it('each provider has required fields', () => {
    for (const p of PROVIDERS) {
      expect(p.id).toBeTruthy();
      expect(p.label).toBeTruthy();
      expect(p.envKey).toBeTruthy();
      // `defaultModel` is a *bootstrap* value, not a curated catalog. It is
      // deliberately empty for Hub-driven providers (e.g. `markus`), whose
      // catalog only ever comes from the Hub.
      expect(typeof p.defaultModel).toBe('string');
    }
  });

  it('carries no hardcoded model catalog', () => {
    // Regression guard for the single-source-of-truth rule: the authoritative
    // model list MUST come from the provider's own listing endpoint
    // (`discoverProviderModels()`). A `models` array here would shadow the live
    // list and go stale silently. See the header note in src/models.ts.
    for (const p of PROVIDERS) {
      expect(p).not.toHaveProperty('models');
    }
  });

  it('ships base URLs without a trailing slash', () => {
    // URL building appends version segments (`/models`, `/chat/completions`),
    // so a trailing slash here produces the `//` class of bugs.
    for (const p of PROVIDERS) {
      if (p.baseUrl) expect(p.baseUrl.endsWith('/')).toBe(false);
    }
  });

  it('has unique provider IDs', () => {
    const ids = PROVIDERS.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('contains known providers', () => {
    const ids = PROVIDERS.map(p => p.id);
    expect(ids).toContain('anthropic');
    expect(ids).toContain('openai');
    expect(ids).toContain('google');
  });
});

describe('provider lookups', () => {
  it('getProvider resolves a known id', () => {
    expect(getProvider('anthropic')?.label).toBe('Anthropic');
  });

  it('getProvider returns undefined for unknown ids', () => {
    expect(getProvider('definitely-not-a-provider')).toBeUndefined();
  });

  it('getProviderBootstrapModel returns the bootstrap value, empty when unknown', () => {
    expect(getProviderBootstrapModel('anthropic')).toBe(getProvider('anthropic')?.defaultModel);
    expect(getProviderBootstrapModel('nope')).toBe('');
  });

  it('resolveProviderBaseUrl honours the baseUrlEnv override', () => {
    const p = getProvider('anthropic')!;
    expect(resolveProviderBaseUrl('anthropic', {})).toBe(p.baseUrl);
    expect(resolveProviderBaseUrl('anthropic', { ANTHROPIC_BASE_URL: 'https://proxy.local/' }))
      .toBe('https://proxy.local');
    expect(resolveProviderBaseUrl('nope', {})).toBeUndefined();
  });
});

describe('isPlaceholder', () => {
  it('detects placeholder patterns', () => {
    expect(isPlaceholder('your-api-key-here')).toBe(true);
    expect(isPlaceholder('***hidden***')).toBe(true);
    expect(isPlaceholder('dummy-key')).toBe(true);
    expect(isPlaceholder('fake-key-123')).toBe(true);
    expect(isPlaceholder('test-key-abc')).toBe(true);
    expect(isPlaceholder('replace-me-now')).toBe(true);
  });

  it('detects short keys as placeholders', () => {
    expect(isPlaceholder('abc')).toBe(true);
    expect(isPlaceholder('1234567')).toBe(true);
  });

  it('returns false for valid-looking keys', () => {
    expect(isPlaceholder('sk-proj-abcdefghijklmnopqrstuvwxyz')).toBe(false);
    expect(isPlaceholder('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isPlaceholder('YOUR-API-KEY')).toBe(true);
    expect(isPlaceholder('DUMMY-VALUE')).toBe(true);
  });
});
