/**
 * One-shot prefetch cache: stores in-flight promises keyed by string.
 * `consume()` returns the promise and removes it from cache, so the
 * next load from the same page goes directly to the network.
 */

const cache = new Map<string, Promise<unknown>>();

export function prefetch(key: string, fn: () => Promise<unknown>): void {
  if (!cache.has(key)) {
    cache.set(key, fn().catch(() => undefined));
  }
}

export function consume<T>(key: string): Promise<T | undefined> | undefined {
  const p = cache.get(key) as Promise<T | undefined> | undefined;
  cache.delete(key);
  return p;
}

export const PREFETCH_KEYS = {
  builderArtifacts: 'builder.artifacts',
  builderAgents: 'builder.agents',
  builderHubMyItems: 'builder.hubMyItems',
  builderInstalled: 'builder.installed',
  hubAgents: 'hub.agents',
  hubTeams: 'hub.teams',
  hubSkills: 'hub.skills',
} as const;
