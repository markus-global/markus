import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestServer, request, type TestContext } from './api-server-test-helpers.js';

/**
 * Regression: the Hub sign-in handshake must work *before* a local session exists.
 *
 * The renderer finishes a Hub login by polling the connect session status — the
 * only channel that carries the finished Hub token back into the page — and it
 * does so from the login screen, i.e. by definition without a session cookie.
 *
 * `ba26c98c` (2026-11-09, "gate the API by role") put a deny-by-default gate in
 * front of every `/api` route with only /auth, /health, /gateway and /license
 * public. The handshake was living at `/api/hub/auth/connect-status`, under a
 * prefix whose meaning is "authenticated Hub data proxy" — so first-time sign-in
 * started answering 401 forever: the Hub popup said "signed in", the page never
 * learned about it, and no error surfaced (the client treats the timeout as a
 * user cancellation). The fix moved the handshake to the `/api/auth` prefix,
 * where pre-session endpoints belong.
 *
 * These assert the *contract*, not the file layout:
 *  1. the handshake answers anonymously (it is how you get a session);
 *  2. the Hub data proxy stays closed to anonymous callers (the hole must not
 *     widen — that proxy attaches the locally stored Hub token by default);
 *  3. an anonymous handshake never borrows that stored token.
 */

const TEST_JWT_SECRET = 'test-jwt-secret-hub-connect-status-0123456789';

const mockFetch = vi.fn();

function hubOk(body: unknown) {
  return {
    status: 200,
    ok: true,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  } as never;
}

describe('Hub connect handshake is reachable before a session exists', () => {
  let ctx: TestContext;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    vi.stubEnv('JWT_SECRET', TEST_JWT_SECRET);
    vi.stubEnv('AUTH_ENABLED', 'true');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockFetch.mockResolvedValue(hubOk({ ready: true, token: 'hub-token', user: { id: 'hub-1', username: 'one' } }));
    ctx = createTestServer();
  });

  afterEach(() => {
    ctx?.taskService?.stopTimeoutChecker();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('answers 200 anonymously and returns the Hub payload', async () => {
    const res = await request(ctx.server, 'GET', '/api/auth/hub-connect-status?session=cs_1_test');

    expect(res.status).toBe(200);
    expect(res.json.ready).toBe(true);
    expect(res.json.token).toBe('hub-token');
  });

  it('forwards the session id to the Hub connect-status endpoint', async () => {
    await request(ctx.server, 'GET', '/api/auth/hub-connect-status?session=cs_1_test');

    expect(mockFetch).toHaveBeenCalled();
    const calls = mockFetch.mock.calls.map((c) => String(c[0]));
    expect(calls.some((url) => url.includes('/api/auth/connect-status') && url.includes('session=cs_1_test'))).toBe(true);
  });

  it('never borrows the locally stored Hub token for an anonymous handshake', async () => {
    // A token stored by another (signed-in) user of this machine must not ride
    // along on a request the caller made without any credential of their own.
    ctx.storage.userRepo.setHubToken('user-1', 'stored-hub-token');

    await request(ctx.server, 'GET', '/api/auth/hub-connect-status?session=cs_1_test');

    for (const call of mockFetch.mock.calls) {
      const headers = (call[1] as { headers?: Record<string, string> } | undefined)?.headers ?? {};
      expect(JSON.stringify(headers)).not.toContain('stored-hub-token');
    }
  });

  it('keeps the Hub data proxy closed to anonymous callers', async () => {
    const res = await request(ctx.server, 'GET', '/api/hub/items?limit=1');

    expect(res.status).toBe(401);
    expect(res.json.code).toBe('AUTH_REQUIRED');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('answers only GET on the handshake path — no write side, no Hub call', async () => {
    const res = await request(ctx.server, 'POST', '/api/auth/hub-connect-status?session=cs_1_test');

    // The /api/auth prefix is public for every method, so an unhandled method
    // must fall through to "not found" rather than reach the proxy.
    expect(res.status).toBe(404);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
