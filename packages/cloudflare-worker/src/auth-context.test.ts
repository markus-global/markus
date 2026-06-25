/**
 * Tests for auth-context — request-level auth state via WeakMap.
 */

import { describe, it, expect } from 'vitest';
import { setAuthContext, getAuthContext } from './auth-context.js';

describe('auth-context', () => {
  it('should store and retrieve a proxy auth context', () => {
    const req = new Request('http://localhost/chat');
    const auth = {
      mode: 'proxy' as const,
      payload: {
        sub: 'user_abc',
        plan_type: 'pro',
        monthly_quota_cu: 100_000,
        cu_used: 5_000,
        iat: 1_700_000_000,
        exp: 1_700_000_000 + 3600,
      },
    };
    setAuthContext(req, auth);
    const retrieved = getAuthContext(req);
    expect(retrieved).toEqual(auth);
  });

  it('should store and retrieve a direct auth context', () => {
    const req = new Request('http://localhost/chat');
    const auth = {
      mode: 'direct' as const,
      apiKey: 'sk-test-key-12345',
    };
    setAuthContext(req, auth);
    const retrieved = getAuthContext(req);
    expect(retrieved).toEqual(auth);
  });

  it('should return undefined for a request with no auth context', () => {
    const req = new Request('http://localhost/chat');
    const retrieved = getAuthContext(req);
    expect(retrieved).toBeUndefined();
  });

  it('should handle multiple requests independently', () => {
    // Proxy auth
    const req1 = new Request('http://localhost/chat');
    setAuthContext(req1, {
      mode: 'proxy',
      payload: {
        sub: 'u1', plan_type: 'free', monthly_quota_cu: 1000, cu_used: 100,
        iat: 1_700_000_000, exp: 1_700_003_600,
      },
    });

    // Direct auth
    const req2 = new Request('http://localhost/chat');
    setAuthContext(req2, {
      mode: 'direct',
      apiKey: 'sk-other-key',
    });

    // Non-authed
    const req3 = new Request('http://localhost/chat');

    expect(getAuthContext(req1)?.mode).toBe('proxy');
    expect(getAuthContext(req2)?.mode).toBe('direct');
    expect(getAuthContext(req3)).toBeUndefined();
  });
});
