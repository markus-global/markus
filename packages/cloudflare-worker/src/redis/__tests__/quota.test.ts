/**
 * Tests for the Redis-backed CU quota deduction module.
 *
 * Covers the atomic Lua script semantics (mocked via fetch),
 * in-memory fallback, and edge cases.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RedisClient } from '../client.js';
import { deductQuota, resetFallbackStore, getFallbackStatus } from '../quota.js';
import type { Env } from '../../index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockEnv(overrides?: Partial<Env>): Env {
  return {
    ENVIRONMENT: 'test',
    UPSTASH_REDIS_URL: overrides?.UPSTASH_REDIS_URL ?? 'https://mock.upstash.io',
    UPSTASH_REDIS_TOKEN: overrides?.UPSTASH_REDIS_TOKEN ?? 'mock-token',
    DEFAULT_CU_LIMIT: overrides?.DEFAULT_CU_LIMIT ?? '100000',
  };
}

// ---------------------------------------------------------------------------
// RedisClient — parseQuotaResult
// ---------------------------------------------------------------------------

describe('RedisClient.parseQuotaResult', () => {
  it('should parse a valid success response', () => {
    const result = RedisClient.parseQuotaResult(
      JSON.stringify({ remaining: 95, usage: 5, limit: 100 }),
    );
    expect(result).toEqual({ remaining: 95, usage: 5, limit: 100 });
  });

  it('should parse a quota-exceeded response (remaining === -1)', () => {
    const result = RedisClient.parseQuotaResult(
      JSON.stringify({ remaining: -1, usage: 98, limit: 100 }),
    );
    expect(result.remaining).toBe(-1);
    expect(result.usage).toBe(98);
  });

  it('should handle malformed JSON gracefully', () => {
    const result = RedisClient.parseQuotaResult('not-json');
    expect(result.error).toBe('failed_to_parse_redis_response');
    expect(result.remaining).toBe(0);
  });

  it('should handle an error response from Lua script', () => {
    const result = RedisClient.parseQuotaResult(
      JSON.stringify({ error: 'invalid_deduct_amount', remaining: 0, usage: 0, limit: 0 }),
    );
    expect(result.error).toBe('invalid_deduct_amount');
  });
});

// ---------------------------------------------------------------------------
// deductQuota — Redis path (mocked fetch)
// ---------------------------------------------------------------------------

describe('deductQuota — Redis path', () => {
  beforeEach(() => {
    resetFallbackStore();
  });

  it('should deduct CU when quota is sufficient', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        result: JSON.stringify({ remaining: 95, usage: 5, limit: 100 }),
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await deductQuota(makeMockEnv({ DEFAULT_CU_LIMIT: '100' }), 'user1', 5);
    expect(result.remaining).toBe(95);
    expect(result.usage).toBe(5);
    expect(result.limit).toBe(100);
    expect(result.error).toBeUndefined();

    // Verify the Redis command was sent correctly
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[0]).toBe('https://mock.upstash.io');
    const body = JSON.parse(callArgs[1].body as string);
    expect(body[0]).toBe('EVAL');
    expect(body[2]).toBe('1'); // 1 key
    expect(body[3]).toBe('cu:user1'); // key
    expect(body[4]).toBe('5'); // amount
    expect(body[5]).toBe('100'); // limit

    vi.unstubAllGlobals();
  });

  it('should rollback and return -1 when quota would be exceeded', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        result: JSON.stringify({ remaining: -1, usage: 98, limit: 100 }),
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await deductQuota(makeMockEnv({ DEFAULT_CU_LIMIT: '100' }), 'user2', 10);
    expect(result.remaining).toBe(-1);
    expect(result.usage).toBe(98);

    vi.unstubAllGlobals();
  });

  it('should return error for invalid amount (zero)', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const result = await deductQuota(makeMockEnv(), 'user3', 0);
    expect(result.error).toBe('invalid_amount');
    // Should NOT have called Redis
    expect(mockFetch).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('should return error for invalid amount (negative)', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const result = await deductQuota(makeMockEnv(), 'user4', -5);
    expect(result.error).toBe('invalid_amount');
    expect(mockFetch).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// deductQuota — Fallback path when Redis is unavailable
// ---------------------------------------------------------------------------

describe('deductQuota — Redis fallback (in-memory)', () => {
  beforeEach(() => {
    resetFallbackStore();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should fall back to in-memory when Redis fetch fails', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
    vi.stubGlobal('fetch', mockFetch);

    const env = makeMockEnv({ DEFAULT_CU_LIMIT: '50' });
    const result = await deductQuota(env, 'user-fallback-1', 10);
    expect(result.remaining).toBe(40);
    expect(result.usage).toBe(10);
    expect(result.limit).toBe(50);

    // Verify fallback store updated
    const status = getFallbackStatus('user-fallback-1');
    expect(status.active).toBe(true);
    expect(status.usage).toBe(10);

    vi.unstubAllGlobals();
  });

  it('should accumulate deductions across multiple calls in fallback', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
    vi.stubGlobal('fetch', mockFetch);

    const env = makeMockEnv({ DEFAULT_CU_LIMIT: '50' });

    // First call
    await deductQuota(env, 'user-fallback-2', 10);
    // Second call
    const result2 = await deductQuota(env, 'user-fallback-2', 20);
    expect(result2.remaining).toBe(20);
    expect(result2.usage).toBe(30);

    vi.unstubAllGlobals();
  });

  it('should return -1 in fallback when quota exceeded', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
    vi.stubGlobal('fetch', mockFetch);

    const env = makeMockEnv({ DEFAULT_CU_LIMIT: '30' });

    await deductQuota(env, 'user-fallback-3', 25);
    const result = await deductQuota(env, 'user-fallback-3', 10);
    expect(result.remaining).toBe(-1);
    expect(result.usage).toBe(25); // Not incremented (rollback)

    vi.unstubAllGlobals();
  });

  it('should have independent fallback stores per user', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
    vi.stubGlobal('fetch', mockFetch);

    const env = makeMockEnv({ DEFAULT_CU_LIMIT: '100' });

    await deductQuota(env, 'user-a', 30);
    const resultB = await deductQuota(env, 'user-b', 10);

    expect(resultB.remaining).toBe(90);
    expect(resultB.usage).toBe(10);

    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// getFallbackStatus
// ---------------------------------------------------------------------------

describe('getFallbackStatus', () => {
  beforeEach(() => {
    resetFallbackStore();
  });

  it('should return inactive for a user not in store', () => {
    const status = getFallbackStatus('unknown-user');
    expect(status.active).toBe(false);
    expect(status.usage).toBe(0);
  });

  it('should return usage after deductions', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', mockFetch);

    const env = makeMockEnv({ DEFAULT_CU_LIMIT: '200' });
    await deductQuota(env, 'user-status', 42);

    const status = getFallbackStatus('user-status');
    expect(status.active).toBe(true);
    expect(status.usage).toBe(42);
    expect(status.limit).toBe(200);

    vi.unstubAllGlobals();
  });
});
