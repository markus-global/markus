import type { ModelDefinition } from '@markus/shared';
import { ModelCatalogService } from './model-catalog.js';
import { stripMarkusNamespace } from './markus-provider.js';

/**
 * Catalog lookup sources for a provider. `builtin` is the static built-in
 * catalog; `hub` is the provider's own runtime-loaded catalog (for the Markus
 * provider this is the Hub OR catalog and is its sole source of truth).
 */
export interface CatalogLookupSources {
  builtin?: readonly ModelDefinition[];
  hub?: readonly ModelDefinition[];
}

/**
 * Normalize a model id for matching:
 *   1. strip a leading `markus/` namespace,
 *   2. strip a known LiteLLM vendor prefix (e.g. `deepseek/` → `deepseek-v4-flash`).
 * Organization/model forms like `deepseek-ai/DeepSeek-V3` are deliberately left
 * untouched (the vendor prefix set is explicit, `deepseek-ai` is not a vendor).
 */
export function normalizeCatalogId(modelId: string | undefined | null): string {
  const s = stripMarkusNamespace(modelId).trim();
  return ModelCatalogService.stripProviderPrefix(s);
}

/**
 * Find the catalog entry for `providerName` + `modelId`, resolving only through
 * precise id normalization — no fuzzy / substring / display-name matching.
 *
 * Match priority:
 *   1. exact id in the provider's own hub catalog, then exact id in builtin
 *      (with the same provider name),
 *   2. normalized id (markus/ + vendor-prefix stripped) in hub, then builtin.
 *
 * A provider's metadata is never borrowed from another provider's catalog:
 * builtin entries only match when their `provider` equals `providerName`.
 * Returns `undefined` when nothing matches — the caller decides (fail-loud).
 */
export function findCatalogEntry(
  providerName: string,
  modelId: string | undefined | null,
  sources: CatalogLookupSources,
): ModelDefinition | undefined {
  const model = (modelId ?? '').trim();
  if (!model) return undefined;
  const builtin = sources.builtin ?? [];
  const hub = sources.hub ?? [];

  // 1a. exact id in the provider's own hub catalog (highest authority).
  const exactHub = hub.find(m => m.id === model);
  if (exactHub) return exactHub;

  // 1b. exact id in the built-in catalog for this specific provider.
  const exactBuiltin = builtin.find(m => m.id === model && m.provider === providerName);
  if (exactBuiltin) return exactBuiltin;

  // 2. normalized id (markus/ + vendor-prefix stripped).
  const normalized = normalizeCatalogId(model);
  if (normalized && normalized !== model) {
    const normHub = hub.find(m => m.id === normalized);
    if (normHub) return normHub;
    const normBuiltin = builtin.find(m => m.id === normalized && m.provider === providerName);
    if (normBuiltin) return normBuiltin;
  }

  return undefined;
}
