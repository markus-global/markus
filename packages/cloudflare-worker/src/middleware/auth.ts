/**
 * Auth middleware — JWT verification (proxy mode) or API-key passthrough (direct mode).
 *
 * Two authentication modes:
 *
 * 1. **Proxy JWT** (`Authorization: Bearer <jwt>`)
 *    - Verifies the JWT signature using `PROXY_JWT_SECRET`.
 *    - Decodes the payload (user_id, plan_type, cu_used, monthly_quota_cu, etc.).
 *    - The chat handler uses this info to enforce quota and deduct CU tokens.
 *
 * 2. **Self-provided API key** (`x-api-key: <key>`)
 *    - The caller has their own LLM provider key.
 *    - No quota enforcement — the proxy is a pure network gateway.
 *    - The caller must also set `x-provider-base-url` to the upstream endpoint.
 *
 * PUBLIC_ROUTES (/health) skip authentication entirely.
 */

import { unauthorized } from '../utils/errors.js';
import { unauthorized as unauthorizedResponse } from '../utils/response.js';
import { verifyProxyToken } from '../jwt-verify.js';
import { setAuthContext } from '../auth-context.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Routes that do NOT require authentication. */
const PUBLIC_ROUTES = new Set(['/health']);

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

export async function handleAuth(
  request: Request,
  env: Record<string, unknown>,
): Promise<Response | null> {
  const url = new URL(request.url);

  // Public routes skip auth.
  if (PUBLIC_ROUTES.has(url.pathname)) {
    return null;
  }

  // --- Try Proxy JWT mode: Authorization: Bearer <token> --------------------
  const authHeader = request.headers.get('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (!token) {
      return unauthorizedResponse(unauthorized('Empty Bearer token'));
    }

    const secret = env.PROXY_JWT_SECRET;
    if (!secret) {
      return unauthorizedResponse(unauthorized('Proxy JWT secret is not configured'));
    }

    const payload = await verifyProxyToken(token, secret as string);
    if (!payload) {
      return unauthorizedResponse(unauthorized('Invalid or expired proxy token'));
    }

    setAuthContext(request, { mode: 'proxy', payload });
    return null;
  }

  // --- Try Direct mode: x-api-key -------------------------------------------
  const apiKey = request.headers.get('x-api-key');
  if (apiKey) {
    // Need a provider base URL for direct mode
    const providerBaseUrl = request.headers.get('x-provider-base-url');
    if (!providerBaseUrl) {
      return unauthorizedResponse(unauthorized('x-provider-base-url header is required in direct mode'));
    }

    setAuthContext(request, { mode: 'direct', apiKey });
    return null;
  }

  // --- No auth provided -----------------------------------------------------
  return unauthorizedResponse(
    unauthorized('Authentication required. Use Authorization: Bearer <jwt> (proxy) or x-api-key (direct)'),
  );
}
