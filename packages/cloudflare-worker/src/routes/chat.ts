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
 *   - Deducts CU on success.
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
// Proxy JWT mode
// ---------------------------------------------------------------------------

async function handleProxyChat(
  _request: Request,
  body: ChatRequest,
  auth: { mode: 'proxy'; payload: { monthly_quota_cu: number; cu_used: number; sub: string } },
  env: Record<string, unknown>,
): Promise<Response> {
  const { payload } = auth;

  // --- CU quota check --------------------------------------------------------
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

  // Delegate to the shared forwarder
  const upstreamUrl = buildUpstreamUrl(proxyBaseUrl);
  return forwardToUpstream(body, upstreamUrl, proxyApiKey);
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
// Upstream forwarding (shared by both modes)
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
