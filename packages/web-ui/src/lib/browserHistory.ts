/**
 * Address-bar visit history for the embedded right-panel browser.
 *
 * The embedded browser is an Electron `WebContentsView` — its own Chromium
 * history is not reachable from the React layer. So the panel keeps a small
 * user-visible history of our own: every successful navigation is recorded and
 * the address bar offers a searchable dropdown (↑/↓ + Enter) over it.
 *
 * Persisted in localStorage (per device, same as the search-engine preference)
 * so the list survives restarts and is shared by every tab / panel instance.
 */

export interface BrowserHistoryEntry {
  /** Normalized navigable URL (scheme kept, `file://` allowed). */
  url: string;
  /** Last known page title (optional — not every load reports one). */
  title?: string;
  /** Epoch ms of the most recent visit. */
  visitedAt: number;
  /** How many times this URL was visited (ranking signal). */
  visitCount: number;
}

const STORAGE_KEY = 'markus:browser-history';
/** Cap so localStorage never grows unbounded. */
const MAX_ENTRIES = 300;

/** Navigations that should never be remembered. */
function isRememberable(url: string): boolean {
  const u = (url || '').trim();
  if (!u || u === 'about:blank' || u === 'about:newtab') return false;
  return true;
}

/** Normalize for storage / dedupe: trim + expand protocol-relative input. */
export function normalizeHistoryUrl(url: string): string {
  const u = (url || '').trim();
  if (!u) return '';
  if (u.startsWith('//')) return `https:${u}`;
  return u;
}

/** Host + path without the scheme, for compact display. */
export function displayHistoryUrl(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
}

function readRaw(): BrowserHistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: BrowserHistoryEntry[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Partial<BrowserHistoryEntry>;
      if (typeof row.url !== 'string' || !isRememberable(row.url)) continue;
      out.push({
        url: row.url,
        title: typeof row.title === 'string' && row.title ? row.title : undefined,
        visitedAt: typeof row.visitedAt === 'number' && Number.isFinite(row.visitedAt) ? row.visitedAt : 0,
        visitCount: typeof row.visitCount === 'number' && row.visitCount > 0 ? row.visitCount : 1,
      });
    }
    return out;
  } catch {
    // localStorage unavailable (SSR / private mode / tests) → no history
    return [];
  }
}

function writeRaw(entries: BrowserHistoryEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    // best-effort persistence
  }
}

/** Full history, most-recent first. */
export function loadBrowserHistory(): BrowserHistoryEntry[] {
  return readRaw().sort((a, b) => b.visitedAt - a.visitedAt);
}

type Listener = (entries: BrowserHistoryEntry[]) => void;
const listeners = new Set<Listener>();

/** Notify in-app subscribers (the native `storage` event does not fire in-document). */
function emit(entries: BrowserHistoryEntry[]): void {
  for (const fn of listeners) {
    try {
      fn(entries);
    } catch {
      /* a broken subscriber must not break the writer */
    }
  }
}

/**
 * Subscribe to history changes (record / remove / clear), including changes
 * made from other same-origin documents via the native `storage` event.
 */
export function subscribeBrowserHistory(listener: Listener): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== null && e.key !== STORAGE_KEY) return;
    listener(loadBrowserHistory());
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

/**
 * Record a visit. Dedupes by URL: moves it to the top, bumps the visit count,
 * and refreshes the title when the page reports one.
 */
export function recordBrowserVisit(url: string, title?: string, now: number = Date.now()): BrowserHistoryEntry[] {
  const normalized = normalizeHistoryUrl(url);
  if (!isRememberable(normalized)) return loadBrowserHistory();

  const cleanTitle = (title || '').trim();
  const existing = readRaw();
  const prev = existing.find(e => e.url === normalized);
  const rest = existing.filter(e => e.url !== normalized);
  const next: BrowserHistoryEntry[] = [
    {
      url: normalized,
      // Keep the previous title when this navigation did not report one.
      title: cleanTitle || prev?.title,
      visitedAt: now,
      visitCount: (prev?.visitCount ?? 0) + 1,
    },
    ...rest,
  ].sort((a, b) => b.visitedAt - a.visitedAt).slice(0, MAX_ENTRIES);

  writeRaw(next);
  emit(next);
  return next;
}

