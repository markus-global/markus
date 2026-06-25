/**
 * Tests for chat handler helper functions.
 *
 * The main handler (handleChat) is tested in integration-level tests
 * that mock the Worker environment. Here we cover the pure functions.
 */

import { describe, it, expect } from 'vitest';
import { buildUpstreamUrl, estimateCu } from './chat.js';

// ---------------------------------------------------------------------------
// buildUpstreamUrl
// ---------------------------------------------------------------------------

describe('buildUpstreamUrl', () => {
  it('should append /v1/chat/completions to a bare base URL', () => {
    expect(buildUpstreamUrl('https://api.openai.com')).toBe(
      'https://api.openai.com/v1/chat/completions',
    );
  });

  it('should append chat/completions to a /v1 base URL', () => {
    expect(buildUpstreamUrl('https://api.openai.com/v1')).toBe(
      'https://api.openai.com/v1/chat/completions',
    );
  });

  it('should not modify a URL that already includes chat/completions', () => {
    expect(buildUpstreamUrl('https://api.openai.com/v1/chat/completions')).toBe(
      'https://api.openai.com/v1/chat/completions',
    );
  });

  it('should strip trailing slashes before appending', () => {
    expect(buildUpstreamUrl('https://api.openai.com/')).toBe(
      'https://api.openai.com/v1/chat/completions',
    );
    expect(buildUpstreamUrl('https://api.openai.com/v1/')).toBe(
      'https://api.openai.com/v1/chat/completions',
    );
  });
});

// ---------------------------------------------------------------------------
// estimateCu
// ---------------------------------------------------------------------------

describe('estimateCu', () => {
  it('should return 1 for a short conversation', () => {
    const cu = estimateCu({
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ],
    });
    expect(cu).toBe(1);
  });

  it('should scale with message length', () => {
    // 4000 chars → ~1000 tokens → ~1 CU
    const cu = estimateCu({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'A'.repeat(4000) }],
    });
    expect(cu).toBe(1);
  });

  it('should return >1 CU for long messages', () => {
    // 8000 chars → ~2000 tokens → ~2 CU
    const cu = estimateCu({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'A'.repeat(8000) }],
    });
    expect(cu).toBe(2);
  });

  it('should handle empty messages', () => {
    const cu = estimateCu({
      model: 'gpt-4o',
      messages: [],
    });
    expect(cu).toBe(1); // minimum 1 CU
  });

  it('should sum character count across multiple messages', () => {
    const cu = estimateCu({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'B'.repeat(2000) },
        { role: 'user', content: 'C'.repeat(2000) },
      ],
    });
    // 4000 chars → ~1 CU
    expect(cu).toBe(1);
  });
});
