import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { signToken } from '../src/middleware/auth.js';
import { createTestServer, request, type TestContext } from './api-server-test-helpers.js';

/**
 * Regression: local session lifetime.
 *
 * Before this, the session was a hard 7-day token with NO renewal: a desktop app
 * left open for days kept looking signed in while every write 401'd, nothing was
 * persisted, and the renderer reported it as a model-credential failure.
 *
 * Two behaviours are load-bearing and both are asserted here:
 *   1. a stale-but-valid token is transparently re-issued (sliding window),
 *      so an app that is actually being used never expires;
 *   2. an expired token answers 401 **with `code: AUTH_REQUIRED`**, the
 *      machine-readable half the UI needs to say "sign in again" instead of
 *      "your model API key is broken".
 */

const TEST_JWT_SECRET = 'test-session-lifetime-secret-not-a-placeholder';

const nowSec = () => Math.floor(Date.now() / 1000);

describe('local session lifetime', () => {
  let ctx: TestContext;

  beforeEach(() => {
    vi.stubEnv('JWT_SECRET', TEST_JWT_SECRET);
    vi.stubEnv('AUTH_ENABLED', 'true');
    ctx = createTestServer();
  });

  afterEach(() => {
    ctx?.taskService?.stopTimeoutChecker();
    vi.unstubAllEnvs();
  });

  const tokenWithExp = (exp: number) => signToken(
    { userId: 'user-1', orgId: 'default', role: 'owner', exp },
    TEST_JWT_SECRET,
  );

  it('re-issues the cookie for a token that has been alive longer than a day', async () => {
    // Issued "2 days ago" under the 30-day lifetime → stale enough to renew.
    const cookie = `markus_token=${await tokenWithExp(nowSec() + 28 * 24 * 3600)}`;
    const res = await request(ctx.server, 'GET', '/api/auth/me', undefined, { cookie });

    expect(res.status).toBe(200);
    const setCookie = String(res.headers['Set-Cookie'] ?? '');
    expect(setCookie).toContain('markus_token=');
    expect(setCookie).toContain('HttpOnly');

    // The new token must outlive the old one — that is what "renewed" means.
    const renewed = setCookie.split('markus_token=')[1]!.split(';')[0]!;
    const payload = JSON.parse(atob(renewed.split('.')[1]!)) as { exp: number };
    expect(payload.exp).toBeGreaterThan(nowSec() + 29 * 24 * 3600);
  });

  it('does not rewrite a fresh cookie on every request', async () => {
    const cookie = `markus_token=${await tokenWithExp(nowSec() + 29.5 * 24 * 3600)}`;
    const res = await request(ctx.server, 'GET', '/api/auth/me', undefined, { cookie });

    expect(res.status).toBe(200);
    expect(res.headers['Set-Cookie']).toBeUndefined();
  });

  it('answers an expired session with 401 + code AUTH_REQUIRED (not a model-key error)', async () => {
    const cookie = `markus_token=${await tokenWithExp(nowSec() - 60)}`;
    const res = await request(ctx.server, 'GET', '/api/tasks', undefined, { cookie });

    expect(res.status).toBe(401);
    expect(res.json.code).toBe('AUTH_REQUIRED');
  });
});
