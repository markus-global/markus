import { describe, it, expect } from 'vitest';
import { PROVIDERS, isPlaceholder } from '../src/models.js';

describe('PROVIDERS', () => {
  it('is a non-empty array', () => {
    expect(PROVIDERS.length).toBeGreaterThan(0);
  });

  it('each provider has required fields', () => {
    for (const p of PROVIDERS) {
      expect(p.id).toBeTruthy();
      expect(p.label).toBeTruthy();
      expect(p.envKey).toBeTruthy();
      expect(p.defaultModel).toBeTruthy();
      expect(p.models.length).toBeGreaterThan(0);
      expect(p.models).toContain(p.defaultModel);
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
