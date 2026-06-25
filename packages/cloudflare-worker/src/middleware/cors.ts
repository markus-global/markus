/**
 * CORS middleware — handles preflight OPTIONS requests and adds
 * cross-origin headers to every response.
 */

/** Origin allowed for CORS (set via secret / env var). */
const DEFAULT_ALLOWED_ORIGIN = '*';

/** Headers exposed to the browser client. */
const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': DEFAULT_ALLOWED_ORIGIN,
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers':
    'Content-Type, Authorization, X-Subscription-Key, X-Request-Id',
  'access-control-max-age': '86400',
};

/**
 * Handle CORS preflight and decorate every response with CORS headers.
 *
 * Returns a Response immediately for OPTIONS requests; otherwise returns
 * `null` (pass-through) and relies on a `transform` helper to add headers.
 */
export function handleCors(request: Request): Response | null {
  // ----- Preflight -------------------------------------------------------
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS,
    });
  }

  return null; // passthrough — headers added via transformResponse
}

/** Decorate an existing Response with CORS headers. */
export function transformResponse(response: Response): Response {
  // Avoid mutating the original headers object.
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    if (!headers.has(key)) {
      headers.set(key, value);
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
