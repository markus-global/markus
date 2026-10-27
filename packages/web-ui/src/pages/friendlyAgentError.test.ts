/**
 * Regression tests for `friendlyAgentError`.
 *
 * The bug these guard (production, 2026-10-26 18:12): an agent hit a context
 * overflow and the owner was shown
 *
 *   ⚠ AI 服务认证失败：8c9e6090-…","type":"invalid_request_error"…}。请检查配置。
 *
 * Nothing about that message was true: DeepSeek had returned HTTP **400**
 * (`invalid_request_error`, context length 1,048,576 exceeded, 1,040,163 tokens
 * in the messages). Two independent defects produced the lie:
 *
 *   1. `raw.includes('401')` — the token count `1040163` contains the substring
 *      `401`, so a 400 was classified as an authentication failure and the owner
 *      was sent hunting for a broken API key that was perfectly fine.
 *   2. The detail came from "everything after the last `': '`", which on nested
 *      escaped JSON yields a mangled tail instead of the provider's explanation.
 *
 * Both defects are asserted below, so neither can come back silently.
 */
import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { friendlyAgentError } from './ChatComponents.tsx';

const TEMPLATES: Record<string, string> = {
  'team:errors.aiContextOverflow': 'CONTEXT_OVERFLOW asked={{asked}} limit={{limit}}',
  'team:errors.ai401': 'AUTH detail={{detail}}',
  'team:errors.ai429': 'RATE detail={{detail}}',
  'team:errors.ai409': 'CONFLICT detail={{detail}}',
  'team:errors.ai502': 'GATEWAY detail={{detail}}',
  'team:errors.ai503': 'UNAVAILABLE detail={{detail}}',
  'team:errors.aiGeneric': 'GENERIC detail={{detail}}',
  'team:errors.defaultInvalidApiKey': 'DEFAULT_KEY',
  'team:errors.defaultTooManyRequests': 'DEFAULT_429',
  'team:errors.defaultConflict': 'DEFAULT_409',
  'team:errors.defaultUpstreamDown': 'DEFAULT_502',
  'team:errors.defaultServiceDown': 'DEFAULT_503',
};

/** Honest test double for i18next's TFunction — renders the template + vars. */
const t = ((key: string, opts?: Record<string, unknown>) => {
  const template = TEMPLATES[key] ?? `MISSING(${key})`;
  return template.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(opts?.[name] ?? ''));
}) as unknown as TFunction;

/** The real production payload, verbatim from runtime-2026-10-26.log. */
const CONTEXT_OVERFLOW_400 =
  'ContextOverflowError: [CONTEXT OVERFLOW] This prompt does not fit the model\'s context window. ' +
  'Nothing was trimmed automatically — the platform no longer predicts token counts. ' +
  'Provider said: [deepseek:deepseek-v4-flash] OpenAI API error 400: ' +
  '{"error":{"message":"This model\'s maximum context length is 1048576 tokens. However, you requested 1072931 tokens (1040163 in the messages, 32768 in the completion). Please reduce the length of the messages or completion. (request_id: 8c9e6090-a26e-41f6-9dad-80d1d7855a00)","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}';

describe('friendlyAgentError — context overflow must never read as an auth failure', () => {
  it('a 400 whose token count contains "401" is not reported as an auth failure', () => {
    const message = friendlyAgentError(CONTEXT_OVERFLOW_400, t);
    expect(message).not.toContain('AUTH');
    expect(message).toContain('CONTEXT_OVERFLOW');
  });

  it('reports the real token numbers so the user can act', () => {
    const message = friendlyAgentError(CONTEXT_OVERFLOW_400, t);
    expect(message).toContain('asked=1,073k');
    expect(message).toContain('limit=1,049k');
  });

  it('keeps the provider explanation instead of a mangled JSON tail', () => {
    const message = friendlyAgentError(CONTEXT_OVERFLOW_400, t);
    expect(message).not.toContain('invalid_request_error');
    expect(message).not.toContain('request_id');
  });
});

describe('friendlyAgentError — status codes are matched structurally', () => {
  it('still detects a genuine 401', () => {
    const message = friendlyAgentError('OpenAI API error 401: {"error":{"message":"Incorrect API key provided"}}', t);
    expect(message).toContain('AUTH');
    expect(message).toContain('Incorrect API key provided');
  });

  it('ignores "401" that only appears inside a token count', () => {
    const message = friendlyAgentError('OpenAI API error 400: {"error":{"message":"too long: 1401655 tokens"}}', t);
    expect(message).not.toContain('AUTH');
  });

  it('does not read a status out of a request id', () => {
    const message = friendlyAgentError('upstream said: boom (request_id: 8c9e6090-41f6-9dad)', t);
    expect(message).toContain('GENERIC');
  });

  it('maps 429 / 409 / 502 / 503 to their own messages', () => {
    expect(friendlyAgentError('OpenAI API error 429: slow down', t)).toContain('RATE');
    expect(friendlyAgentError('HTTP 409: conflict', t)).toContain('CONFLICT');
    expect(friendlyAgentError('OpenAI API error 502: bad gateway', t)).toContain('GATEWAY');
    expect(friendlyAgentError('OpenAI API error 503: unavailable', t)).toContain('UNAVAILABLE');
  });
});

describe('friendlyAgentError — detail extraction', () => {
  it('unwraps nested escaped JSON to the innermost provider message', () => {
    const raw = 'wrapper {"error":"{\\"error\\":{\\"message\\":\\"Real reason here\\"}}"}';
    expect(friendlyAgentError(raw, t)).toContain('Real reason here');
  });

  it('suppresses aborts — they are user-initiated, not errors', () => {
    expect(friendlyAgentError('AbortError: The operation was aborted', t)).toBe('');
  });
});
