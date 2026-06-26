/**
 * Tests for the charging middleware (pre-reserve + post-correct CU).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — auto-mock (no factory) to avoid hoisting issues
// ---------------------------------------------------------------------------

vi.mock('../../redis/quota.js');
vi.mock('../../auth-context.js');

// ---------------------------------------------------------------------------
// Subject under test (must import AFTER vi.mock)
// ---------------------------------------------------------------------------

import { deductQuota, creditQuota } from '../../redis/quota.js';
import { getAuthContext } from '../../auth-context.js';

import {
  estimateMaxCu,
  setChargingContext,
  getChargingContext,
  preReserveCu,
  postCorrectCu,
  handleCharging,
} from '../charging.js';

import type { ChargingContext } from '../charging.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(url = 'https://api.markus.com/v1/chat/completions', method = 'POST', body?: unknown): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  return new Request(url, init);
}

function makeEnv(hasRedis = true): Record<string, unknown> {
  return hasRedis
    ? { UPSTASH_REDIS_URL: 'https://redis.example.com', UPSTASH_REDIS_TOKEN: 'tok_abc', DEFAULT_CU_LIMIT: '100000' }
    : { DEFAULT_CU_LIMIT: '100000' };
}

function makeResponse(headers?: Record<string, string>): Response {
  return new Response(JSON.stringify({ id: 'test' }), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('estimateMaxCu', () => {
  it('returns 5 CU for empty messages (1 input + 4096 output = 4097 → 5)', () => {
    expect(estimateMaxCu({ messages: [] })).toBe(5);
  });

  it('returns 5 CU for very short message (1 input + 4096 output = 5)', () => {
    expect(estimateMaxCu({ messages: [{ role: 'user', content: 'Hi' }] })).toBe(5);
  });

  it('returns 5 CU for ~3600 input chars (900 tokens + 4096 output = 4996)', () => {
    const longContent = 'A'.repeat(3600); // ~900 tokens input
    // 900 + 4096 = 4996 → ceil(4996/1000) = 5
    expect(estimateMaxCu({ messages: [{ role: 'user', content: longContent }] })).toBe(5);
  });

  it('accounts for max_tokens in estimation', () => {
    const content = 'A'.repeat(200); // 50 tokens input
    // max_tokens = 100 → 50 + 100 = 150 → 1 CU
    expect(estimateMaxCu({ messages: [{ role: 'user', content }], max_tokens: 100 })).toBe(1);
  });

  it('defaults to 4096 output tokens when max_tokens is not set', () => {
    const content = 'A'.repeat(4000); // 1000 tokens input
    // 1000 + 4096 = 5096 → ceil(5096/1000) = 6
    expect(estimateMaxCu({ messages: [{ role: 'user', content }] })).toBe(6);
  });

  it('sums across multiple messages', () => {
    const msg = { role: 'user' as const, content: 'A'.repeat(2000) };
    // 500 tokens per msg × 3 = 1500 + 4096 = 5596 → 6 CU
    expect(estimateMaxCu({ messages: [msg, msg, msg] })).toBe(6);
  });

  it('returns minimum 1 CU even for zero-length content with max_tokens=0', () => {
    expect(estimateMaxCu({ messages: [{ role: 'user', content: '' }], max_tokens: 0 })).toBe(1);
  });
});

describe('charging context (set/getChargingContext)', () => {
  it('stores and retrieves context from the same request', () => {
    const req = makeRequest();
    const ctx: ChargingContext = { userId: 'u1', reserved: 10, limit: 100 };

    setChargingContext(req, ctx);
    expect(getChargingContext(req)).toEqual(ctx);
  });

  it('returns undefined when no context is set', () => {
    const req = makeRequest();
    expect(getChargingContext(req)).toBeUndefined();
  });

  it('isolates context between different requests', () => {
    const req1 = makeRequest();
    const req2 = makeRequest();
    const ctx: ChargingContext = { userId: 'u1', reserved: 10, limit: 100 };

    setChargingContext(req1, ctx);
    expect(getChargingContext(req2)).toBeUndefined();
    expect(getChargingContext(req1)).toEqual(ctx);
  });
});

describe('preReserveCu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns skip when no Redis is configured', async () => {
    const env = makeEnv(false);
    const result = await preReserveCu(env, 'user1', 10);

    expect(result).toEqual({ ok: true, reserved: 0, remaining: 999999, limit: 999999 });
    expect(deductQuota).not.toHaveBeenCalled();
  });

  it('returns ok with reserved amount on successful deduction', async () => {
    vi.mocked(deductQuota).mockResolvedValueOnce({
      remaining: 990,
      usage: 10,
      limit: 1000,
    });

    const env = makeEnv(true);
    const result = await preReserveCu(env, 'user1', 10);

    expect(result).toEqual({ ok: true, reserved: 10, remaining: 990, limit: 1000 });
    expect(vi.mocked(deductQuota)).toHaveBeenCalledWith(env, 'user1', 10);
  });

  it('returns QUOTA_EXCEEDED when remaining is -1', async () => {
    vi.mocked(deductQuota).mockResolvedValueOnce({
      remaining: -1,
      usage: 100000,
      limit: 1000,
    });

    const env = makeEnv(true);
    const result = await preReserveCu(env, 'user1', 10);

    expect(result).toEqual({
      ok: false,
      code: 'QUOTA_EXCEEDED',
      message: expect.stringContaining('exhausted'),
    });
  });

  it('returns RESERVE_FAILED when deduct returns error', async () => {
    vi.mocked(deductQuota).mockResolvedValueOnce({
      error: 'some_error',
      remaining: 0,
      usage: 0,
      limit: 1000,
    });

    const env = makeEnv(true);
    const result = await preReserveCu(env, 'user1', 10);

    expect(result).toEqual({
      ok: false,
      code: 'RESERVE_FAILED',
      message: expect.stringContaining('some_error'),
    });
  });

  it('degrades gracefully when deductQuota throws', async () => {
    vi.mocked(deductQuota).mockRejectedValueOnce(new Error('Redis timeout'));

    const env = makeEnv(true);
    const result = await preReserveCu(env, 'user1', 10);

    expect(result).toEqual({ ok: true, reserved: 0, remaining: -2, limit: 0 });
  });
});

describe('postCorrectCu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns response unchanged when no charging context exists', async () => {
    const req = makeRequest();
    const res = makeResponse();

    const result = await postCorrectCu(makeEnv(true), req, res);

    expect(result.status).toBe(200);
    const cuHeaders = Array.from(result.headers.keys()).filter(h => h.startsWith('x-cu-'));
    expect(cuHeaders).toHaveLength(0);
  });

  it('adds CU headers without refund when reserved equals actual', async () => {
    const req = makeRequest();
    setChargingContext(req, { userId: 'u1', reserved: 5, limit: 1000 });
    const res = makeResponse({ 'x-cu-actual': '5' });

    const result = await postCorrectCu(makeEnv(true), req, res);

    expect(result.headers.get('x-cu-cost')).toBe('5');
    expect(result.headers.get('x-cu-remaining')).toBe('995'); // 1000 - 5
    expect(result.headers.get('x-cu-limit')).toBe('1000');
    expect(creditQuota).not.toHaveBeenCalled();
  });

  it('refunds difference when reserved > actual', async () => {
    vi.mocked(creditQuota).mockResolvedValueOnce({ remaining: 10, usage: 5, limit: 15 });

    const req = makeRequest();
    setChargingContext(req, { userId: 'u1', reserved: 10, limit: 15 });
    const res = makeResponse({ 'x-cu-actual': '3' });

    const result = await postCorrectCu(makeEnv(true), req, res);

    expect(vi.mocked(creditQuota)).toHaveBeenCalledWith(
      expect.objectContaining({ UPSTASH_REDIS_URL: 'https://redis.example.com' }),
      'u1',
      7, // refund = 10 - 3 = 7
    );
    expect(result.headers.get('x-cu-cost')).toBe('3');
    expect(result.headers.get('x-cu-remaining')).toBe('12'); // 15 - 3 = 12
    expect(result.headers.get('x-cu-limit')).toBe('15');
  });

  it('falls back to reserved amount when x-cu-actual header is missing', async () => {
    const req = makeRequest();
    setChargingContext(req, { userId: 'u1', reserved: 5, limit: 1000 });
    const res = makeResponse(); // no x-cu-actual → uses reserved as final cost

    const result = await postCorrectCu(makeEnv(true), req, res);

    expect(creditQuota).not.toHaveBeenCalled();
    expect(result.headers.get('x-cu-cost')).toBe('5'); // reserved as final cost
    expect(result.headers.get('x-cu-remaining')).toBe('995'); // 1000 - 5
    expect(result.headers.get('x-cu-limit')).toBe('1000');
  });

  it('handles creditQuota failure gracefully (non-fatal)', async () => {
    vi.mocked(creditQuota).mockRejectedValueOnce(new Error('Refund failed'));

    const req = makeRequest();
    setChargingContext(req, { userId: 'u1', reserved: 10, limit: 1000 });
    const res = makeResponse({ 'x-cu-actual': '3' });

    const result = await postCorrectCu(makeEnv(true), req, res);

    expect(result.status).toBe(200);
    expect(result.headers.get('x-cu-cost')).toBe('3');
    expect(result.headers.get('x-cu-remaining')).toBe('997'); // 1000 - 3
    expect(result.headers.get('x-cu-limit')).toBe('1000');
  });

  it('does nothing when reserved is 0 (charging skipped)', async () => {
    const req = makeRequest();
    setChargingContext(req, { userId: 'u1', reserved: 0, limit: 1000 });
    const res = makeResponse({ 'x-cu-actual': '5' });

    const result = await postCorrectCu(makeEnv(true), req, res);

    expect(creditQuota).not.toHaveBeenCalled();
    expect(result.status).toBe(200);
  });
});

describe('handleCharging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: proxy mode, sufficient quota
    vi.mocked(getAuthContext).mockReturnValue({
      mode: 'proxy',
      payload: { sub: 'user_test', plan_type: 'pro', monthly_quota_cu: 100000, cu_used: 0, iat: 1000, exp: 2000 },
    });
    vi.mocked(deductQuota).mockResolvedValue({ remaining: 99990, usage: 10, limit: 100000 });
  });

  it('passes through for non-POST requests', async () => {
    const req = new Request('https://api.markus.com/v1/chat/completions', { method: 'GET' });
    const result = await handleCharging(req, makeEnv(true));
    expect(result).toBeNull();
  });

  it('passes through for non-chat routes', async () => {
    const req = makeRequest('https://api.markus.com/health');
    const result = await handleCharging(req, makeEnv(true));
    expect(result).toBeNull();
  });

  it('passes through when no auth context', async () => {
    vi.mocked(getAuthContext).mockReturnValueOnce(undefined);
    const req = makeRequest();
    const result = await handleCharging(req, makeEnv(true));
    expect(result).toBeNull();
  });

  it('passes through in direct API-key mode', async () => {
    vi.mocked(getAuthContext).mockReturnValueOnce({
      mode: 'direct',
      apiKey: 'sk-xxx',
    });
    const req = makeRequest();
    const result = await handleCharging(req, makeEnv(true));
    expect(result).toBeNull();
  });

  it('passes through and attaches charging context for proxy mode with sufficient quota', async () => {
    const req = makeRequest(undefined, 'POST', {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const result = await handleCharging(req, makeEnv(true));

    expect(result).toBeNull();
    const ctx = getChargingContext(req);
    expect(ctx).toBeDefined();
    expect(ctx!.userId).toBe('user_test');
    expect(ctx!.reserved).toBeGreaterThan(0);
    expect(ctx!.limit).toBe(100000);
  });

  it('returns 429 when quota is exceeded', async () => {
    vi.mocked(deductQuota).mockResolvedValueOnce({
      remaining: -1, usage: 100000, limit: 1000,
    });

    const req = makeRequest(undefined, 'POST', {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const result = await handleCharging(req, makeEnv(true));

    expect(result).not.toBeNull();
    expect(result!.status).toBe(429);
    const body = await result!.json() as { error: { code: string } };
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('passes through for malformed JSON body', async () => {
    const req = new Request('https://api.markus.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });

    const result = await handleCharging(req, makeEnv(true));

    expect(result).toBeNull();
    expect(getChargingContext(req)).toBeUndefined();
  });

  it('passes through when payload lacks sub field', async () => {
    vi.mocked(getAuthContext).mockReturnValueOnce({
      mode: 'proxy',
      payload: { sub: undefined as unknown as string, plan_type: 'pro', monthly_quota_cu: 100000, cu_used: 0, iat: 1000, exp: 2000 },
    });

    const req = makeRequest(undefined, 'POST', {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    const result = await handleCharging(req, makeEnv(true));
    // Should NOT crash — passes through (estimate = 5, deductQuota called with sub=undefined)
    expect(vi.mocked(deductQuota)).toHaveBeenCalledWith(
      expect.anything(),
      undefined, // userId = payload.sub which is undefined
      expect.any(Number),
    );
    expect(result).toBeNull();
  });
});
