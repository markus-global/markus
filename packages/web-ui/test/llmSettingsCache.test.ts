import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  fetchLlmSettings,
  invalidateLlmSettings,
  __resetLlmSettingsCacheForTests,
  LLM_SETTINGS_TTL_MS,
} from '../src/lib/llmSettingsCache.ts';

/**
 * The composer's model menu loads on mount AND on every open; the Settings page
 * and the boot config check read the same document. Without a shared read they
 * paid for it three or four times per interaction.
 *
 * Two guarantees must both hold, and they fail differently:
 *   - the TTL cache fixes the SERIAL case (open, close, open);
 *   - in-flight dedupe fixes the PARALLEL one (several components mounting in
 *     the same tick, before any cache entry exists).
 * A cache alone leaves the parallel case untouched, so both are asserted.
 */

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as unknown as Response;
}

describe('llmSettingsCache', () => {
  beforeEach(() => {
    __resetLlmSettingsCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('serves a second read from the snapshot instead of re-fetching', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ defaultProvider: 'openai', providers: {} }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchLlmSettings();
    await fetchLlmSettings();
    await fetchLlmSettings();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('joins concurrent reads into ONE request (parallel mounts in the same tick)', async () => {
    let release!: (r: Response) => void;
    const pending = new Promise<Response>(res => { release = res; });
    const fetchMock = vi.fn(() => pending);
    vi.stubGlobal('fetch', fetchMock);

    const readers = [
      fetchLlmSettings(),
      fetchLlmSettings(),
      fetchLlmSettings(),
    ];
    expect(fetchMock).toHaveBeenCalledTimes(1);

    release(jsonResponse({ defaultProvider: 'openai', providers: {} }));
    const results = await Promise.all(readers);
    // Every caller gets the payload — none is left hanging.
    results.forEach(r => expect(r.defaultProvider).toBe('openai'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-reads after invalidate (the menu wrote routing, its snapshot is stale)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ defaultProvider: 'openai', providers: {} }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchLlmSettings();
    invalidateLlmSettings();
    await fetchLlmSettings();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('force bypasses the snapshot even while it is fresh', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ defaultProvider: 'openai', providers: {} }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchLlmSettings();
    await fetchLlmSettings({ force: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('re-reads once the TTL has elapsed', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => jsonResponse({ defaultProvider: 'openai', providers: {} }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchLlmSettings();
    vi.advanceTimersByTime(LLM_SETTINGS_TTL_MS + 1);
    await fetchLlmSettings();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a failed read is not cached — the next open retries instead of showing an empty menu', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'boom' }, false));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchLlmSettings()).rejects.toThrow(/HTTP 500/);

    // Second attempt must hit the network again, not serve the failure.
    fetchMock.mockImplementationOnce(async () => jsonResponse({ defaultProvider: 'openai', providers: {} }));
    const ok = await fetchLlmSettings();
    expect(ok.defaultProvider).toBe('openai');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
