/**
 * Standard error types for the Markus proxy.
 *
 * All errors use the format:
 *   { error: { code: string, message: string, type: string } }
 */

/** URI-encoded error message for safe transport in response bodies. */
export interface ProxyError {
  code: string;
  message: string;
  type: string;
}

export interface ErrorResponse {
  error: ProxyError;
}

// ---------------------------------------------------------------------------
// Pre-defined error helpers
// ---------------------------------------------------------------------------

/** 400 — Bad request (malformed payload, missing fields, etc.). */
export function badRequest(detail?: string): ErrorResponse {
  return {
    error: {
      code: 'BAD_REQUEST',
      message: detail ?? 'The request was malformed or missing required fields',
      type: 'validation_error',
    },
  };
}

/** 401 — No valid subscription key provided. */
export function unauthorized(detail?: string): ErrorResponse {
  return {
    error: {
      code: 'UNAUTHORIZED',
      message: detail ?? 'Missing or invalid subscription key',
      type: 'auth_error',
    },
  };
}

/** 403 — Key is valid but lacks quota / is expired / etc. */
export function forbidden(detail?: string): ErrorResponse {
  return {
    error: {
      code: 'FORBIDDEN',
      message: detail ?? 'Subscription key has no remaining quota',
      type: 'quota_error',
    },
  };
}

/** 404 — Route not found. */
export function notFound(path: string): ErrorResponse {
  return {
    error: {
      code: 'NOT_FOUND',
      message: `Route not found: ${path}`,
      type: 'not_found_error',
    },
  };
}

/** 429 — Rate limited. */
export function rateLimited(retryAfterMs?: number): ErrorResponse {
  return {
    error: {
      code: 'RATE_LIMITED',
      message: retryAfterMs
        ? `Too many requests. Retry after ${retryAfterMs}ms`
        : 'Too many requests. Please slow down',
      type: 'rate_limit_error',
    },
  };
}

/** 504 — Upstream LLM provider did not respond in time. */
export function gatewayTimeout(upstream?: string): ErrorResponse {
  return {
    error: {
      code: 'GATEWAY_TIMEOUT',
      message: upstream
        ? `Upstream provider "${upstream}" timed out`
        : 'Upstream provider timed out',
      type: 'proxy_error',
    },
  };
}

/** 500 — Unexpected internal error (catch-all). */
export function internalError(detail?: string): ErrorResponse {
  return {
    error: {
      code: 'INTERNAL_ERROR',
      message: detail ?? 'An unexpected error occurred',
      type: 'internal_error',
    },
  };
}

/** 502 — Upstream returned a bad response. */
export function badGateway(upstream?: string): ErrorResponse {
  return {
    error: {
      code: 'BAD_GATEWAY',
      message: upstream
        ? `Upstream provider "${upstream}" returned an invalid response`
        : 'Upstream provider returned an invalid response',
      type: 'proxy_error',
    },
  };
}
