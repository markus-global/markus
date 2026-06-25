/**
 * Standard HTTP response helpers for the Markus proxy.
 *
 * Every JSON response includes CORS headers so the caller does not have to
 * repeat them.  The CORS middleware ensures OPTIONS preflights are handled
 * before any of these helpers are called.
 */

import type { ErrorResponse } from './errors.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const JSON_HEADER: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
};

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/** 200 OK — standard success response. */
export function json(data: unknown, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { ...JSON_HEADER, ...extraHeaders },
  });
}

/** 200 OK — SSE stream response (streaming proxy). */
export function sseStream(
  readable: ReadableStream,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(readable, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...extraHeaders,
    },
  });
}

// ---------------------------------------------------------------------------
// Error response helpers
// ---------------------------------------------------------------------------

function errorResponse(status: number, body: ErrorResponse, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADER, ...extraHeaders },
  });
}

/** 400 Bad Request. */
export function badRequest(body: ErrorResponse): Response {
  return errorResponse(400, body);
}

/** 401 Unauthorized. */
export function unauthorized(body: ErrorResponse): Response {
  return errorResponse(401, body);
}

/** 403 Forbidden. */
export function forbidden(body: ErrorResponse): Response {
  return errorResponse(403, body);
}

/** 404 Not Found. */
export function notFound(body: ErrorResponse): Response {
  return errorResponse(404, body);
}

/** 429 Too Many Requests. */
export function tooManyRequests(body: ErrorResponse, retryAfterSec?: number): Response {
  const headers: Record<string, string> = {};
  if (retryAfterSec !== undefined) {
    headers['retry-after'] = String(retryAfterSec);
  }
  return errorResponse(429, body, headers);
}

/** 502 Bad Gateway. */
export function badGateway(body: ErrorResponse): Response {
  return errorResponse(502, body);
}

/** 504 Gateway Timeout. */
export function gatewayTimeout(body: ErrorResponse): Response {
  return errorResponse(504, body);
}

/** 500 Internal Server Error (catch-all). */
export function internalError(body: ErrorResponse): Response {
  return errorResponse(500, body);
}
