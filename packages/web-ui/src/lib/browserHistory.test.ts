import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearBrowserHistory,
  displayHistoryUrl,
  loadBrowserHistory,
  normalizeHistoryUrl,
  recordBrowserVisit,
  removeBrowserHistoryEntry,
  searchBrowserHistory,
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
    expect(history.map(h => h.url)).toEqual(['https://b.example.com', 'https://a.example.com']);
    expect(history[0].title).toBe('Site B');
    expect(history[0].visitCount).toBe(1);
  });

  it('dedupes by URL and bumps the visit count', () => {
    recordBrowserVisit('https://a.example.com', 'First', 1000);
    recordBrowserVisit('https://b.example.com', 'B', 1500);
    recordBrowserVisit('https://a.example.com', 'Second', 2000);

    const history = loadBrowserHistory();
    expect(history).toHaveLength(2);
    expect(history[0].url).toBe('https://a.example.com');
    expect(history[0].visitCount).toBe(2);
    expect(history[0].title).toBe('Second');
    expect(history[1].url).toBe('https://b.example.com');
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

  it('remembers local file paths and folder browsing', () => {
    recordBrowserVisit('file:///Users/me/notes.md', 'notes', 1000);
    expect(loadBrowserHistory()[0].url).toBe('file:///Users/me/notes.md');
    expect(displayHistoryUrl('file:///Users/me/notes.md')).toBe('/Users/me/notes.md');
  });

  it('name=searchHistory ranks host/URL prefix hits above loose matches', () => {
    recordBrowserVisit('https://github.com/markus/platform', 'Markus', 1000);
    recordBrowserVisit('https://docs.example.com/github-mirror', 'Mirror', 1000);
    const results = searchBrowserHistory('github');
    expect(results[0].url).toBe('https://github.com/markus/platform');
  });

  it('name=searchHistory requires every token to match', () => {
    recordBrowserVisit('https://github.com/markus/platform', 'Markus Platform', 1000);
    expect(searchBrowserHistory('github markus')).toHaveLength(1);
    expect(searchBrowserHistory('github nonexistent')).toHaveLength(0);
  });

  it('name=searchHistory matches the title too', () => {
    recordBrowserVisit('https://x.example.com/1', 'Quarterly Report', 1000);
    expect(searchBrowserHistory('quarterly')).toHaveLength(1);
  });

  it('returns recency order for an empty query', () => {
    recordBrowserVisit('https://old.example.com', undefined, 1000);
    recordBrowserVisit('https://new.example.com', undefined, 9000);
    expect(searchBrowserHistory('').map(h => h.url)).toEqual([
      'https://new.example.com',
      'https://old.example.com',
    ]);
  });

  it('removes a single entry and clears everything', () => {
    recordBrowserVisit('https://a.example.com', undefined, 1000);
    recordBrowserVisit('https://b.example.com', undefined, 2000);

    removeBrowserHistoryEntry('https://a.example.com');
    expect(loadBrowserHistory().map(h => h.url)).toEqual(['https://b.example.com']);

    clearBrowserHistory();
    expect(loadBrowserHistory()).toEqual([]);
  });

  it('notifies subscribers on record / remove / clear', () => {
    const seen: string[][] = [];
    const unsubscribe = subscribeBrowserHistory(entries => seen.push(entries.map(e => e.url)));

    recordBrowserVisit('https://a.example.com', undefined, 1000);
    recordBrowserVisit('https://b.example.com', undefined, 2000);
    removeBrowserHistoryEntry('https://b.example.com');
    clearBrowserHistory();

    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect(seen[seen.length - 1]).toEqual([]);
    unsubscribe();
  });

  it('normalizes protocol-relative input', () => {
    expect(normalizeHistoryUrl('//example.com/x')).toBe('https://example.com/x');
    expect(normalizeHistoryUrl('  https://example.com  ')).toBe('https://example.com');
  });

  it('survives corrupt stored JSON', () => {
    localStorage.setItem('markus:browser-history', '{not-json');
    expect(loadBrowserHistory()).toEqual([]);
    recordBrowserVisit('https://a.example.com', undefined, 1000);
    expect(loadBrowserHistory()).toHaveLength(1);
  });
});
