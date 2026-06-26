/**
 * Charging middleware — pre-reserve + post-correct CU (token-billing).
 *
 * Implements the "pre-reserve + post-correct" pattern (inspired by New API):
 *
 *   1. **Pre-reserve** (`handleCharging`)
 *      - Intercepts POST /v1/chat/completions in proxy mode.
 *      - Estimates the maximum CU this request could consume (based on model
 *        max_tokens and input message length).
 *      - Calls `deductQuota` to reserve it.
 *      - If insufficient quota → 429 CU_EXCEEDED.
 *      - Stores charging context on the request (via Symbol) for post-correction.
 *
 *   2. **Post-correct** (`postCorrectCu`)
 *      - After the handler completes, reads the actual CU usage from the
 *        response header `x-cu-actual` (set by the chat handler).
 *      - If actual < reserved, calls `creditQuota` to refund the difference.
 *      - Adds `x-cu-remaining` and `x-cu-limit` headers to the response.
 *
 * Design invariants:
 *   - The charging middleware is the SINGLE source of truth for CU deduction.
 *     Handlers MUST NOT call deductQuota directly — they only report actual usage.
 *   - Direct API-key mode (self-provided key) bypasses all charging.
 *   - Public routes (/health) bypass charging.
 *   - Redis failure degrades gracefully: in-memory fallback + logged warning.
 */

import { deductQuota, creditQuota } from '../redis/quota.js';
import { getAuthContext } from '../auth-context.js';
import { tooManyRequests } from '../utils/response.js';
import { forbidden as errorForbidden } from '../utils/errors.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Request-scoped Symbol for attaching charging context. */
const CHARGING_SYMBOL = Symbol.for('markus.charging.context');

/** Default max output tokens when request does not specify one. */
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/** Approximate chars per token for CU estimation. */
const CHARS_PER_TOKEN = 4;

/** Tokens per CU (1 CU ≈ 1000 tokens). */
const TOKENS_PER_CU = 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChargingContext {
  /** User ID from the JWT payload (sub). */
  userId: string;
  /** Number of CU reserved for this request. */
  reserved: number;
  /** CU limit for this user. */
  limit: number;
}

export interface PreReserveResult {
  ok: true;
  reserved: number;
  remaining: number;
  limit: number;
}

export interface PreReserveError {
  ok: false;
  code: 'QUOTA_EXCEEDED' | 'RESERVE_FAILED' | 'NO_AUTH' | 'PROXY_MODE_ONLY';
  message: string;
}

// ---------------------------------------------------------------------------
// Request-scoped charging context
// ---------------------------------------------------------------------------

/** Attach charging context to a request. */
export function setChargingContext(request: Request, ctx: ChargingContext): void {
  (request as unknown as Record<symbol, ChargingContext>)[CHARGING_SYMBOL] = ctx;
}

/** Retrieve previously attached charging context. */
export function getChargingContext(request: Request): ChargingContext | undefined {
  return (request as unknown as Record<symbol, ChargingContext | undefined>)[CHARGING_SYMBOL];
}

// ---------------------------------------------------------------------------
// Pre-reserve helpers
// ---------------------------------------------------------------------------

/** Estimate the maximum CU this request could consume. */
export function estimateMaxCu(body: ChatRequestBody): number {
  // Estimate input tokens from message content
  const charCount = (body.messages ?? []).reduce(
    (sum, msg) => sum + (typeof msg.content === 'string' ? msg.content.length : 0),
    0,
  );
  const inputTokens = Math.max(1, Math.ceil(charCount / CHARS_PER_TOKEN));

  // Account for output tokens (default to a generous max)
  const maxOutputTokens = body.max_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

  // Total max tokens = input + output. This is intentionally generous.
  const totalMaxTokens = inputTokens + maxOutputTokens;

  // Convert to CU: 1 CU ≈ 1000 tokens
  return Math.max(1, Math.ceil(totalMaxTokens / TOKENS_PER_CU));
}

/**
 * Pre-reserve CU for this request.
 *
 * This is the actual CU deduction. The handler must NOT deduct again —
 * it only reports actual usage via the x-cu-actual response header.
 */
