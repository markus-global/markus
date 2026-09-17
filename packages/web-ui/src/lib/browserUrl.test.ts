import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  normalizeBrowserUrl,
  isLikelyUrl,
  resolveBrowserAddress,
  getSearchEngine,
  setSearchEngine,
  SEARCH_ENGINES,
  SEARCH_ENGINE_IDS,
} from './browserUrl.ts';

const STORAGE_KEY = 'markus:browser-search-engine';

// Node test env has no localStorage — provide a tiny in-memory shim.
function installStorageShim() {
  const store = new Map<string, string>();
  const stub = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
  vi.stubGlobal('localStorage', stub);
  return stub;
}

describe('isLikelyUrl — URL vs keyword classification', () => {
  it('treats explicit-scheme inputs as URLs (http/https/file/about/data/mailto)', () => {
    for (const url of [
      'https://example.com',
      'http://localhost:3000',
      'http://192.168.1.10:8080',
      'file:///tmp/a.txt',
      'file:/Users/me/notes.md',
      'about:blank',
      'data:text/plain,hello',
      'mailto:hi@example.com',
    ]) {
      expect(isLikelyUrl(url)).toBe(true);
    }
  });

  it('treats protocol-relative URLs as URLs', () => {
    expect(isLikelyUrl('//example.com/path')).toBe(true);
  });

  it('treats absolute filesystem paths as URLs', () => {
    for (const p of ['/Users/me/a.txt', 'C:\\tmp\\a.txt', '\\\\server\\share']) {
      expect(isLikelyUrl(p)).toBe(true);
    }
  });

  it('treats bare domain-like hosts as URLs (with port / path / query)', () => {
    for (const host of [
      'example.com',
      'example.com:8080',
      'example.com/path?q=1',
      'sub.example.co.uk',
      'my-server-1.local',
    ]) {
      expect(isLikelyUrl(host)).toBe(true);
    }
  });

  it('treats localhost and IP literals as URLs', () => {
    for (const host of ['localhost', 'localhost:3000', '127.0.0.1', '127.0.0.1:5173', '[::1]', '[::1]:8080']) {
      expect(isLikelyUrl(host)).toBe(true);
    }
  });

  it('treats keywords (spaces / single words / numeric-version / CJK) as non-URLs', () => {
    for (const kw of [
      'hello world',
      'markus 教程',
      '什么是AI',
      'react tutorial 2026',
      'markus',
      'vue',
      '3.14',
      '1.22',
      'v1.2',
      '明年 计划',
    ]) {
      expect(isLikelyUrl(kw)).toBe(false);
    }
  });

  it('treats empty/whitespace-only input as non-URL', () => {
    expect(isLikelyUrl('')).toBe(false);
    expect(isLikelyUrl('   ')).toBe(false);
  });
});

describe('resolveBrowserAddress — URL passthrough vs search routing', () => {
  it('passes explicit URLs through unchanged', () => {
    expect(resolveBrowserAddress('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
  });

  it('normalizes bare domains to https', () => {
    expect(resolveBrowserAddress('example.com')).toBe('https://example.com');
  });

  it('uses http for localhost / IP literals so dev servers work', () => {
    expect(resolveBrowserAddress('localhost:3000')).toBe('http://localhost:3000');
    expect(resolveBrowserAddress('127.0.0.1:5173')).toBe('http://127.0.0.1:5173');
  });

  it('keeps filesystem paths as file:// URLs', () => {
    expect(resolveBrowserAddress('/Users/me/a.txt')).toBe('file:///Users/me/a.txt');
  });

  it('routes keywords to the default search engine (Bing)', () => {
    expect(resolveBrowserAddress('hello world')).toBe('https://www.bing.com/search?q=hello%20world');
    expect(resolveBrowserAddress('什么是AI')).toBe(
      `https://www.bing.com/search?q=${encodeURIComponent('什么是AI')}`,
    );
  });

  it('respects an explicit engine override', () => {
    expect(resolveBrowserAddress('react', 'google')).toBe('https://www.google.com/search?q=react');
  });

  it('returns trimmed empty input unchanged', () => {
    expect(resolveBrowserAddress('')).toBe('');
    expect(resolveBrowserAddress('   ')).toBe('');
  });

  it('encodes query punctuation (+, &, #, ?)', () => {
    expect(resolveBrowserAddress('a+b & c#d', 'google')).toContain('q=a%2Bb%20%26%20c%23d');
  });
});

describe('search engine configuration', () => {
  let shim: { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void; clear: () => void };

  beforeEach(() => {
    shim = installStorageShim();
  });
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('registers the core engines', () => {
    expect(SEARCH_ENGINE_IDS).toContain('bing');
    expect(SEARCH_ENGINE_IDS).toContain('google');
    expect(SEARCH_ENGINE_IDS).toContain('duckduckgo');
    expect(SEARCH_ENGINES.bing.searchUrl('x')).toBe('https://www.bing.com/search?q=x');
    expect(SEARCH_ENGINES.google.searchUrl('x')).toBe('https://www.google.com/search?q=x');
    expect(SEARCH_ENGINES.duckduckgo.searchUrl('x')).toBe('https://duckduckgo.com/?q=x');
  });

  it('registers international engines (baidu / yandex / sogou / so360)', () => {
    expect(SEARCH_ENGINE_IDS).toContain('baidu');
    expect(SEARCH_ENGINE_IDS).toContain('yandex');
    expect(SEARCH_ENGINE_IDS).toContain('sogou');
    expect(SEARCH_ENGINE_IDS).toContain('so360');
    expect(SEARCH_ENGINES.baidu.searchUrl('AI')).toBe('https://www.baidu.com/s?wd=AI');
    expect(SEARCH_ENGINES.yandex.searchUrl('AI')).toBe('https://yandex.com/search/?text=AI');
    expect(SEARCH_ENGINES.sogou.searchUrl('AI')).toBe('https://www.sogou.com/web?query=AI');
    expect(SEARCH_ENGINES.so360.searchUrl('AI')).toBe('https://www.so.com/s?q=AI');
  });

  it('registers privacy engines (brave)', () => {
    expect(SEARCH_ENGINE_IDS).toContain('brave');
    expect(SEARCH_ENGINES.brave.searchUrl('AI')).toBe('https://search.brave.com/search?q=AI');
  });

  it('defaults to bing when nothing is saved', () => {
    expect(getSearchEngine()).toBe('bing');
  });

  it('persists a chosen engine and reads it back', () => {
    setSearchEngine('google');
    expect(shim.getItem(STORAGE_KEY)).toBe('google');
    expect(getSearchEngine()).toBe('google');
    expect(resolveBrowserAddress('markus')).toBe('https://www.google.com/search?q=markus');
  });

  it('falls back to default when the saved value is invalid', () => {
    shim.setItem(STORAGE_KEY, 'netscape');
    expect(getSearchEngine()).toBe('bing');
  });

  it('ignores writes for unknown engine ids', () => {
    setSearchEngine('netscape');
    expect(shim.getItem(STORAGE_KEY)).toBeNull();
    expect(getSearchEngine()).toBe('bing');
  });
});