/**
 * Auth context — attached to every proxied request after authentication.
 *
 * Two authentication modes are supported:
 *
 * 1. **Proxy JWT** (`Authorization: Bearer <jwt>`)
 *    — The caller is using the platform's billing proxy.
 *      The JWT contains their plan, quota, and usage so that the Worker
 *      can make forwarding decisions without a round-trip to the Hub.
 *
 * 2. **Self-provided Key** (`x-api-key: <key>`)
 *    — The caller has their own LLM API key and wants to use the proxy
 *      purely as a network gateway.  No quota is enforced.
 */

import type { ProxyTokenPayload } from './jwt-verify.js';

// ---------------------------------------------------------------------------
// Auth mode
// ---------------------------------------------------------------------------

export type AuthMode = 'proxy' | 'direct';

// ---------------------------------------------------------------------------
// Auth context
// ---------------------------------------------------------------------------

export interface ProxyAuth {
  mode: 'proxy';
  /** Decoded proxy JWT payload. */
  payload: ProxyTokenPayload;
}

export interface DirectAuth {
  mode: 'direct';
  /** The API key the caller provided. */
  apiKey: string;
}

export type AuthContext = ProxyAuth | DirectAuth;

// ---------------------------------------------------------------------------
// Request-scoped storage (via a well-known Symbol)
// ---------------------------------------------------------------------------

const AUTH_SYMBOL = Symbol.for('markus.auth.context');

/** Attach the auth context to a CF Worker request. */
export function setAuthContext(request: Request, ctx: AuthContext): void {
  (request as unknown as Record<symbol, AuthContext>)[AUTH_SYMBOL] = ctx;
}

/** Retrieve the auth context previously attached. */
export function getAuthContext(request: Request): AuthContext | undefined {
  return (request as unknown as Record<symbol, AuthContext | undefined>)[AUTH_SYMBOL];
}
