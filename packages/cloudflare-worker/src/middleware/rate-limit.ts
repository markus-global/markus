/**
 * Rate-limit middleware — simple in-memory sliding-window rate limiter.
 *
 * ⚠️  This is a per-worker-instance limiter.  For production use with
 *     multiple concurrent Workers, replace with a Durable Object or
 *     KV-backed counter.
 */

import { rateLimited } from '../utils/errors.js';
import { tooManyRequests } from '../utils/response.js';

export interface RateLimitOptions {
  /** Max requests allowed within the window. */
  maxRequests: number;
  /** Window duration in milliseconds. */
  windowMs: number;
}

/** Default: 100 requests per 60 seconds. */
const DEFAULT_OPTIONS: RateLimitOptions = {
  maxRequests: 100,
  windowMs: 60_000,
};

interface BucketEntry {
  count: number;
  resetAt: number;
}

/**
 * Simple in-memory rate limiter keyed by IP address (or subscription key).
 *
 * Returns a middleware function that returns a Response (429) if the
 * caller has exceeded the limit, or `null` to allow the request through.
 */
export function createRateLimiter(options?: Partial<RateLimitOptions>) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const buckets = new Map<string, BucketEntry>();

  // Periodically purge stale entries to avoid memory leaks.
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of buckets) {
      if (now >= entry.resetAt) {
        buckets.delete(key);
      }
    }
  }, opts.windowMs);

  return function handleRateLimit(request: Request): Response | null {
    const key = request.headers.get('x-subscription-key')
      ?? request.headers.get('cf-connecting-ip')
      ?? 'anonymous';
    const now = Date.now();
    let bucket = buckets.get(key);

    // Reset window if expired.
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(key, bucket);
    }

    bucket.count++;

    if (bucket.count > opts.maxRequests) {
      const retryAfterSec = Math.ceil((bucket.resetAt - now) / 1000);
      return tooManyRequests(rateLimited(bucket.resetAt - now), retryAfterSec);
    }

    return null; // allowed
  };
}
