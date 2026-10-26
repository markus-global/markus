/**
 * Resolve a possibly-shortened entity id to the full id.
 *
 * ## Why this file exists
 *
 * Entity ids are `<prefix>_` + 24 lowercase hex chars, e.g.
 * `tsk_28b8797b48bc8c854d1d0ad4`. Chat prose regularly quotes only a readable
 * prefix (`tsk_42810f44`) because 24 hex chars are unreadable — agents do this
 * all the time, and the platform's own referencing convention encourages bare
 * ids in prose.
 *
 * A shortened id is *shaped* exactly like a real one, so the chat renderer turns
 * it into a clickable chip (`looksLikeEntityId` matches on shape alone). The
 * click then navigates, the lookup 404s, and the user ends up on the target page
 * with nothing open. Observed in production: `tsk_42810f44` → 404,
 * `tsk_035286198c2012edd381ecf1` → 200.
 *
 * The root cause is inferring structure from notation: a string that *looks*
 * like an id is not necessarily an id that *resolves*. We cannot fix that by
 * tightening the regex (a real id and a truncated one are indistinguishable by
 * shape), so we do the only honest thing at the click boundary: ask the
 * collection and accept the answer **only when it is unique**. We never guess
 * between two candidates — opening the wrong task is worse than opening none.
 *
 * Resolution happens once, at the single point where a chat-rendered entity is
 * turned into a navigation (see `navigateToEntity` in EntityCard.tsx), so every
 * downstream consumer — the nav event, the `markus_nav_*` handoff, the Work
 * page effects — receives a full, resolvable id.
 */
import { api } from './api.ts';

/** `prefix_` (5) + 24 hex = 29 for 4-letter prefixes; 4 + 24 = 28 for 3-letter. */
const HEX_LEN = 24;

/** True when `id` is already long enough to be a canonical entity id. */
export function isFullEntityId(id: string): boolean {
  const underscore = id.indexOf('_');
  if (underscore < 0) return false;
  return id.length >= underscore + 1 + HEX_LEN;
}

type Collection = {
  /** Full id list for the collection. Cached per resolve session. */
  load: () => Promise<string[]>;
};

const COLLECTIONS: Record<string, Collection> = {
  tsk: {
    load: async () => (await api.tasks.list({ lean: true, pageSize: 500 })).tasks.map(t => t.id),
  },
  req: {
    load: async () => (await api.requirements.list({ lean: true })).requirements.map(r => r.id),
  },
  proj: {
    load: async () => (await api.projects.list()).projects.map(p => p.id),
  },
  dlv: {
    load: async () => (await api.deliverables.search({ limit: 500 })).results.map(d => d.id),
  },
  agt: {
    load: async () => (await api.agents.list({ lean: true })).agents.map(a => a.id),
  },
  team: {
    load: async () => (await api.teams.list()).teams.map(t => t.id),
  },
};

/** Collection cache — one fetch per kind per page session, so repeated clicks stay instant. */
const collectionCache = new Map<string, Promise<string[]>>();

/** Prefix resolution cache — keyed by the short id, so a repeated click is free. */
const resolveCache = new Map<string, string | null>();

function collectionFor(prefix: string): Promise<string[]> | null {
  const collection = COLLECTIONS[prefix];
  if (!collection) return null;
  let pending = collectionCache.get(prefix);
  if (!pending) {
    pending = collection.load().catch((err) => {
      // A failed fetch must not be cached as an authoritative "no such entity",
      // otherwise one flaky request would poison every later click.
      collectionCache.delete(prefix);
      throw err;
    });
    collectionCache.set(prefix, pending);
  }
  return pending;
}

/**
 * Resolve `id` to a full entity id.
 *
 * - Full-length ids are returned unchanged (no network round trip — this is the
 *   common case and must stay synchronous-fast).
 * - Shortened ids are matched by prefix against their collection. A unique match
 *   wins; zero matches or several matches return `null` (caller decides what to
 *   tell the user).
 * - Unknown prefixes return `null`.
 *
 * Test seam: `__clearEntityResolveCache()` drops both caches.
 */
export async function resolveEntityId(id: string): Promise<string | null> {
  if (!id) return null;
  const underscore = id.indexOf('_');
  if (underscore < 0) return null;
  const prefix = id.slice(0, underscore);
  if (!COLLECTIONS[prefix]) return null;
  if (isFullEntityId(id)) return id;

  const cached = resolveCache.get(id);
  if (cached !== undefined) return cached;

  const matches = (await collectionFor(prefix) ?? []).filter(candidate => candidate.startsWith(id));
  const resolved = matches.length === 1 ? matches[0] : null;
  resolveCache.set(id, resolved);
  return resolved;
}

/** Drop caches. Tests call this; production never needs to. */
export function __clearEntityResolveCache(): void {
  collectionCache.clear();
  resolveCache.clear();
}
