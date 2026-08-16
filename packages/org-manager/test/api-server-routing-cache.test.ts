import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { APIServer } from '../src/api-server.js';
import { createTestServer, request } from './api-server-test-helpers.js';

/**
 * Tests for the Settings → Model Routing "options empty then filled" fix:
 *  - buildRoutingCandidatesPayload(): parallel live validation, markus skipped,
 *    preserve configured → live → catalog ordering.
 *  - warmRoutingCandidates(): background warm-up fills the cache so the first
 *    settings visit hits a pre-built payload (no 2s empty dropdown).
 */

type Enhanced = {
  name: string;
  displayName?: string;
  model: string;
  configured: boolean;
  enabled: boolean;
  models?: Array<{ id: string; name: string; tier?: string; capabilities?: string[]; inputTypes?: string[] }>;
};

function makeRouterMock(providers: Enhanced[], opts: { apiKeys?: Record<string, string> } = {}) {
  const apiKeys = opts.apiKeys ?? {};
  const providerMap: Record<string, { apiKey?: string; baseUrl?: string; model: string }> = {};
  for (const p of providers) {
    providerMap[p.name] = { apiKey: apiKeys[p.name], model: p.model };
  }
  return {
    getEnhancedSettings: vi.fn(() => ({
      defaultProvider: 'openai',
      providers: Object.fromEntries(
        providers.map(p => [p.name, { name: p.name, displayName: p.displayName ?? p.name, model: p.model, configured: p.configured, enabled: p.enabled, models: p.models ?? [] }]),
      ),
      autoFallback: true,
      capabilityRouting: { assignments: {} },
    })),
    getProvider: vi.fn((name: string) => providerMap[name] ?? { model: '' }),
    refreshMarkusCatalog: vi.fn(async () => 0),
    getModelCatalog: vi.fn(() => []),
  } as never;
}

describe('api-server routing candidates (warm cache + parallel validation)', () => {
  let server: APIServer;
  let routerMock: ReturnType<typeof makeRouterMock>;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env['AUTH_ENABLED'] = 'false';
    ({ server } = createTestServer());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['AUTH_ENABLED'];
  });

  it('buildRoutingCandidatesPayload skips live validation for markus and validates other providers in parallel', async () => {
    const providers: Enhanced[] = [
      { name: 'markus', model: 'deepseek/deepseek-v4-flash', configured: true, enabled: true, models: [{ id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', tier: 'base' }] },
      { name: 'openai', model: 'gpt-4o', configured: true, enabled: true, models: [{ id: 'gpt-4o', name: 'GPT-4o' }] },
      { name: 'deepseek', model: 'deepseek-v4-flash', configured: true, enabled: true, models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }] },
    ];
    routerMock = makeRouterMock(providers, { apiKeys: { openai: 'sk-openai', deepseek: 'sk-deepseek' } });
    server.setLLMRouter(routerMock);

    // Fake live validation: track which providers were validated and whether the
    // calls overlap (parallel) instead of running serially.
    const started: string[] = [];
    const gates: Array<() => void> = [];
    (server as unknown as { validateProviderKey: (p: string) => Promise<{ valid: boolean; models: unknown[] }> }).validateProviderKey =
      vi.fn((p: string) => new Promise(resolve => {
        started.push(p);
        gates.push(() => resolve({ valid: true, models: [{ id: `${p}-extra`, name: `${p}-extra` }] }));
      }));

    const buildPromise = server.buildRoutingCandidatesPayload();
    // Both non-markus providers must have started before either resolves.
    await new Promise<void>(r => setTimeout(r, 5));
    expect(started.sort()).toEqual(['deepseek', 'openai']);
    expect(started).not.toContain('markus');
    gates.forEach(g => g());
    const payload = await buildPromise;

    const pByProvider = Object.fromEntries(payload.providers.map(p => [p.provider, p]));
    expect(pByProvider['markus'].models.some(m => m.id === 'deepseek/deepseek-v4-flash')).toBe(true);
    expect(pByProvider['markus'].models.some(m => m.id === 'markus-extra')).toBe(false);
    expect(pByProvider['openai'].models.some(m => m.id === 'openai-extra')).toBe(true);
    expect(pByProvider['deepseek'].models.some(m => m.id === 'deepseek-extra')).toBe(true);
  });

  it('warmRoutingCandidates fills the cache so the first GET hits it without live calls', async () => {
    const providers: Enhanced[] = [
      { name: 'markus', displayName: 'Markus Cloud AI', model: 'deepseek/deepseek-v4-flash', configured: true, enabled: true, models: [{ id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', tier: 'base' }] },
      { name: 'openai', model: 'gpt-4o', configured: true, enabled: true, models: [{ id: 'gpt-4o', name: 'GPT-4o' }] },
    ];
    routerMock = makeRouterMock(providers, { apiKeys: { openai: 'sk-openai' } });
    server.setLLMRouter(routerMock);
    let liveCalls = 0;
    (server as unknown as { validateProviderKey: (p: string) => Promise<{ valid: boolean; models: unknown[] }> }).validateProviderKey =
      vi.fn(async () => { liveCalls += 1; return { valid: true, models: [] }; });

    await server.warmRoutingCandidates();
    expect(server.routingCandidatesCache).not.toBeNull();

    const callsAfterWarm = liveCalls;

    const res = await request(server, 'GET', '/api/models/routing-candidates');
    expect(res.status).toBe(200);
    const providersOut = (res.json as { providers?: Array<{ provider: string }> }).providers ?? [];
    const names = providersOut.map(p => p.provider);
    expect(names).toContain('markus');
    expect(names).toContain('openai');
    // Cache hit → no extra live validation calls issued by the request.
    expect(liveCalls).toBe(callsAfterWarm);
  });

  it('warmRoutingCandidates keeps cache cold when no providers are configured', async () => {
    const providers: Enhanced[] = [
      { name: 'openai', model: 'gpt-4o', configured: false, enabled: false, models: [] },
    ];
    routerMock = makeRouterMock(providers);
    server.setLLMRouter(routerMock);
    await server.warmRoutingCandidates();
    expect(server.routingCandidatesCache).toBeNull();
  });

  it('warmRoutingCandidates returns early when cache is still valid', async () => {
    const providers: Enhanced[] = [
      { name: 'anthropic', model: 'claude-sonnet-4', configured: true, enabled: true, models: [{ id: 'claude-sonnet-4', name: 'Claude Sonnet 4' }] },
    ];
    routerMock = makeRouterMock(providers, { apiKeys: { anthropic: 'sk-ant' } });
    server.setLLMRouter(routerMock);
    let liveCalls = 0;
    (server as unknown as { validateProviderKey: (p: string) => Promise<{ valid: boolean; models: unknown[] }> }).validateProviderKey =
      vi.fn(async () => { liveCalls += 1; return { valid: true, models: [] }; });

    await server.warmRoutingCandidates();
    expect(server.routingCandidatesCache).not.toBeNull();
    const callsAfterFirst = liveCalls;

    await server.warmRoutingCandidates();
    expect(liveCalls).toBe(callsAfterFirst);
  });
});