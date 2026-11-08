import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearBrowserHistory,
  deliverableTarget,
  displayHistoryTarget,
  displayHistoryUrl,
  fileTarget,
  historyEntryKey,
  historyNavFromModifierKey,
  historyVisitForPanel,
  loadBrowserHistory,
  normalizeHistoryUrl,
  recordBrowserVisit,
  recordHistoryVisit,
  removeHistoryEntry,
  searchBrowserHistory,
  stepHistoryIndex,
  subscribeBrowserHistory,
} from './browserHistory.ts';

/** Minimal localStorage shim — the node test env has none. */
function installLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  });
  return store;
}

const STORAGE_KEY = 'markus:browser-history';

describe('browserHistory', () => {
  beforeEach(() => {
    installLocalStorage();
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts empty', () => {
    expect(loadBrowserHistory()).toEqual([]);
    expect(searchBrowserHistory('anything')).toEqual([]);
  });

  it('records visits, most recent first', () => {
    recordBrowserVisit('https://a.example.com', 'Site A', 1000);
    recordBrowserVisit('https://b.example.com', 'Site B', 2000);

    const history = loadBrowserHistory();
    expect(history.map(h => h.target)).toEqual(['https://b.example.com', 'https://a.example.com']);
    expect(history.every(h => h.kind === 'url')).toBe(true);
    expect(history[0].title).toBe('Site B');
    expect(history[0].visitCount).toBe(1);
  });

  it('dedupes by URL and bumps the visit count', () => {
    recordBrowserVisit('https://a.example.com', 'First', 1000);
    recordBrowserVisit('https://b.example.com', 'B', 1500);
    recordBrowserVisit('https://a.example.com', 'Second', 2000);

    const history = loadBrowserHistory();
    expect(history).toHaveLength(2);
    expect(history[0].target).toBe('https://a.example.com');
    expect(history[0].visitCount).toBe(2);
    expect(history[0].title).toBe('Second');
    expect(history[1].target).toBe('https://b.example.com');
  });

  it('keeps the previous title when a later visit reports none', () => {
    recordBrowserVisit('https://a.example.com', 'Kept title', 1000);
    recordBrowserVisit('https://a.example.com', undefined, 2000);
    expect(loadBrowserHistory()[0].title).toBe('Kept title');
  });

  it('ignores about:blank and empty URLs', () => {
    recordBrowserVisit('about:blank', undefined, 1000);
    recordBrowserVisit('', undefined, 1000);
    recordBrowserVisit('   ', undefined, 1000);
    expect(loadBrowserHistory()).toEqual([]);
  });

  it('remembers file:// URLs as url entries and displays them without the scheme', () => {
    recordBrowserVisit('file:///Users/me/notes.md', 'notes', 1000);
    expect(loadBrowserHistory()[0].target).toBe('file:///Users/me/notes.md');
    expect(displayHistoryUrl('file:///Users/me/notes.md')).toBe('/Users/me/notes.md');
  });

  it('records a local file visit with its own kind and dedupes it', () => {
    recordHistoryVisit({ kind: 'file', target: ' /Users/me/report.md ', title: 'report.md' }, 1000);
    recordHistoryVisit({ kind: 'file', target: '/Users/me/other.md', title: 'other.md' }, 1500);
    recordHistoryVisit({ kind: 'file', target: '/Users/me/report.md' }, 2000);

    const history = loadBrowserHistory();
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      kind: 'file',
      target: '/Users/me/report.md',
      title: 'report.md', // later visit had no title → previous one kept
      visitedAt: 2000,
      visitCount: 2,
    });
  });

  it('keeps a file and a url pointing at the same path as two distinct rows', () => {
    // The panel editor and a browser tab are different destinations: one previews
    // the path in the panel, the other navigates a page. Same path ⇒ no collision.
    recordHistoryVisit({ kind: 'file', target: '/Users/me/notes.md' }, 1000);
    recordBrowserVisit('file:///Users/me/notes.md', 'notes', 2000);

    const history = loadBrowserHistory();
    expect(history).toHaveLength(2);
    expect(history.map(historyEntryKey)).toEqual([
      'url:file:///Users/me/notes.md',
      'file:/Users/me/notes.md',
    ]);
  });

  it('records a deliverable with its reference as the location line', () => {
    recordHistoryVisit(
      { kind: 'deliverable', target: 'dlv_1', title: '季度报告', location: '/out/q3.md' },
      1000,
    );
    const entry = loadBrowserHistory()[0];
    expect(entry.kind).toBe('deliverable');
    expect(displayHistoryTarget(entry)).toBe('/out/q3.md');
  });

  it('falls back to the deliverable target when it has no reference', () => {
    recordHistoryVisit({ kind: 'deliverable', target: 'dlv_2', title: 'Builder artifact' }, 1000);
    expect(displayHistoryTarget(loadBrowserHistory()[0])).toBe('dlv_2');
  });

  it('deliverableTarget prefers the id and otherwise derives a stable composite', () => {
    expect(deliverableTarget({ id: 'dlv_9', reference: '/a.md', title: 'A' })).toBe('dlv_9');
    // Same id-less deliverable → same target; a different summary head → different target.
    const a = deliverableTarget({ reference: '/a.md', title: 'A', summary: 'one' });
    const b = deliverableTarget({ reference: '/a.md', title: 'A', summary: 'one' });
    const c = deliverableTarget({ reference: '/a.md', title: 'A', summary: 'two' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(deliverableTarget({})).toBe('');
  });

  it('derives visit descriptors from panel payloads, and refuses the rest', () => {
    expect(historyVisitForPanel({ kind: 'file', path: '/a/b.md', title: 'b.md' }))
      .toEqual({ kind: 'file', target: '/a/b.md', title: 'b.md' });
    expect(historyVisitForPanel({
      kind: 'deliverable',
      deliverable: { id: 'dlv_1', title: 'Report', reference: '/out/r.md' },
    })).toEqual({ kind: 'deliverable', target: 'dlv_1', title: 'Report', location: '/out/r.md' });
    // A url row's title comes from the browser at navigation time — the panel open
    // must not write it (that would be a second writer for the same row).
    expect(historyVisitForPanel({ kind: 'url', path: 'https://x.example.com' })).toBeNull();
    expect(historyVisitForPanel({ kind: 'terminal', path: 'tty1' })).toBeNull();
    expect(historyVisitForPanel({ kind: 'file', path: '  ' })).toBeNull();
    expect(historyVisitForPanel({ kind: 'deliverable', deliverable: {} })).toBeNull();
  });

  it('fileTarget trims but never rewrites the path', () => {
    expect(fileTarget('  /Users/me/a b.md ')).toBe('/Users/me/a b.md');
    expect(fileTarget('')).toBe('');
  });

  it('migrates legacy rows (no kind) to url entries instead of wiping them', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([
      { url: 'https://legacy.example.com', title: 'Legacy', visitedAt: 500, visitCount: 3 },
      // Half-migrated row: has kind but only the legacy `url` field.
      { kind: 'url', url: 'https://half.example.com', visitedAt: 600 },
      // New-format row.
      { kind: 'file', target: '/Users/me/new.md', visitedAt: 700, visitCount: 1 },
      // Junk that must be dropped without taking the rest of the list with it.
      null,
      'nope',
      { kind: 'file' },
      { visitedAt: 1 },
    ]));

    const history = loadBrowserHistory();
    expect(history.map(historyEntryKey)).toEqual([
      'file:/Users/me/new.md',
      'url:https://half.example.com',
      'url:https://legacy.example.com',
    ]);
    expect(history[2]).toMatchObject({ title: 'Legacy', visitCount: 3, visitedAt: 500 });
  });

  it('normalizes protocol-relative input', () => {
    expect(normalizeHistoryUrl('//example.com/x')).toBe('https://example.com/x');
    expect(normalizeHistoryUrl('  https://example.com  ')).toBe('https://example.com');
  });

  it('survives corrupt stored JSON', () => {
    localStorage.setItem(STORAGE_KEY, '{not-json');
    expect(loadBrowserHistory()).toEqual([]);
    recordBrowserVisit('https://a.example.com', undefined, 1000);
    expect(loadBrowserHistory()).toHaveLength(1);
  });
});

