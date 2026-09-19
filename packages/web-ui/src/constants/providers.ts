import { useEffect, useState } from 'react';
import { api } from '../api.ts';

export interface ProviderOption {
  id: string;
  label: string;
  envKey: string;
  baseUrl?: string;
  defaultModel: string;
}

/**
 * The provider directory lives on the server (`@markus/shared` PROVIDERS) and is
 * fetched once here. This file used to hard-code the whole table, including a
 * default *model* per provider — those ids went stale and disagreed with the
 * registry. The browser bundle cannot import `@markus/shared`, hence the fetch.
 */
let catalogCache: ProviderOption[] = [];
let inflight: Promise<ProviderOption[]> | null = null;

/** Fetch the provider directory (cached; never throws). */
export async function fetchProviderCatalog(): Promise<ProviderOption[]> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await api.modelCatalog.providerCatalog();
      catalogCache = res.providers ?? [];
    } catch {
      catalogCache = [];
    }
    return catalogCache;
  })();
  return inflight;
}

/** Synchronous read of whatever has been fetched so far (may be empty). */
export function getProviderCatalogSync(): ProviderOption[] {
  return catalogCache;
}

/** React hook — returns [] until the catalog arrives, then the full list. */
export function useProviderCatalog(): ProviderOption[] {
  const [options, setOptions] = useState<ProviderOption[]>(catalogCache);
  useEffect(() => {
    let alive = true;
    void fetchProviderCatalog().then(list => {
      if (alive) setOptions(list);
    });
    return () => { alive = false; };
  }, []);
  return options;
}

// NOTE: there is deliberately no hard-coded provider table here. It used to
// exist (and drifted stale against the registry), which is exactly what the
// fetch above replaced. Keep this file free of provider data.
