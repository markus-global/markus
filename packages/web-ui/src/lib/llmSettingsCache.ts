/**
 * One fetch for `GET /api/settings/llm`, shared by every surface that needs it.
 *
 * Why this exists: the payload is read by three independent places that all
 * mount within seconds of each other — the boot config check (App), the
 * Settings page (the 模型配置 tab), and the composer's model menu (which loads
 * on mount AND re-loads on every open). Each did its own `fetch`, so opening
 * Settings then the model menu paid for the same document three or four times.
 *
 * Two guarantees, and why each is needed:
 *
 *  - **TTL cache** — a payload read is cheap once it exists; re-reading it to
 *    paint the same menu is pure waste. Short TTL keeps a stale catalog from
 *    outliving a provider edit for long.
 *  - **In-flight dedupe** — the concurrent callers above fire in the same tick,
 *    before any cache entry exists. Without joining them, a cache alone fixes
 *    the *serial* case and leaves the *parallel* one untouched.
 *
 * Deliberately NOT a global store: the settings page mutates providers and then
 * must see its own write. It calls `invalidateLlmSettings()` (or passes
 * `force`) instead of trusting a snapshot.
 */

export interface LlmSettingsPayload {
  defaultProvider?: string;
  routingDefaultModel?: { provider: string; model: string } | null;
  providers?: Record<string, {
    displayName?: string;
    enabled?: boolean;
    configured?: boolean;
    model?: string;
    models?: Array<{ id: string; name?: string; mode?: string; capabilities?: string[] }>;
  }>;
  [key: string]: unknown;
}

/** How long a payload may be reused without re-reading it. */
export const LLM_SETTINGS_TTL_MS = 30_000;

let cache: { at: number; data: LlmSettingsPayload } | null = null;
let inFlight: Promise<LlmSettingsPayload> | null = null;

/** Drop the snapshot — call after any write that changes providers or routing. */
export function invalidateLlmSettings(): void {
  cache = null;
}

/**
 * Read the LLM settings payload.
 *
 * @param opts.force  bypass the cache (a write just happened / a user asked to refresh)
 */
export async function fetchLlmSettings(
  opts?: { force?: boolean },
): Promise<LlmSettingsPayload> {
  if (!opts?.force && cache && Date.now() - cache.at < LLM_SETTINGS_TTL_MS) {
    return cache.data;
  }
  // Join an in-flight read: N callers in one tick must produce ONE request.
  if (inFlight) return inFlight;

  const flight = (async () => {
    const res = await fetch('/api/settings/llm', { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as LlmSettingsPayload;
    cache = { at: Date.now(), data };
    return data;
  })();

  inFlight = flight;
  try {
    return await flight;
  } finally {
    if (inFlight === flight) inFlight = null;
  }
}

/** Test-only: reset module state between cases. */
export function __resetLlmSettingsCacheForTests(): void {
  cache = null;
  inFlight = null;
}
