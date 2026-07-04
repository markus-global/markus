/**
 * Shared data cache layer for common entities.
 *
 * Eliminates redundant API calls by providing a single cache
 * that Home, Team, and Work pages all read from. Entries are
 * revalidated on configurable TTLs and invalidated via WS events.
 */
import { api, wsClient } from '../api.ts';

// ── Types ──────────────────────────────────────────────────────────────────

type Listener = () => void;

interface CacheEntry<T> {
  data: T | null;
  ts: number;
  inflight: Promise<T> | null;
}

interface EntityConfig<T> {
  fetcher: () => Promise<T>;
  ttlMs: number;
  wsEvents: string[];
}

// ── Entity configs ─────────────────────────────────────────────────────────

interface AgentsResult { agents: Array<{ id: string; name: string; [k: string]: unknown }> }
interface TeamsResult { teams: Array<{ id: string; name: string; [k: string]: unknown }>; ungrouped: unknown[] }
interface RequirementsResult { requirements: Array<{ id: string; [k: string]: unknown }> }
interface GroupChatsResult { chats: Array<{ id: string; [k: string]: unknown }> }
interface UsersResult { users: Array<{ id: string; name: string; [k: string]: unknown }> }

type CacheKey = 'agents' | 'teams' | 'requirements' | 'groupChats' | 'users';

const CONFIGS: Record<CacheKey, EntityConfig<unknown>> = {
  agents: {
    fetcher: () => api.agents.list() as Promise<unknown>,
    ttlMs: 15_000,
    wsEvents: ['agent:update', 'agent:removed'],
  },
  teams: {
    fetcher: () => api.teams.list() as Promise<unknown>,
    ttlMs: 30_000,
    wsEvents: ['team:update'],
  },
  requirements: {
    fetcher: () => api.requirements.list({}) as Promise<unknown>,
    ttlMs: 20_000,
    wsEvents: [
      'requirement:created', 'requirement:approved', 'requirement:rejected',
      'requirement:updated', 'requirement:completed', 'requirement:cancelled',
      'requirement:resubmitted',
    ],
  },
  groupChats: {
    fetcher: () => api.groupChats.list() as Promise<unknown>,
    ttlMs: 30_000,
    wsEvents: ['chat:group_created', 'chat:group_updated', 'chat:group_deleted'],
  },
  users: {
    fetcher: () => api.users.list() as Promise<unknown>,
    ttlMs: 60_000,
    wsEvents: [],
  },
};

// ── Cache state ────────────────────────────────────────────────────────────

const _entries = new Map<CacheKey, CacheEntry<unknown>>();
const _listeners = new Map<CacheKey, Set<Listener>>();
const _globalListeners = new Set<Listener>();

function getEntry(key: CacheKey): CacheEntry<unknown> {
  let e = _entries.get(key);
  if (!e) {
    e = { data: null, ts: 0, inflight: null };
    _entries.set(key, e);
  }
  return e;
}

function notify(key: CacheKey) {
  _listeners.get(key)?.forEach(fn => fn());
  _globalListeners.forEach(fn => fn());
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Get cached data for an entity. Returns `null` on first call before data arrives.
 * Automatically triggers a background fetch when stale.
 */
function get<K extends CacheKey>(key: K): K extends 'agents' ? AgentsResult | null
  : K extends 'teams' ? TeamsResult | null
  : K extends 'requirements' ? RequirementsResult | null
  : K extends 'groupChats' ? GroupChatsResult | null
  : K extends 'users' ? UsersResult | null
  : unknown | null {
  const entry = getEntry(key);
  const cfg = CONFIGS[key];
  const stale = Date.now() - entry.ts > cfg.ttlMs;
  if (stale && !entry.inflight) {
    refresh(key);
  }
  return entry.data as ReturnType<typeof get>;
}

/** Force refresh a specific entity (returns promise of the fresh data). */
function refresh(key: CacheKey): Promise<unknown> {
  const entry = getEntry(key);
  const cfg = CONFIGS[key];
  if (entry.inflight) return entry.inflight;
  const p = cfg.fetcher().then(data => {
    entry.data = data;
    entry.ts = Date.now();
    entry.inflight = null;
    notify(key);
    return data;
  }).catch(err => {
    entry.inflight = null;
    throw err;
  });
  entry.inflight = p;
  return p;
}

/** Invalidate cache for a key (optionally with immediate refetch). */
function invalidate(key: CacheKey, refetch = true) {
  const entry = getEntry(key);
  entry.ts = 0;
  if (refetch) refresh(key);
}

/** Invalidate all cached entities. */
function invalidateAll(refetch = true) {
  for (const key of Object.keys(CONFIGS) as CacheKey[]) {
    invalidate(key, refetch);
  }
}

/** Subscribe to changes for a specific entity. Returns unsubscribe fn. */
function subscribe(key: CacheKey, listener: Listener): () => void {
  let set = _listeners.get(key);
  if (!set) { set = new Set(); _listeners.set(key, set); }
  set.add(listener);
  return () => set!.delete(listener);
}

/** Subscribe to changes on any entity. Returns unsubscribe fn. */
function subscribeAll(listener: Listener): () => void {
  _globalListeners.add(listener);
  return () => _globalListeners.delete(listener);
}

// ── WS auto-invalidation ──────────────────────────────────────────────────

const _throttleTimers = new Map<CacheKey, ReturnType<typeof setTimeout>>();
const WS_THROTTLE_MS = 3_000;

function wsInvalidate(key: CacheKey) {
  if (_throttleTimers.has(key)) return;
  _throttleTimers.set(key, setTimeout(() => {
    _throttleTimers.delete(key);
    invalidate(key, true);
  }, WS_THROTTLE_MS));
}

let _wsSetup = false;
function setupWsListeners() {
  if (_wsSetup) return;
  _wsSetup = true;
  for (const [key, cfg] of Object.entries(CONFIGS) as Array<[CacheKey, EntityConfig<unknown>]>) {
    for (const evt of cfg.wsEvents) {
      wsClient.on(evt, () => wsInvalidate(key));
    }
  }
  window.addEventListener('markus:data-changed', () => invalidateAll(true));
}

setupWsListeners();

// ── Export ──────────────────────────────────────────────────────────────────

export const dataCache = {
  get,
  refresh,
  invalidate,
  invalidateAll,
  subscribe,
  subscribeAll,
};

export type { CacheKey, AgentsResult, TeamsResult, RequirementsResult, GroupChatsResult, UsersResult };
