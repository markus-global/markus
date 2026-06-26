/**
 * Markus Proxy — Cloudflare Worker entry point.
 *
 * Architecture
 * ────────────
 * Every request flows through a middleware pipeline before reaching the
 * route handler.  Middleware can short-circuit (return a Response) or
 * pass through (return null).  After the handler runs, a final
 * transformation adds CORS headers.
 *
 *   Request
 *     │
 *     ├─ CORS (handles OPTIONS preflight)
 *     ├─ Logging (captures start time)
 *     ├─ Rate Limit (in-memory sliding window)
 *     ├─ Auth (validates JWT or x-api-key)
 *     ├─ Charging (pre-reserve CU, may return 429)
 *     │
 *     └─ Router ─┬─ GET  /health                → health.ts
 *                 └─ POST /v1/chat/completions   → chat.ts
 *                      │
 *                      └─ Post-correct (refund unused CU)
 */

// ---------------------------------------------------------------------------
// Environment bindings
// ---------------------------------------------------------------------------

export interface Env {
  /** Environment identifier ("development", "staging", "production") */
  ENVIRONMENT: string;

  /** Upstream LLM provider base URL (proxy JWT mode) */
  LLM_PROXY_BASE_URL?: string;

  /** Upstream LLM provider API key (proxy JWT mode) */
  LLM_PROXY_API_KEY?: string;

  /** Upstash Redis REST API URL */
  UPSTASH_REDIS_URL: string;

  /** Upstash Redis REST API token */
  UPSTASH_REDIS_TOKEN: string;

  /** Default CU quota limit per user (parsed as number) */
  DEFAULT_CU_LIMIT?: string;
}

import { handleCors, transformResponse } from './middleware/cors.js';
import { startLog } from './middleware/logging.js';
import { createRateLimiter } from './middleware/rate-limit.js';
import { handleAuth } from './middleware/auth.js';
import { handleCharging, postCorrectCu } from './middleware/charging.js';
import { withTimeout } from './middleware/timeout.js';
import { handleHealth } from './routes/health.js';
import { handleChat } from './routes/chat.js';
import { json, notFound as notFoundResponse } from './utils/response.js';
import { notFound } from './utils/errors.js';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

// Record worker start time for health-check uptime reporting.
(globalThis as Record<string, unknown>).START_TIME = Date.now();

// Create rate-limiter instance (persists across requests in the same isolate).
const rateLimit = createRateLimiter();

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Record<string, unknown>, ctx: ExecutionContext): Promise<Response> {
    // ----- 1. CORS preflight (short-circuit) --------------------------------
    const corsResponse = handleCors(request);
    if (corsResponse) return corsResponse;

    // ----- 2. Logging (start timer) -----------------------------------------
    const finishLog = startLog(request, env);

    // ----- 3. Rate limit ----------------------------------------------------
    const rateLimitResponse = rateLimit(request);
    if (rateLimitResponse) {
      finishLog(rateLimitResponse);
      return transformResponse(rateLimitResponse);
    }

    // ----- 4. Auth ----------------------------------------------------------
    const authResponse = await handleAuth(request, env);
    if (authResponse) {
      finishLog(authResponse);
      return transformResponse(authResponse);
    }

    // ----- 5. Charging (pre-reserve CU, may return 429) ---------------------
    const chargingResponse = await handleCharging(request, env);
    if (chargingResponse) {
      finishLog(chargingResponse);
      return transformResponse(chargingResponse);
    }

    // ----- 6. Route + handler (with timeout) --------------------------------
    const handler = withTimeout(routeRequest);

    try {
      const response = await handler(request, env, ctx);
      // Post-correct: refund unused CU after handler completes
      const correctedResponse = await postCorrectCu(env, request, response);
      finishLog(correctedResponse);
      return transformResponse(correctedResponse);
    } catch (err) {
      const errorResponse = handleFatalError(err);
      finishLog(errorResponse);
      return transformResponse(errorResponse);
    }
  },
};

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

async function routeRequest(request: Request, env: Record<string, unknown>, _ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  switch (url.pathname) {
    case '/health':
      return json(handleHealth(request));

    case '/v1/chat/completions':
      return handleChat(request, env);

    default:
      return notFoundResponse(notFound(url.pathname));
  }
}

// ---------------------------------------------------------------------------
// Fatal error catch-all
// ---------------------------------------------------------------------------

function handleFatalError(err: unknown): Response {
  const message = err instanceof Error ? err.message : 'An unexpected error occurred';
  return new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message, type: 'internal_error' } }), {
    status: 500,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
