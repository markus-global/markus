/**
 * Tests for JWT verification (and round-trip via jose SignJWT).
 */

import { describe, it, expect } from 'vitest';
import { SignJWT } from 'jose';
import { verifyProxyToken } from './jwt-verify.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sign a test JWT with the given secret. */
async function signToken(
  payload: Record<string, unknown>,
  secret: string,
  expiresIn = '1h',
): Promise<string> {
  const secretBytes = new TextEncoder().encode(secret);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(expiresIn)
    .setIssuedAt()
    .sign(secretBytes);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const SECRET = 'test-secret-12345';

describe('verifyProxyToken', () => {
  it('should return payload for a valid token', async () => {
    const payload = {
      sub: 'user_abc',
      plan_type: 'pro',
      monthly_quota_cu: 100_000,
      cu_used: 12_345,
    };
    const token = await signToken(payload, SECRET);
    const result = await verifyProxyToken(token, SECRET);

    expect(result).not.toBeNull();
    expect(result!.sub).toBe('user_abc');
    expect(result!.plan_type).toBe('pro');
    expect(result!.monthly_quota_cu).toBe(100_000);
    expect(result!.cu_used).toBe(12_345);
  });

  it('should return null for an expired token', async () => {
    const payload = { sub: 'user_abc', plan_type: 'free', monthly_quota_cu: 1000, cu_used: 0 };
    const token = await signToken(payload, SECRET, '0s'); // expires immediately
    // Small delay to ensure expiry
    await new Promise((r) => setTimeout(r, 50));
    const result = await verifyProxyToken(token, SECRET);
    expect(result).toBeNull();
  });

  it('should return null for a token signed with a different secret', async () => {
    const payload = { sub: 'user_abc', plan_type: 'free', monthly_quota_cu: 1000, cu_used: 0 };
    const token = await signToken(payload, 'different-secret');
    const result = await verifyProxyToken(token, SECRET);
    expect(result).toBeNull();
  });

  it('should return null for a tampered token', async () => {
    const payload = { sub: 'user_abc', plan_type: 'free', monthly_quota_cu: 1000, cu_used: 0 };
    const token = await signToken(payload, SECRET);
    // Tamper with the payload portion
    const parts = token.split('.');
    const tampered = `${parts[0]}.${parts[1]}Z${parts[2]}`;
    const result = await verifyProxyToken(tampered, SECRET);
    expect(result).toBeNull();
  });

  it('should return null for empty token', async () => {
    const result = await verifyProxyToken('', SECRET);
    expect(result).toBeNull();
  });

  it('should return null when verifying with empty secret', async () => {
    const payload = { sub: 'u1', plan_type: 'free', monthly_quota_cu: 1000, cu_used: 0 };
    const token = await signToken(payload, 'valid-secret');
    const result = await verifyProxyToken(token, '');
    expect(result).toBeNull();
  });
});
