/**
 * LLM Chat Completions proxy endpoint.
 *
 * POST /v1/chat/completions
 *
 * Two modes (determined by auth middleware output):
 *
 * **Proxy JWT mode** (platform billing)
 *   - Validates CU quota from the JWT payload.
 *   - Forwards to the upstream LLM provider configured in env vars.
 *   - Deducts CU on success via Upstash Redis (atomic Lua script).
 *
 * **Direct API-key mode** (self-provided key)
 *   - Forwards to the user-specified provider base URL (x-provider-base-url).
 *   - Uses the user's own API key (x-api-key).
 *   - No quota enforcement.
 *
 * Both modes support streaming (SSE) and non-streaming completions.
 */

import { badRequest } from '../utils/errors.js';
import { badRequest as badRequestResponse, json, sseStream } from '../utils/response.js';
import { getAuthContext } from '../auth-context.js';
import type { Env } from '../index.js';
import { deductQuota } from '../redis/quota.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 60_000;

const JSON_HEADER: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatRequest {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
}

// ---------------------------------------------------------------------------
// Handler (entry point)
// ---------------------------------------------------------------------------

export async function handleChat(
  request: Request,
  env: Record<string, unknown>,
): Promise<Response> {
  // --- Method check -----------------------------------------------------------
  if (request.method !== 'POST') {
    return badRequestResponse(badRequest('Only POST is allowed for /v1/chat/completions'));
  }

  // --- Parse body ------------------------------------------------------------
  let body: ChatRequest;
  try {
    body = (await request.json()) as ChatRequest;
  } catch {
    return badRequestResponse(badRequest('Invalid JSON body'));
  }

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return badRequestResponse(badRequest('messages array is required and must be non-empty'));
  }

  if (!body.model) {
    return badRequestResponse(badRequest('model field is required'));
  }

  // --- Auth check ------------------------------------------------------------
  const auth = getAuthContext(request);
  if (!auth) {
    return badRequestResponse(badRequest('Authentication context not found'));
  }

  // --- Route by auth mode ----------------------------------------------------
  if (auth.mode === 'proxy') {
    return handleProxyChat(request, body, auth, env);
  }
  return handleDirectChat(request, body, auth, env);
}

// ---------------------------------------------------------------------------
// Proxy JWT mode (with CU quota deduction)
// ---------------------------------------------------------------------------

