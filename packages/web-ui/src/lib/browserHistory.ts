/**
 * Right-panel visit history: address-bar destinations **and** the local files /
 * deliverables the panel has previewed.
 *
 * The embedded browser is an Electron `WebContentsView` — its own Chromium
 * history is not reachable from the React layer. So the panel keeps a small
 * user-visible history of our own: every successful navigation is recorded, and
 * so is every file / deliverable opened in the panel. The address bar (and, for
 * the preview modes, the panel chrome) offers a searchable dropdown (↑/↓ +
 * Enter) over it.
 *
 * Persisted in localStorage (per device, same as the search-engine preference)
 * so the list survives restarts and is shared by every tab / panel instance.
 */

/** What a history row reopens. */
export type HistoryEntryKind = 'url' | 'file' | 'deliverable';

export interface BrowserHistoryEntry {
  /** Which opener a pick must use. */
  kind: HistoryEntryKind;
  /**
   * Identity **within** the kind — `kind + target` is the dedupe key:
   *  - `url`: normalized navigable URL
   *  - `file`: absolute path
   *  - `deliverable`: stable deliverable target (see `deliverableTarget`)
   *
   * Two rows with the same target but different kinds never collide
   * (`file:/a/b.md` and `url:file:///a/b.md` are different destinations, and
   * one opens the panel's editor while the other navigates a browser tab).
   */
  target: string;
  /** Last known display name (page title / file name / deliverable title). */
  title?: string;
  /**
   * Second display line when it is not the target itself. Only deliverables
   * need it: their target is an id, while the user recognises the on-disk
   * reference (or the name, when there is no reference).
   */
  location?: string;
  /** Epoch ms of the most recent visit. */
  visitedAt: number;
  /** How many times this target was visited (ranking signal). */
  visitCount: number;
}

/** A "record this" descriptor — an entry without the visit bookkeeping yet. */
export interface HistoryVisit {
  kind: HistoryEntryKind;
  target: string;
  title?: string;
  location?: string;
}

const STORAGE_KEY = 'markus:browser-history';
/** Cap so localStorage never grows unbounded. */
const MAX_ENTRIES = 300;

/** `kind + target` — the single dedupe / removal key for a history row. */
export function historyEntryKey(entry: { kind: HistoryEntryKind; target: string }): string {
  return `${entry.kind}:${entry.target}`;
}

