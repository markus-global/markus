/**
 * quota.ts — High-level CU quota deduction with Redis + fallback.
 *
 * Provides a single function `deductQuota()` that:
 * 1. Calls the atomic Lua deduction script via Upstash Redis
 * 2. Falls back to in-memory tracking if Redis is unavailable
 * 3. Returns a typed result
 */

import { QUOTA_DEDUCTION_SCRIPT } from './quota-lua';
import { RedisClient, QuotaDeductionResult } from './client';
import type { Env } from '../index';

/**
 * In-memory fallback store for CU quotas.
 * Used when Redis is unavailable. NOT durable — use only as last resort.
 *
 * Maps userId → { usage, limit }
 */
const fallbackStore = new Map<string, { usage: number; limit: number }>();

/**
 * Deduct CU from a user's quota.
 *
 * Primary path: Upstash Redis (atomic Lua script)
 * Fallback path: In-memory best-effort tracking (if Redis is down)
 *
 * @param env - Worker environment bindings
 * @param userId - User identifier for quota tracking
 * @param amount - Number of CUs to deduct
 * @returns QuotaDeductionResult with remaining usage info
 */
export async function deductQuota(
  env: Env,
  userId: string,
  amount: number,
): Promise<QuotaDeductionResult> {
  // Validate amount
  if (!amount || amount <= 0) {
    return { remaining: 0, usage: 0, limit: 0, error: 'invalid_amount' };
  }

  const key = `cu:${userId}`;
  const defaultLimit = parseInt(env.DEFAULT_CU_LIMIT || '100000', 10);
  const resetTs = Math.floor(Date.now() / 1000) + 86400; // T+1d reset

  try {
    return await deductViaRedis(env, key, amount, defaultLimit, resetTs);
  } catch (err) {
    console.error(
      `[quota] Redis unavailable for user ${userId}, using fallback:`,
      err instanceof Error ? err.message : String(err),
    );
    return deductFallback(userId, amount, defaultLimit);
  }
}

/**
 * Deduct via Upstash Redis atomic Lua script.
 */
async function deductViaRedis(
  env: Env,
  key: string,
  amount: number,
  limit: number,
  resetTs: number,
): Promise<QuotaDeductionResult> {
  const redis = new RedisClient(env.UPSTASH_REDIS_URL, env.UPSTASH_REDIS_TOKEN);

  const rawResult = await redis.eval(
    QUOTA_DEDUCTION_SCRIPT,
    [key],
    [String(amount), String(limit), String(resetTs)],
  );

  return RedisClient.parseQuotaResult(rawResult);
}

/**
 * In-memory fallback deduction.
 * Used when Redis is unavailable.
 *
 * CONS: Not durable across Worker instances.
 * PROS: Prevents total service outage due to Redis failure.
 */
function deductFallback(
  userId: string,
  amount: number,
  defaultLimit: number,
): QuotaDeductionResult {
  let entry = fallbackStore.get(userId);

  if (!entry) {
    entry = { usage: 0, limit: defaultLimit };
    fallbackStore.set(userId, entry);
  }

  const newUsage = entry.usage + amount;

  if (newUsage > entry.limit) {
    return { remaining: -1, usage: entry.usage, limit: entry.limit };
  }

  entry.usage = newUsage;
  return {
    remaining: entry.limit - entry.usage,
    usage: entry.usage,
    limit: entry.limit,
  };
}

/**
 * Get current fallback quota status for a user (for diagnostics).
 */
export function getFallbackStatus(userId: string): {
  active: boolean;
  usage: number;
  limit: number;
} {
  const entry = fallbackStore.get(userId);
  if (!entry) {
    return { active: false, usage: 0, limit: 0 };
  }
  return { active: true, usage: entry.usage, limit: entry.limit };
}

/**
 * Reset fallback store (for testing).
 */
export function resetFallbackStore(): void {
  fallbackStore.clear();
}
