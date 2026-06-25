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
 *     ├─ Auth (validates X-Subscription-Key)
 *     │
 *     └─ Router ─┬─ GET  /health                → health.ts
 *                 └─ POST /v1/chat/completions   → chat.ts
 *
 * Future phases will add:
 *   - /v1/models          → model list
 *   - /v1/usage           → usage stats
 *   - Token deduction & quota checks via Hub API
 */

import { handleCors, transformResponse } from './middleware/cors.js';
import { startLog } from './middleware/logging.js';
import { createRateLimiter } from './middleware/rate-limit.js';
import { handleAuth } from './middleware/auth.js';
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

    // ----- 5. Route + handler (with timeout) --------------------------------
    const handler = withTimeout(routeRequest);

    try {
      const response = await handler(request, env, ctx);
      finishLog(response);
      return transformResponse(response);
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