export async function preReserveCu(
  env: Record<string, unknown>,
  userId: string,
  maxCu: number,
): Promise<PreReserveResult | PreReserveError> {
  // Check Redis is configured
  const hasRedis = !!(env as Record<string, string>)['UPSTASH_REDIS_URL'];
  if (!hasRedis) {
    // No Redis configured — skip pre-reserve (charging is disabled)
    return {
      ok: true,
      reserved: 0,
      remaining: 999999,
      limit: 999999,
    };
  }

  try {
    const result = await deductQuota(env as unknown as Parameters<typeof deductQuota>[0], userId, maxCu);

    if (result.error) {
      return {
        ok: false,
        code: 'RESERVE_FAILED',
        message: `CU reservation failed: ${result.error}`,
      };
    }

    if (result.remaining === -1) {
      return {
        ok: false,
        code: 'QUOTA_EXCEEDED',
        message: `Monthly CU quota (${result.limit}) exhausted. Current usage: ${result.usage}`,
      };
    }

    return {
      ok: true,
      reserved: maxCu,
      remaining: result.remaining,
      limit: result.limit,
    };
  } catch (err) {
    // Redis / fallback completely failed — degrade gracefully
    console.error(
      '[charging] Pre-reserve failed (degrading):',
      err instanceof Error ? err.message : String(err),
    );
    return {
      ok: true,
      reserved: 0,
      remaining: -2,
      limit: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Post-correction helpers
// ---------------------------------------------------------------------------

/**
 * Post-correct CU after the handler completes.
 *
 * If the actual CU usage is less than the reserved amount, refunds the
 * difference via `creditQuota`.
 *
 * Also decorates the response with CU headers (x-cu-remaining, x-cu-limit).
 */
export async function postCorrectCu(
  env: Record<string, unknown>,
  request: Request,
  response: Response,
): Promise<Response> {
  const chargingCtx = getChargingContext(request);

  // No charging context → nothing to correct (direct mode, health, etc.)
  if (!chargingCtx || chargingCtx.reserved <= 0) {
    return response;
  }

  // Read actual CU usage from handler's response header
  const actualCuHeader = response.headers.get('x-cu-actual');
  const actualCu = actualCuHeader ? parseInt(actualCuHeader, 10) : 0;

  // Determine final CU cost: use actual if available, otherwise fall back to reserved
  const finalCu = actualCu > 0 ? actualCu : chargingCtx.reserved;

  // Calculate remaining: what the user has left after this request
  const remaining = Math.max(0, chargingCtx.limit - finalCu);

  if (actualCu <= 0) {
    // No actual CU reported — charge the reserved amount, no refund
    return addCuHeaders(response, finalCu, remaining, chargingCtx.limit);
  }

  // Calculate refund: if reserved > actual, refund the difference
  const refund = chargingCtx.reserved - actualCu;

  if (refund > 0) {
    try {
      await creditQuota(env as unknown as Parameters<typeof creditQuota>[0], chargingCtx.userId, refund);
    } catch (err) {
      // Refund failure is non-fatal — log and continue
      console.error(
        '[charging] Post-correct refund failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
    return addCuHeaders(response, finalCu, remaining, chargingCtx.limit);
  }

  // No refund needed (actual >= reserved)
  return addCuHeaders(response, finalCu, remaining, chargingCtx.limit);
}

/**
 * Add CU-related headers to a response.
 */
function addCuHeaders(
  response: Response,
  cuCost: number,
  remainingOrLimit: number,
  limit?: number,
): Response {
  const headers = new Headers(response.headers);
  headers.set('x-cu-cost', String(cuCost));
  headers.set('x-cu-remaining', String(remainingOrLimit));

  if (limit !== undefined) {
    headers.set('x-cu-limit', String(limit));
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ---------------------------------------------------------------------------
// Types for request body parsing
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: string;
  content: string;
  [key: string]: unknown;
}

interface ChatRequestBody {
  model?: string;
  messages?: ChatMessage[];
  max_tokens?: number;
  stream?: boolean;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Main middleware entry point
// ---------------------------------------------------------------------------

/**
 * Handle charging as a middleware step.
 *
 * Returns:
 *   - A Response (429) if quota is exceeded or charging is impossible.
 *   - null to pass through (with charging context attached to request).
 *
 * The caller MUST call `postCorrectCu` after the handler returns.
 */
export async function handleCharging(
  request: Request,
  env: Record<string, unknown>,
): Promise<Response | null> {
  // Only intercept POST /v1/chat/completions
  const url = new URL(request.url);
  if (url.pathname !== '/v1/chat/completions' || request.method !== 'POST') {
    return null;
  }

  // Only charge in proxy JWT mode (direct mode = no billing)
  const auth = getAuthContext(request);
  if (!auth || auth.mode !== 'proxy') {
    return null;
  }

  const { payload } = auth;

  // --- Parse the request body to estimate max CU ---------------------------
  let body: ChatRequestBody;
  try {
    body = (await request.clone().json()) as ChatRequestBody;
  } catch {
    // Malformed JSON — let the handler return a proper 400
    return null;
  }

  // --- Pre-reserve CU ------------------------------------------------------
  const maxCu = estimateMaxCu(body);
  const result = await preReserveCu(env, payload.sub, maxCu);

  if (!result.ok) {
    // Insufficient quota → 429
    return tooManyRequests(
      errorForbidden(
        result.code === 'QUOTA_EXCEEDED'
          ? result.message
          : `CU reservation failed: ${result.message}`,
      ),
    );
  }

  // --- Store charging context for post-correction --------------------------
  setChargingContext(request, {
    userId: payload.sub,
    reserved: result.reserved,
    limit: result.limit,
  });

  return null; // pass through
}