describe('browserHistory · search / remove / subscribe', () => {
  beforeEach(() => {
    installLocalStorage();
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ranks host/URL prefix hits above loose matches', () => {
    recordBrowserVisit('https://github.com/markus/platform', 'Markus', 1000);
    recordBrowserVisit('https://docs.example.com/github-mirror', 'Mirror', 1000);
    const results = searchBrowserHistory('github');
    expect(results[0].target).toBe('https://github.com/markus/platform');
  });

  it('requires every token to match', () => {
    recordBrowserVisit('https://github.com/markus/platform', 'Markus Platform', 1000);
    expect(searchBrowserHistory('github markus')).toHaveLength(1);
    expect(searchBrowserHistory('github nonexistent')).toHaveLength(0);
  });

  it('matches the title too', () => {
    recordBrowserVisit('https://x.example.com/1', 'Quarterly Report', 1000);
    expect(searchBrowserHistory('quarterly')).toHaveLength(1);
  });

  it('finds local files by path segment and deliverables by reference', () => {
    recordHistoryVisit({ kind: 'file', target: '/Users/me/notes/roadmap.md', title: 'roadmap.md' }, 1000);
    recordHistoryVisit(
      { kind: 'deliverable', target: 'dlv_7', title: '审计报告', location: '/out/hardcoded-audit.md' },
      2000,
    );
    expect(searchBrowserHistory('notes').map(h => h.kind)).toEqual(['file']);
    expect(searchBrowserHistory('hardcoded').map(h => h.kind)).toEqual(['deliverable']);
  });

  it('returns recency order for an empty query', () => {
    recordBrowserVisit('https://old.example.com', undefined, 1000);
    recordBrowserVisit('https://new.example.com', undefined, 9000);
    expect(searchBrowserHistory('').map(h => h.target)).toEqual([
      'https://new.example.com',
      'https://old.example.com',
    ]);
  });

  it('removes a single row by key (kind-aware) and clears everything', () => {
    recordHistoryVisit({ kind: 'file', target: '/Users/me/a.md' }, 1000);
    recordBrowserVisit('https://b.example.com', undefined, 2000);

    removeHistoryEntry(historyEntryKey({ kind: 'file', target: '/Users/me/a.md' }));
    expect(loadBrowserHistory().map(h => h.target)).toEqual(['https://b.example.com']);

    // Removing a url row with the same textual target must not touch other kinds.
    recordHistoryVisit({ kind: 'file', target: '/Users/me/c.md' }, 3000);
    removeHistoryEntry(historyEntryKey({ kind: 'url', target: '/Users/me/c.md' }));
    expect(loadBrowserHistory().map(h => h.kind)).toEqual(['file', 'url']);

    clearBrowserHistory();
    expect(loadBrowserHistory()).toEqual([]);
  });

  it('notifies subscribers on record / remove / clear', () => {
    const seen: string[][] = [];
    const unsubscribe = subscribeBrowserHistory(entries => seen.push(entries.map(historyEntryKey)));

    recordBrowserVisit('https://a.example.com', undefined, 1000);
    recordHistoryVisit({ kind: 'file', target: '/Users/me/b.md' }, 2000);
    removeHistoryEntry('url:https://a.example.com');
    clearBrowserHistory();

    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect(seen[seen.length - 1]).toEqual([]);
    expect(seen[1]).toContain('file:/Users/me/b.md');
    unsubscribe();
  });
});