/** Drop a single URL from history. */
export function removeBrowserHistoryEntry(url: string): BrowserHistoryEntry[] {
  const normalized = normalizeHistoryUrl(url);
  const next = readRaw().filter(e => e.url !== normalized);
  writeRaw(next);
  emit(next);
  return next;
}

/** Wipe the whole list. */
export function clearBrowserHistory(): BrowserHistoryEntry[] {
  writeRaw([]);
  emit([]);
  return [];
}

/**
 * Rank entries against a free-text query.
 *
 * Token AND-match (every whitespace-separated token must appear somewhere in
 * `url + title`), then scored so that host/URL prefix hits and frequently /
 * recently visited pages float to the top. An empty query returns recency order.
 */
export function searchBrowserHistory(query: string, limit = 8): BrowserHistoryEntry[] {
  const entries = loadBrowserHistory();
  const q = (query || '').trim().toLowerCase();
  if (!q) return entries.slice(0, limit);

  const tokens = q.split(/\s+/).filter(Boolean);
  const scored: Array<{ entry: BrowserHistoryEntry; score: number }> = [];

  for (const entry of entries) {
    const url = entry.url.toLowerCase();
    const title = (entry.title || '').toLowerCase();
    const display = displayHistoryUrl(url);
    const haystack = `${display} ${title}`;

    let score = 0;
    let matchedAll = true;
    for (const token of tokens) {
      if (!haystack.includes(token)) {
        matchedAll = false;
        break;
      }
      if (display.startsWith(token)) score += 120;
      else if (url.startsWith(token)) score += 100;
      else if (new RegExp(`(^|[./:?&=_-])${escapeRegExp(token)}`).test(display)) score += 60;
      else if (title.startsWith(token)) score += 50;
      else score += 20;
    }
    if (!matchedAll) continue;

    // Recency (decaying) + popularity nudges; kept small so match quality wins.
    const ageDays = Math.max(0, (Date.now() - entry.visitedAt) / 86_400_000);
    score += Math.max(0, 30 - ageDays * 2);
    score += Math.min(30, entry.visitCount * 3);

    scored.push({ entry, score });
  }

  return scored
    .sort((a, b) => (b.score - a.score) || (b.entry.visitedAt - a.entry.visitedAt))
    .slice(0, limit)
    .map(s => s.entry);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Which way a navigation key moves the highlighted history row. */
export type HistoryNavDirection = 'next' | 'prev';

/**
 * Emacs-style aliases for ↓/↑ in the address bar: Ctrl+N / Ctrl+P.
 *
 * Deliberately narrow — `Cmd+N` (new window) and `Cmd+P` (print) keep their
 * platform meaning, and Alt/Ctrl+Alt chords are left alone. Returns `null`
 * when the combo is not a history-navigation key. `key` is compared
 * case-insensitively so Ctrl+Shift+N behaves the same as Ctrl+N.
 */
export function historyNavFromModifierKey(e: {
  key: string;
  ctrlKey: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}): HistoryNavDirection | null {
  if (!e.ctrlKey || e.metaKey || e.altKey) return null;
  const key = (e.key || '').toLowerCase();
  if (key === 'n') return 'next';
  if (key === 'p') return 'prev';
  return null;
}

/**
 * Highlight movement shared by ↑/↓ and Ctrl+P/Ctrl+N, with wrap-around.
 *
 * `current = -1` means "nothing highlighted yet": moving down starts at the
 * first row, moving up jumps to the last one (matching browser address bars).
 * Returns -1 for an empty list so callers can treat it as "none".
 */
export function stepHistoryIndex(
  current: number,
  count: number,
  direction: HistoryNavDirection,
): number {
  if (count <= 0) return -1;
  if (current < 0) return direction === 'next' ? 0 : count - 1;
  const delta = direction === 'next' ? 1 : -1;
  return (current + delta + count) % count;
}