/** Navigations that should never be remembered. */
function isRememberable(kind: HistoryEntryKind, target: string): boolean {
  const t = (target || '').trim();
  if (!t) return false;
  if (kind !== 'url') return true;
  return t !== 'about:blank' && t !== 'about:newtab';
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

/** History target for a local path — the panel opens the path verbatim. */
export function fileTarget(filePath: string): string {
  return (filePath || '').trim();
}

/**
 * Deliverable identity — the ONE definition, shared by the right-panel tab key
 * (`payloadKey` in LayoutContext) and the history target. If both sides decided
 * "same deliverable?" differently, re-opening a deliverable would either stack
 * duplicate tabs or overwrite the wrong history row.
 *
 * Prefer the stable id; fall back to reference + title + summary head so two
 * markdown deliverables with the same generic title stay distinct. Returns ''
 * when there is nothing to identify the deliverable by.
 */
export function deliverableTarget(d: {
  id?: string;
  reference?: string;
  title?: string;
  summary?: string;
}): string {
  const id = (d.id || '').trim();
  if (id) return id;
  const composite = `${d.reference || ''}|${d.title || ''}|${(d.summary || '').slice(0, 48)}`;
  return composite === '||' ? '' : composite;
}

/** Minimal structural shape of a right-panel payload (no React import needed). */
export interface PanelVisitInput {
  kind: string;
  path?: string;
  title?: string;
  deliverable?: { id?: string; reference?: string; title?: string; summary?: string };
}

/**
 * Turn a right-panel payload into a visit descriptor, or `null` when the panel
 * open must not be remembered.
 *
 * URLs deliberately return `null`: a url row's identity *and* its title come
 * from the browser at navigation time (`recordBrowserVisit`), so recording one
 * here would create a second writer for the same row (an `about:blank` "New
 * Tab" open has no destination at all). Terminals are not destinations either.
 */
export function historyVisitForPanel(input: PanelVisitInput): HistoryVisit | null {
  if (input.kind === 'file') {
    const target = fileTarget(input.path || '');
    if (!isRememberable('file', target)) return null;
    return { kind: 'file', target, title: (input.title || '').trim() || undefined };
  }
  if (input.kind === 'deliverable') {
    const d = input.deliverable;
    if (!d) return null;
    const target = deliverableTarget(d);
    if (!isRememberable('deliverable', target)) return null;
    return {
      kind: 'deliverable',
      target,
      title: (d.title || '').trim() || undefined,
      location: (d.reference || '').trim() || undefined,
    };
  }
  return null;
}

/** Second display line: where the row lives. */
export function displayHistoryTarget(entry: BrowserHistoryEntry): string {
  if (entry.kind === 'url') return displayHistoryUrl(entry.target);
  if (entry.kind === 'deliverable') return entry.location || entry.target;
  return entry.target;
}

function optString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

/**
 * Read one stored row.
 *
 * Legacy rows (written before this model existed) carry only `url` and no
 * `kind`; they are read back as url entries so an upgrade never wipes the list.
 */
function parseEntry(item: unknown): BrowserHistoryEntry | null {
  if (!item || typeof item !== 'object') return null;
  const row = item as Record<string, unknown>;
  const kind: HistoryEntryKind =
    row.kind === 'file' || row.kind === 'deliverable' ? row.kind : 'url';
  const rawTarget =
    typeof row.target === 'string'
      ? row.target
      : kind === 'url' && typeof row.url === 'string'
        ? row.url
        : '';
  const target = kind === 'url' ? normalizeHistoryUrl(rawTarget) : fileTarget(rawTarget);
  if (!isRememberable(kind, target)) return null;
  return {
    kind,
    target,
    title: optString(row.title),
    // Only deliverables look up `location`; url/file derive it from `target`.
    location: kind === 'deliverable' ? optString(row.location) : undefined,
    visitedAt:
      typeof row.visitedAt === 'number' && Number.isFinite(row.visitedAt) ? row.visitedAt : 0,
    visitCount: typeof row.visitCount === 'number' && row.visitCount > 0 ? row.visitCount : 1,
  };
}

function readRaw(): BrowserHistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: BrowserHistoryEntry[] = [];
    for (const item of parsed) {
      const entry = parseEntry(item);
      if (entry) out.push(entry);
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
 * Record a visit of any kind. Dedupes by `kind + target`: moves the row to the
 * top, bumps the visit count, and refreshes title / location when the caller
 * reports them (a later visit with no title keeps the previous one).
 */
export function recordHistoryVisit(visit: HistoryVisit, now: number = Date.now()): BrowserHistoryEntry[] {
  const target = visit.kind === 'url' ? normalizeHistoryUrl(visit.target) : fileTarget(visit.target);
  if (!isRememberable(visit.kind, target)) return loadBrowserHistory();

  const key = `${visit.kind}:${target}`;
  const existing = readRaw();
  const prev = existing.find(e => historyEntryKey(e) === key);
  const rest = existing.filter(e => historyEntryKey(e) !== key);
  const next: BrowserHistoryEntry[] = [
    {
      kind: visit.kind,
      target,
      title: (visit.title || '').trim() || prev?.title,
      location: (visit.location || '').trim() || prev?.location,
      visitedAt: now,
      visitCount: (prev?.visitCount ?? 0) + 1,
    },
    ...rest,
  ].sort((a, b) => b.visitedAt - a.visitedAt).slice(0, MAX_ENTRIES);

  writeRaw(next);
  emit(next);
  return next;
}

/** Record a browser navigation (the url-kind convenience writer). */
export function recordBrowserVisit(url: string, title?: string, now: number = Date.now()): BrowserHistoryEntry[] {
  return recordHistoryVisit({ kind: 'url', target: url, title }, now);
}

/** Drop a single row by `historyEntryKey(entry)`. */
export function removeHistoryEntry(key: string): BrowserHistoryEntry[] {
  const next = readRaw().filter(e => historyEntryKey(e) !== key);
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
 * `location + title`), then scored so that prefix hits on the location and
 * frequently / recently visited targets float to the top. An empty query
 * returns recency order.
 */
export function searchBrowserHistory(query: string, limit = 8): BrowserHistoryEntry[] {
  const entries = loadBrowserHistory();
  const q = (query || '').trim().toLowerCase();
  if (!q) return entries.slice(0, limit);

  const tokens = q.split(/\s+/).filter(Boolean);
  const scored: Array<{ entry: BrowserHistoryEntry; score: number }> = [];

  for (const entry of entries) {
    const target = entry.target.toLowerCase();
    const title = (entry.title || '').toLowerCase();
    const display = displayHistoryTarget(entry).toLowerCase();
    const haystack = `${display} ${title}`;

    let score = 0;
    let matchedAll = true;
    for (const token of tokens) {
      if (!haystack.includes(token)) {
        matchedAll = false;
        break;
      }
      if (display.startsWith(token)) score += 120;
      else if (target.startsWith(token)) score += 100;
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