async function handleProxyChat(
  _request: Request,
  body: ChatRequest,
  auth: { mode: 'proxy'; payload: { monthly_quota_cu: number; cu_used: number; sub: string } },
  env: Record<string, unknown>,
): Promise<Response> {
  const { payload } = auth;

  // --- CU quota pre-check (approximate, based on JWT metadata) ---------------
  const estimatedCu = estimateCu(body);
  const remainingCu = payload.monthly_quota_cu - payload.cu_used;

  if (remainingCu <= 0) {
    return errorJson(429, {
      code: 'QUOTA_EXCEEDED',
      message: `Monthly CU quota (${payload.monthly_quota_cu}) exhausted. Remaining: ${remainingCu}`,
    });
  }

  if (estimatedCu > remainingCu) {
    return errorJson(429, {
      code: 'INSUFFICIENT_QUOTA',
      message: `Request requires ~${estimatedCu} CU but only ${remainingCu} remaining`,
    });
  }

  // --- Read upstream config from env -----------------------------------------
  const proxyBaseUrl = env.LLM_PROXY_BASE_URL as string | undefined;
  const proxyApiKey = env.LLM_PROXY_API_KEY as string | undefined;

  if (!proxyBaseUrl || !proxyApiKey) {
    return errorJson(500, {
      code: 'PROXY_MISCONFIGURED',
      message: 'LLM_PROXY_BASE_URL and LLM_PROXY_API_KEY env vars must be configured',
    });
  }

  const upstreamUrl = buildUpstreamUrl(proxyBaseUrl);
  const isStreaming = body.stream === true;

  // Build the upstream request body
  const upstreamBody: Record<string, unknown> = {
    model: body.model,
    messages: body.messages,
    stream: isStreaming,
  };
  if (body.max_tokens !== undefined) upstreamBody.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) upstreamBody.temperature = body.temperature;

  const requestHeaders: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${proxyApiKey}`,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(upstreamBody),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!upstreamResponse.ok) {
    const errorBody = await upstreamResponse.text();
    return errorJson(502, {
      code: 'UPSTREAM_ERROR',
      message: `Upstream returned ${upstreamResponse.status}`,
      upstream_status: upstreamResponse.status,
      upstream_body: errorBody,
    });
  }

  // --- Deduct CU after successful upstream response -------------------------
  const envTyped = env as unknown as Env;
  const userId = payload.sub;

  if (!isStreaming) {
    // Non-streaming: parse body to get actual token usage, then attach CU headers
    const data = (await upstreamResponse.json()) as Record<string, unknown>;

    const totalTokens =
      typeof (data.usage as Record<string, unknown> | undefined)?.total_tokens === 'number'
        ? (data.usage as Record<string, unknown>).total_tokens as number
        : 0;

    const actualCu = totalTokens > 0
      ? Math.max(1, Math.ceil(totalTokens / 1000))
      : estimatedCu;

    const quotaResult = await safeDeduct(envTyped, userId, actualCu);

    // Build response with CU headers
    const responseHeaders: Record<string, string> = {
      'content-type': 'application/json; charset=utf-8',
      'x-cu-cost': String(actualCu),
      'x-cu-remaining': String(quotaResult.remaining),
      'x-cu-limit': String(quotaResult.limit),
    };

    return new Response(JSON.stringify(data), {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  }

  // --- Streaming: pipe the upstream body as SSE with CU headers -------------
  const streamBody = upstreamResponse.body;
  if (!streamBody) {
    return errorJson(502, {
      code: 'UPSTREAM_NO_BODY',
      message: 'Upstream returned no body',
    });
  }

  // For streaming, use estimated CU (exact token counting requires Hub-side accounting)
  const actualCu = estimatedCu;
  const quotaResult = await safeDeduct(envTyped, userId, actualCu);

  const responseHeaders: Record<string, string> = {
    'content-type': 'text/event-stream',
    'transfer-encoding': 'chunked',
    'x-cu-cost': String(actualCu),
    'x-cu-remaining': String(quotaResult.remaining),
    'x-cu-limit': String(quotaResult.limit),
  };

  return new Response(streamBody, {
    status: upstreamResponse.status,
    headers: responseHeaders,
  });
}

/**
 * Safely deduct CU, returning a default success if Redis isn't configured
 * or the deduction fails.
 */
async function safeDeduct(
  env: Env,
  userId: string,
  amount: number,
): Promise<{ remaining: number; limit: number }> {
  if (!env.UPSTASH_REDIS_URL || !env.UPSTASH_REDIS_TOKEN) {
    console.warn('[quota] UPSTASH_REDIS_URL/TOKEN not configured — skipping deduction');
    return { remaining: 999999, limit: 999999 };
  }

  try {
    const result = await deductQuota(env, userId, amount);
    return { remaining: result.remaining, limit: result.limit };
  } catch (err) {
    console.error('[quota] Deduction failed (non-fatal):', err instanceof Error ? err.message : String(err));
    return { remaining: -2, limit: 0 };
  }
}

// ---------------------------------------------------------------------------
// Direct API-key mode
// ---------------------------------------------------------------------------

async function handleDirectChat(
  request: Request,
  body: ChatRequest,
  auth: { mode: 'direct'; apiKey: string },
  _env: Record<string, unknown>,
): Promise<Response> {
  // The provider base URL is passed via a header (set by the client).
  const providerBaseUrl = request.headers.get('x-provider-base-url');
  if (!providerBaseUrl) {
    return badRequestResponse(badRequest('x-provider-base-url header is required in direct mode'));
  }

  const upstreamUrl = buildUpstreamUrl(providerBaseUrl);
  return forwardToUpstream(body, upstreamUrl, auth.apiKey);
}

// ---------------------------------------------------------------------------
// Upstream forwarding (shared by both modes — direct mode only)
// ---------------------------------------------------------------------------

async function forwardToUpstream(
  body: ChatRequest,
  upstreamUrl: string,
  apiKey: string,
): Promise<Response> {
  const isStreaming = body.stream === true;

  // Build the outgoing request body — strip internal-only fields
  const upstreamBody: Record<string, unknown> = {
    model: body.model,
    messages: body.messages,
    stream: isStreaming,
  };

  if (body.max_tokens !== undefined) upstreamBody.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) upstreamBody.temperature = body.temperature;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
  };

  // --- Non-streaming ---------------------------------------------------------
  if (!isStreaming) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      const upstreamResponse = await fetch(upstreamUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(upstreamBody),
        signal: controller.signal,
      });

      if (!upstreamResponse.ok) {
        const errorBody = await upstreamResponse.text();
        return errorJson(502, {
          code: 'UPSTREAM_ERROR',
          message: `Upstream returned ${upstreamResponse.status}`,
          upstream_status: upstreamResponse.status,
          upstream_body: errorBody,
        });
      }

      const data = await upstreamResponse.json();
      return json(data);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return errorJson(504, {
          code: 'UPSTREAM_TIMEOUT',
          message: 'Upstream provider did not respond in time',
        });
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  // --- Streaming (SSE) -------------------------------------------------------
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(upstreamBody),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof DOMException && err.name === 'AbortError') {
      return errorJson(504, {
        code: 'UPSTREAM_TIMEOUT',
        message: 'Upstream provider did not respond in time',
      });
    }
    return errorJson(502, {
      code: 'UPSTREAM_UNREACHABLE',
      message: err instanceof Error ? err.message : 'Failed to reach upstream provider',
    });
  }

  clearTimeout(timeout);

  if (!upstreamResponse.ok) {
    const errorBody = await upstreamResponse.text();
    return errorJson(502, {
      code: 'UPSTREAM_ERROR',
      message: `Upstream returned ${upstreamResponse.status}`,
      upstream_status: upstreamResponse.status,
      upstream_body: errorBody,
    });
  }

  // Pipe the upstream body as an SSE stream
  const upstreamBodyStream = upstreamResponse.body;
  if (!upstreamBodyStream) {
    return errorJson(502, {
      code: 'UPSTREAM_NO_BODY',
      message: 'Upstream returned no body',
    });
  }

  return sseStream(upstreamBodyStream);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a JSON error response with a custom status code. */
export function errorJson(status: number, data: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ error: data }), {
    status,
    headers: JSON_HEADER,
  });
}

/**
 * Build the upstream API URL for an OpenAI-compatible provider.
 * Supports endpoints ending in /v1 or full /v1/chat/completions paths.
 */
export function buildUpstreamUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  if (normalized.includes('/chat/completions')) return normalized;
  if (normalized.endsWith('/v1')) return `${normalized}/chat/completions`;
  return `${normalized}/v1/chat/completions`;
}

/**
 * Rough CU estimation based on message content length.
 * ~4 chars/token for mixed English text; 1000 tokens ≈ 1 CU.
 */
export function estimateCu(body: ChatRequest): number {
  let charCount = 0;
  for (const msg of body.messages ?? []) {
    charCount += msg.content.length;
  }
  const tokens = Math.max(1, Math.ceil(charCount / 4));
  return Math.max(1, Math.ceil(tokens / 1000));
}
