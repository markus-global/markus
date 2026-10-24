/**
 * A provider's "too many tokens" error must tell the agent what to DO.
 *
 * The platform stopped predicting prompt size, so an oversized request now fails
 * at the provider by design. That is only acceptable if the failure is actionable:
 * a bare `context_length_exceeded` makes the agent retry the same request.
 *
 * The fixtures below are the shapes each provider actually emits (copied from
 * their documented error payloads, not invented) — a classifier tested against
 * made-up strings would pass while production stays broken.
 */

import { describe, it, expect } from 'vitest';
import {
  isContextOverflowError,
  asActionableContextOverflow,
  CONTEXT_OVERFLOW_REMEDY,
} from '../src/llm/context-overflow.js';

const err = (message: string) => new Error(message);

describe('isContextOverflowError — real provider shapes', () => {
  it('recognises OpenAI', () => {
    expect(isContextOverflowError(err(
      "400 This model's maximum context length is 128000 tokens. However, your messages resulted in 140000 tokens. Please reduce the length of the messages.",
    ))).toBe(true);
    expect(isContextOverflowError({ code: 'context_length_exceeded' })).toBe(true);
  });

  it('recognises Anthropic', () => {
    expect(isContextOverflowError(err(
      'prompt is too long: 210000 tokens > 200000 maximum',
    ))).toBe(true);
    expect(isContextOverflowError(err(
      'input length and `max_tokens` exceed context limit: 210000 + 8192 > 200000',
    ))).toBe(true);
  });

  it('recognises Google', () => {
    expect(isContextOverflowError(err(
      'The input exceeds the maximum number of tokens allowed: 2097152',
    ))).toBe(true);
  });

  it('recognises gateway / OSS-server shapes', () => {
    expect(isContextOverflowError(err('context length exceeded: 131072 > 32768'))).toBe(true);
    expect(isContextOverflowError(err('too many tokens in request'))).toBe(true);
    expect(isContextOverflowError(err('the context size was exceeded'))).toBe(true);
  });

  it('does NOT hijack unrelated failures', () => {
    // These must keep their own text — mislabelling them as overflow would send
    // the agent off to compact when the real problem is auth or the network.
    for (const other of [
      'Insufficient Balance',
      '401 Unauthorized',
      'fetch failed (Connect Timeout Error)',
      'rate limit exceeded, retry after 20s',
      'ECONNRESET',
    ]) {
      expect(isContextOverflowError(err(other))).toBe(false);
    }
  });

  it('is safe on junk input', () => {
    expect(isContextOverflowError(undefined)).toBe(false);
    expect(isContextOverflowError(null)).toBe(false);
    expect(isContextOverflowError('')).toBe(false);
    expect(isContextOverflowError(42)).toBe(false);
  });
});

describe('asActionableContextOverflow', () => {
  it('names the lever and says nothing was auto-trimmed', () => {
    const wrapped = asActionableContextOverflow(err('prompt is too long: 210000 tokens > 200000 maximum'));
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped!.message).toContain('CONTEXT OVERFLOW');
    expect(wrapped!.message).toContain("operation:'compact'");
    expect(wrapped!.message).toContain('Nothing was trimmed automatically');
    // The provider's own words survive, so nothing is lost in translation.
    expect(wrapped!.message).toContain('prompt is too long');
    expect(wrapped!.message.startsWith(CONTEXT_OVERFLOW_REMEDY)).toBe(true);
  });

  it('returns undefined for non-overflow failures (they keep their own text)', () => {
    expect(asActionableContextOverflow(err('401 Unauthorized'))).toBeUndefined();
  });

  it('preserves the original error as `cause`', () => {
    const original = err('context_length_exceeded');
    const wrapped = asActionableContextOverflow(original);
    expect((wrapped as { cause?: unknown }).cause).toBe(original);
    expect(wrapped!.name).toBe('ContextOverflowError');
  });
});
