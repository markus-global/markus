/**
 * Cold-start readiness for the Markus Hub model catalog.
 *
 * Covers the contract added to LLMRouter around `ensureMarkusCatalogLoaded()`:
 * single-flight de-duplication of the Hub fetch, an O(1) fast path once the
 * catalog is ready, fallback (never throw) for the SYNCHRONOUS context-window
 * lookups before/without a catalog, user-config priority, and last-good /
 * loaded-flag semantics on a transient empty Hub response.
 *
 * NOTE: `cachedModelList` / `modelListExpiry` in markus-provider.ts are
 * MODULE-LEVEL caches, so they are reset in beforeEach. Each test also builds a
 * FRESH LLMRouter (the in-flight + loaded flags are per-instance).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LLMRouter } from '../src/llm/router.js';
import { MarkusProvider, clearMarkusModelListCache } from '../src/llm/markus-provider.js';
import type { MarkusModelInfo } from '../src/llm/markus-provider.js';

const FALLBACK_CONTEXT_WINDOW = 1_000_000; // DEFAULT_CONTEXT_WINDOW_FALLBACK
const PROVIDER_MODEL = 'deepseek/deepseek-v4-flash';
const HUB_CONTEXT_WINDOW = 200_000;

/** Minimal Hub model row (shape of MarkusModelInfo as served by /models/live). */
function hubModel(id: string, over: Partial<MarkusModelInfo> = {}): MarkusModelInfo {
  return {
    id,
    display_name: id,
    capability: 'text',
    tier: 'pro',
    context_window: HUB_CONTEXT_WINDOW,
    max_output_tokens: 8_192,
    supports_vision: false,
    supports_reasoning: false,
    route: 'openrouter',
    ...over,
  };
}

/** A promise whose settlement is controlled by the test (gates the Hub fetch). */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Build a router with a REAL MarkusProvider whose `fetchModels` is stubbed.
 * The provider must stay a real instance: `loadMarkusCatalog` gates on
 * `provider instanceof MarkusProvider`.
 */
function makeRouter(fetchImpl: () => Promise<MarkusModelInfo[]>) {
  const provider = new MarkusProvider({
    provider: 'markus',
    model: PROVIDER_MODEL,
    apiKey: 'sk-or-test',
    baseUrl: 'https://openrouter.ai/api/v1',
    modelsUrl: 'http://hub.test/api/models/live/markus',
  });
  const fetchSpy = vi.spyOn(provider, 'fetchModels').mockImplementation(fetchImpl);
  const router = new LLMRouter('markus');
  router.registerProvider('markus', provider);
  return { router, provider, fetchSpy };
}

/** Read the (private) per-provider custom catalog for last-good assertions. */
function catalogIds(router: LLMRouter, provider: string): string[] {
  const map = (router as unknown as {
    customModelCatalog: Map<string, Array<{ id: string }>>;
  }).customModelCatalog;
  return (map.get(provider) ?? []).map(m => m.id);
}

