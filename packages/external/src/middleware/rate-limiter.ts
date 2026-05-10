/**
 * Rate Limiter Middleware - Per-IP and per-session rate limiting.
 */
import { createLogger, type ExternalContext } from '@markus/shared';
import type { MiddlewareHandler } from './types.js';

const log = createLogger('mw:rate-limiter');

export interface RateLimiterConfig {
  /** Max requests per window per IP */
  maxPerIpPerWindow: number;
  /** Max requests per window per session */
  maxPerSessionPerWindow: number;
  /** Window size in milliseconds */
  windowMs: number;
}

const DEFAULT_CONFIG: RateLimiterConfig = {
  maxPerIpPerWindow: 30,
  maxPerSessionPerWindow: 10,
  windowMs: 60_000,
};

interface RateEntry {
  count: number;
  resetAt: number;
}

export function createRateLimiterMiddleware(config?: Partial<RateLimiterConfig>): MiddlewareHandler {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const ipCounts = new Map<string, RateEntry>();
  const sessionCounts = new Map<string, RateEntry>();

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of ipCounts) {
      if (now >= entry.resetAt) ipCounts.delete(key);
    }
    for (const [key, entry] of sessionCounts) {
      if (now >= entry.resetAt) sessionCounts.delete(key);
    }
  }, cfg.windowMs);

  return async (ctx: ExternalContext, next) => {
    const now = Date.now();
    const ip = ctx.session.ipAddress ?? 'unknown';
    const sessionId = ctx.session.id;

    const ipEntry = ipCounts.get(ip);
    if (ipEntry && now < ipEntry.resetAt) {
      if (ipEntry.count >= cfg.maxPerIpPerWindow) {
        ctx.aborted = true;
        ctx.abortReason = 'Rate limit exceeded (IP)';
        ctx.audit.push({ timestamp: new Date().toISOString(), type: 'rate_limit', action: 'reject_ip', success: false, detail: `${ipEntry.count}/${cfg.maxPerIpPerWindow}` });
        log.debug('IP rate limit hit', { ip, count: ipEntry.count });
        return;
      }
      ipEntry.count++;
    } else {
      ipCounts.set(ip, { count: 1, resetAt: now + cfg.windowMs });
    }

    const sessEntry = sessionCounts.get(sessionId);
    if (sessEntry && now < sessEntry.resetAt) {
      if (sessEntry.count >= cfg.maxPerSessionPerWindow) {
        ctx.aborted = true;
        ctx.abortReason = 'Rate limit exceeded (session)';
        ctx.audit.push({ timestamp: new Date().toISOString(), type: 'rate_limit', action: 'reject_session', success: false, detail: `${sessEntry.count}/${cfg.maxPerSessionPerWindow}` });
        return;
      }
      sessEntry.count++;
    } else {
      sessionCounts.set(sessionId, { count: 1, resetAt: now + cfg.windowMs });
    }

    ctx.audit.push({ timestamp: new Date().toISOString(), type: 'rate_limit', action: 'pass', success: true });
    await next();
  };
}
