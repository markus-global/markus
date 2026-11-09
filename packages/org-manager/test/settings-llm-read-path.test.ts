import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestServer, request } from './api-server-test-helpers.js';

/**
 * `GET /api/settings/llm` is a READ, and three hot surfaces read it: the
 * Settings page (as soon as a tab opens), the composer model menu (on mount
 * AND on every open), and the boot config check.
 *
 * It used to do the opposite — a forced Hub credential sync, a catalog refresh
 * and an Ollama probe on *every* call. The "is this key legacy?" probe read the
 * raw on-disk `markus.apiKey`, which is `null` for every correctly-migrated
 * install (the key lives in ~/.markus/.env), so the sync re-ran forever.
 * Measured on a real install: 0.6 s warm / 3.9 s cold per request.
 *
 * These tests pin the contract with behaviour, not source text: a never-settling
 * network call on the read path makes the request hang, so a passing assertion
 * here proves the request does not await it. Renaming a method cannot make these
 * silently green (the old code fails them by timing out).
 */

/** A promise that never settles — stands in for an unreachable Hub / dead Ollama. */
const NEVER = new Promise<never>(() => { /* intentionally never resolves */ });

describe('GET /api/settings/llm is a pure read (no network on the request path)', () => {
  let server: ReturnType<typeof createTestServer>['server'];

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env['AUTH_ENABLED'] = 'false';
    ({ server } = createTestServer());
    server.setLLMRouter({
      getEnhancedSettings: () => ({
        defaultProvider: 'openai',
        providers: {
          openai: { name: 'openai', displayName: 'OpenAI', model: 'gpt-4o', configured: true, enabled: true, models: [] },
          markus: { name: 'markus', displayName: 'Markus', model: '', configured: false, enabled: false, models: [] },
        },
      }),
      getProvider: () => ({ model: '' }),
      refreshMarkusCatalog: vi.fn(async () => 0),
      refreshOllamaLocalModels: vi.fn(async () => 0),
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['AUTH_ENABLED'];
  });

  it('answers while a Hub credential sync is still pending', async () => {
    // The regression: the handler awaited this. If it awaits again, the request
    // never settles and the assertion below times out — red, as it should be.
    vi.spyOn(server, 'syncOpenRouterCredentialsFromHub').mockReturnValue(NEVER as never);

    const res = await request(server, 'GET', '/api/settings/llm');
    expect(res.status).toBe(200);
    expect((res.json as { providers?: Record<string, unknown> }).providers).toBeTruthy();
  });

  it('answers while an Ollama probe is still pending', async () => {
    // Probing every local model via /api/show is seconds of work when the
    // daemon is slow or unhealthy. It must never gate a settings read.
    const router = {
      getEnhancedSettings: () => ({
        defaultProvider: 'openai',
        providers: { openai: { name: 'openai', model: 'gpt-4o', configured: true, enabled: true, models: [] } },
      }),
      getProvider: () => ({ model: '' }),
      refreshMarkusCatalog: vi.fn(async () => 0),
      refreshOllamaLocalModels: vi.fn(() => NEVER as never),
    };
    server.setLLMRouter(router as never);

    const res = await request(server, 'GET', '/api/settings/llm');
    expect(res.status).toBe(200);
  });

  it('serves repeated reads without re-entering the credential sync', async () => {
    const sync = vi.spyOn(server, 'syncOpenRouterCredentialsFromHub').mockResolvedValue({ ok: false, error: 'offline' });

    for (let i = 0; i < 5; i += 1) {
      const res = await request(server, 'GET', '/api/settings/llm');
      expect(res.status).toBe(200);
    }
    // Background refresh is single-flight + TTL'd: five reads must not become
    // five Hub round-trips. (It may fire once, on the first read.)
    expect(sync.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('does not start a second background refresh while one is in flight', async () => {
    const sync = vi.spyOn(server, 'syncOpenRouterCredentialsFromHub').mockReturnValue(NEVER as never);

    // First read starts the (never-settling) background flight.
    await request(server, 'GET', '/api/settings/llm');
    const afterFirst = sync.mock.calls.length;

    for (let i = 0; i < 4; i += 1) {
      const res = await request(server, 'GET', '/api/settings/llm');
      expect(res.status).toBe(200);
    }
    // Joining is the point: N readers, ONE flight.
    expect(sync.mock.calls.length).toBe(afterFirst);
  });
});