beforeEach(() => {
  clearMarkusModelListCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ensureMarkusCatalogLoaded — single-flight', () => {
  it('de-duplicates concurrent callers: 3× ensure + 1× refresh hit the Hub fetch ONCE', async () => {
    const gate = deferred<MarkusModelInfo[]>();
    const { router, fetchSpy } = makeRouter(() => gate.promise);

    const pending = [
      router.ensureMarkusCatalogLoaded(),
      router.ensureMarkusCatalogLoaded(),
      router.ensureMarkusCatalogLoaded(),
      router.refreshMarkusCatalog(),
    ];

    // All four callers are in flight, yet only one Hub round-trip started.
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    gate.resolve([hubModel(PROVIDER_MODEL)]);
    await expect(Promise.all(pending)).resolves.toBeDefined();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('ensureMarkusCatalogLoaded — ready fast path', () => {
  it('does not touch the Hub again once the catalog is loaded', async () => {
    const { router, fetchSpy } = makeRouter(async () => [hubModel(PROVIDER_MODEL)]);

    await router.ensureMarkusCatalogLoaded();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await router.ensureMarkusCatalogLoaded();
    await router.ensureMarkusCatalogLoaded();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('getModelContextWindow — pre-load fallback', () => {
  it('returns the fallback without throwing before load, real Hub value after', async () => {
    const { router } = makeRouter(async () => [hubModel(PROVIDER_MODEL)]);

    expect(router.isMarkusCatalogLoaded()).toBe(false);
    expect(() => router.getModelContextWindow('markus')).not.toThrow();
    expect(router.getModelContextWindow('markus')).toBe(FALLBACK_CONTEXT_WINDOW);

    await router.ensureMarkusCatalogLoaded();

    expect(router.isMarkusCatalogLoaded()).toBe(true);
    expect(router.getModelContextWindow('markus')).toBe(HUB_CONTEXT_WINDOW);
  });
});

describe('getModelContextWindow — user config priority', () => {
  it('user custom model config wins over the Hub catalog value', async () => {
    const { router } = makeRouter(async () => [hubModel(PROVIDER_MODEL)]);

    router.updateProviderModelConfig('markus', { contextWindow: 64_000 });
    await router.ensureMarkusCatalogLoaded();

    expect(router.getModelContextWindow('markus')).toBe(64_000);
  });
});

describe('ensureMarkusCatalogLoaded — failure safety', () => {
  it('resolves (never rejects) when the Hub fetch rejects, and the window falls back', async () => {
    const { router, fetchSpy } = makeRouter(async () => {
      throw new Error('hub down');
    });

    await expect(router.ensureMarkusCatalogLoaded()).resolves.toBeUndefined();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(router.isMarkusCatalogLoaded()).toBe(false);
    expect(router.getModelContextWindow('markus')).toBe(FALLBACK_CONTEXT_WINDOW);
  });

  it('resolves (never rejects) on timeout when the fetch never settles', async () => {
    const gate = deferred<MarkusModelInfo[]>(); // never resolved
    const { router } = makeRouter(() => gate.promise);

    await expect(
      router.ensureMarkusCatalogLoaded({ timeoutMs: 30 }),
    ).resolves.toBeUndefined();

    expect(router.isMarkusCatalogLoaded()).toBe(false);
    expect(router.getModelContextWindow('markus')).toBe(FALLBACK_CONTEXT_WINDOW);
  });
});

describe('empty Hub catalog does not clobber last-good', () => {
  it('keeps the previously loaded catalog when the Hub returns []', async () => {
    let impl: () => Promise<MarkusModelInfo[]> = async () => [hubModel(PROVIDER_MODEL)];
    const { router, fetchSpy } = makeRouter(() => impl());

    await router.ensureMarkusCatalogLoaded();
    expect(catalogIds(router, 'markus')).toEqual([PROVIDER_MODEL]);
    expect(router.getModelContextWindow('markus')).toBe(HUB_CONTEXT_WINDOW);

    // Second refresh comes back empty — must NOT wipe the last-good catalog.
    impl = async () => [];
    await router.ensureMarkusCatalogLoaded({ force: true });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(catalogIds(router, 'markus')).toEqual([PROVIDER_MODEL]);
    expect(router.getModelContextWindow('markus')).toBe(HUB_CONTEXT_WINDOW);
  });
});

describe('isMarkusCatalogLoaded semantics', () => {
  it('flips false→true only after a NON-empty load; an empty load never flips it', async () => {
    const nonEmpty = makeRouter(async () => [hubModel(PROVIDER_MODEL)]);
    expect(nonEmpty.router.isMarkusCatalogLoaded()).toBe(false);
    await nonEmpty.router.refreshMarkusCatalog();
    expect(nonEmpty.router.isMarkusCatalogLoaded()).toBe(true);

    const empty = makeRouter(async () => []);
    expect(empty.router.isMarkusCatalogLoaded()).toBe(false);
    await empty.router.refreshMarkusCatalog();
    expect(empty.router.isMarkusCatalogLoaded()).toBe(false);
  });
});
