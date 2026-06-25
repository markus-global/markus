/**
 * JWT verification for Cloudflare Worker using jose.
 *
 * The Hub signs tokens with a shared secret (PROXY_JWT_SECRET).
 * This module verifies them and returns the decoded payload,
 * or null if the token is invalid/expired/tampered.
 */

import { jwtVerify } from 'jose';

// ---------------------------------------------------------------------------
// Types — must match the Hub's proxy-auth.ts payload
// ---------------------------------------------------------------------------

export interface ProxyTokenPayload {
  /** User ID (sub). */
  sub: string;
  /** Plan type: "free", "starter", "pro". */
  plan_type: string;
  /** Monthly CU quota (cap on CU per billing cycle). */
  monthly_quota_cu: number;
  /** CU used so far this cycle. */
  cu_used: number;
  /** Issued-at timestamp (seconds). */
  iat: number;
  /** Expiry timestamp (seconds). */
  exp: number;
  /** Additional fields (forward-compat). */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Verify a proxy JWT and return the decoded payload.
 * Returns null for any invalid/expired/tampered token.
 */
export async function verifyProxyToken(token: string, secret: string): Promise<ProxyTokenPayload | null> {
  if (!token || !secret) return null;

  try {
    const secretBytes = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(token, secretBytes, {
      algorithms: ['HS256'],
    });
    return payload as unknown as ProxyTokenPayload;
  } catch {
    return null;
  }
}
