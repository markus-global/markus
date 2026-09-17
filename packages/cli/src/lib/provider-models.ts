/**
 * CLI helper: ask a provider for its own model list.
 *
 * Why not a static table: provider model ids change weekly, and a hard-coded
 * list goes stale silently — the user picks an id the provider no longer serves
 * and only finds out when the request 404s. The provider's own listing endpoint
 * is the authority; the registry `defaultModel` in `@markus/shared` is only a
 * bootstrap value for the no-key / offline case.
 */
import { PROVIDERS, loadConfig, type ProviderModel } from '@markus/shared';
import { discoverProviderModels } from '@markus/core';

export interface ProviderModelList {
  provider: ProviderModel;
  /** Model ids, in the order the provider returned them. */
  models: string[];
  /** Where the ids came from. `bootstrap` means the live listing failed. */
  source: 'live' | 'bootstrap';
  /** Why the live listing failed (only set when `source === 'bootstrap'`). */
  error?: string;
}

/** API key for a provider: environment first, then the saved config. */
export function resolveApiKey(pdef: ProviderModel): string | undefined {
  const fromEnv = process.env[pdef.envKey];
  if (fromEnv) return fromEnv;
  try {
    const cfg = loadConfig(undefined) as {
      llm?: { providers?: Record<string, { apiKey?: string } | undefined> };
    };
    return cfg.llm?.providers?.[pdef.id]?.apiKey;
  } catch {
    return undefined;
  }
}

/** Provider definition by id, or undefined. */
export function findProvider(id: string): ProviderModel | undefined {
  return PROVIDERS.find(p => p.id === id);
}

/**
 * List a provider's models, falling back to its bootstrap model.
 * Never throws — a failed listing degrades to `source: 'bootstrap'`.
 */
export async function listProviderModels(
  pdef: ProviderModel,
  opts: { apiKey?: string; baseUrl?: string; timeoutMs?: number } = {},
): Promise<ProviderModelList> {
  const apiKey = opts.apiKey ?? resolveApiKey(pdef);
  const baseUrl = opts.baseUrl ?? pdef.baseUrl;

  try {
    const discovered = await discoverProviderModels({
      provider: pdef.id,
      apiKey,
      baseUrl,
      timeoutMs: opts.timeoutMs ?? 10_000,
    });
    const ids = discovered.map(m => m.id).filter(Boolean);
    if (ids.length > 0) {
      return { provider: pdef, models: ids, source: 'live' };
    }
    return {
      provider: pdef,
      models: pdef.defaultModel ? [pdef.defaultModel] : [],
      source: 'bootstrap',
      error: 'provider returned an empty model list',
    };
  } catch (err) {
    return {
      provider: pdef,
      models: pdef.defaultModel ? [pdef.defaultModel] : [],
      source: 'bootstrap',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** List models for several providers in parallel. */
export async function listProviderModelsBatch(
  defs: ProviderModel[],
  opts: { timeoutMs?: number } = {},
): Promise<ProviderModelList[]> {
  return Promise.all(defs.map(p => listProviderModels(p, opts)));
}
