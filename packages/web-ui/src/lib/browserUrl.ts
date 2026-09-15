/**
 * Address-bar / navigate input resolution for the embedded browser.
 *
 * T1 (ui-optimize-0913): address-bar input that is NOT a URL is treated as a
 * keyword query and routed to a configurable default search engine
 * (Bing/Google/DuckDuckGo) instead of being forced into a broken https:// URL.
 */

export type SearchEngineId =
  | 'bing'
  | 'google'
  | 'duckduckgo'
  | 'baidu'
  | 'yandex'
  | 'brave'
  | 'ecosia'
  | 'sogou'
  | 'so360';

export interface SearchEngine {
  id: SearchEngineId;
  name: string;
  /** Build a results URL for a free-text query. */
  searchUrl: (query: string) => string;
}

export const SEARCH_ENGINES: Record<SearchEngineId, SearchEngine> = {
  bing: {
    id: 'bing',
    name: 'Bing',
    searchUrl: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
  },
  google: {
    id: 'google',
    name: 'Google',
    searchUrl: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  },
  duckduckgo: {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    searchUrl: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
  },
  baidu: {
    id: 'baidu',
    name: 'Baidu',
    searchUrl: (q) => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}`,
  },
  yandex: {
    id: 'yandex',
    name: 'Yandex',
    searchUrl: (q) => `https://yandex.com/search/?text=${encodeURIComponent(q)}`,
  },
  brave: {
    id: 'brave',
    name: 'Brave',
    searchUrl: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}`,
  },
  ecosia: {
    id: 'ecosia',
    name: 'Ecosia',
    searchUrl: (q) => `https://www.ecosia.org/search?q=${encodeURIComponent(q)}`,
  },
  sogou: {
    id: 'sogou',
    name: 'Sogou',
    searchUrl: (q) => `https://www.sogou.com/web?query=${encodeURIComponent(q)}`,
  },
  so360: {
    id: 'so360',
    name: '360 Search',
    searchUrl: (q) => `https://www.so.com/s?q=${encodeURIComponent(q)}`,
  },
};

export const SEARCH_ENGINE_IDS = Object.keys(SEARCH_ENGINES) as SearchEngineId[];

export const DEFAULT_SEARCH_ENGINE: SearchEngineId = 'bing';

const SEARCH_ENGINE_STORAGE_KEY = 'markus:browser-search-engine';

/** Current default search engine, persisted in localStorage (per browser/device). */
export function getSearchEngine(): SearchEngineId {
  try {
    const saved = localStorage.getItem(SEARCH_ENGINE_STORAGE_KEY);
    if (saved && SEARCH_ENGINES[saved as SearchEngineId]) return saved as SearchEngineId;
  } catch {
    // localStorage unavailable (SSR / private mode / tests) → default
  }
  return DEFAULT_SEARCH_ENGINE;
}

/** Persist the user's default search engine. Unknown ids are ignored. */
export function setSearchEngine(id: string): void {
  if (!SEARCH_ENGINES[id as SearchEngineId]) return;
  try {
    localStorage.setItem(SEARCH_ENGINE_STORAGE_KEY, id);
  } catch {
    // best-effort persistence
  }
}

/**
 * Decide whether address-bar input "is a URL" or should be searched.
 * - explicit scheme (http/https/file/data/mailto/…) → URL
 * - protocol-relative (//host) → URL
 * - absolute filesystem path → URL (file://)
 * - localhost[:port], IP literals → URL
 * - bare domain-like host (has a dot, no whitespace) → URL guess
 * - everything else (spaces, single words, CJK, versions) → keyword → search
 */
export function isLikelyUrl(raw: string): boolean {
  const next = raw.trim();
  if (!next) return false;
  if (next === 'about:blank') return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(next)) return true;
  if (next.startsWith('//')) return true;
  if (isAbsoluteFilesystemPath(next)) return true;
  if (/^localhost(:\d+)?([/?#].*)?$/i.test(next)) return true;
  if (isIpLiteral(next)) return true;
  if (!/\s/.test(next) && looksLikeDomain(next)) return true;
  return false;
}

/**
 * Resolve address-bar input to a navigable URL.
 * URL-like input → normalized URL; anything else → search-engine results URL.
 */
export function resolveBrowserAddress(raw: string, engine?: SearchEngineId): string {
  const next = raw.trim();
  if (!next) return next;
  if (isLikelyUrl(next)) return normalizeBrowserUrl(next);
  return SEARCH_ENGINES[engine ?? getSearchEngine()].searchUrl(next);
}

function isIpLiteral(input: string): boolean {
  // IPv4: four 1-3 digit octets, optional :port / path / query.
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#].*)?$/.test(input)) return true;
  // Bracketed IPv6: [::1], [2001:db8::1]:8080
  if (/^\[[0-9a-fA-F:.]+\](:\d+)?([/?#].*)?$/.test(input)) return true;
  return false;
}

function looksLikeDomain(input: string): boolean {
  // Strip optional port and path/query to inspect the host part only.
  const host = input.split(/[/?#]/)[0].replace(/:\d+$/, '');
  if (!host) return false;
  const labels = host.split('.');
  if (labels.length < 2) return false;
  // Reject version-like tokens (3.14, 1.22, v1.2) — they should be searched.
  if (/^v?\d/i.test(host) && /^\d+(\.\d+)*$/.test(host.replace(/^v/i, ''))) return false;
  // Domain labels: alnum + hyphen, separated by dots.
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(host);
}

/**
 * Normalize address-bar / navigate input for the embedded browser.
 * Supports http(s), file://, about:blank, and bare filesystem paths.
 */
export function normalizeBrowserUrl(raw: string): string {
  const next = raw.trim();
  if (!next) return next;
  if (next === 'about:blank') return next;

  // localhost / IP literals (with optional port) → http://host:port.
  // MUST run before the generic scheme check: "localhost:3000" would otherwise
  // be misparsed as scheme "localhost:" with opaque path "3000".
  if (isLocalDevHost(next)) {
    return `http://${next}`;
  }

  // Already has a URI scheme (http, https, file, data, …).
  if (/^[a-z][a-z0-9+.-]*:/i.test(next)) {
    if (/^file:/i.test(next)) return normalizeFileUrl(next);
    return next;
  }

  // Protocol-relative URL.
  if (next.startsWith('//')) return `https:${next}`;

  // Absolute local paths → file://
  if (isAbsoluteFilesystemPath(next)) {
    return pathToFileUrl(next);
  }

  // Bare domain-like host → https
  return `https://${next}`;
}

function isLocalDevHost(input: string): boolean {
  if (/^localhost(:\d+)?([/?#].*)?$/i.test(input)) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#].*)?$/.test(input)) return true;
  if (/^\[[0-9a-fA-F:.]+\](:\d+)?([/?#].*)?$/.test(input)) return true;
  return false;
}

function isAbsoluteFilesystemPath(input: string): boolean {
  if (input.startsWith('/')) return true;
  if (/^[a-zA-Z]:[\\/]/.test(input)) return true;
  if (input.startsWith('\\\\')) return true;
  return false;
}

function pathToFileUrl(absPath: string): string {
  const p = absPath.replace(/\\/g, '/');
  // UNC \\server\share → file://server/share
  if (p.startsWith('//')) {
    return `file:${encodePathKeepSlashes(p)}`;
  }
  // Windows drive letter
  if (/^[a-zA-Z]:\//.test(p)) {
    return `file:///${encodePathKeepSlashes(p)}`;
  }
  // POSIX absolute
  return `file://${encodePathKeepSlashes(p)}`;
}

function normalizeFileUrl(input: string): string {
  try {
    return new URL(input).href;
  } catch {
    // Repair file:/Users/... or file:C:/... (missing slashes)
    let rest = input.replace(/^file:/i, '').replace(/\\/g, '/');
    if (rest.startsWith('//')) {
      // file://host/path or file:///path — drop authority slash pair
      rest = rest.replace(/^\/\/(localhost)?/i, '');
      if (!rest.startsWith('/') && !/^[a-zA-Z]:\//.test(rest)) rest = `/${rest}`;
    }
    if (/^\/[a-zA-Z]:\//.test(rest)) rest = rest.slice(1);
    if (!rest.startsWith('/') && !/^[a-zA-Z]:\//.test(rest)) rest = `/${rest}`;
    return pathToFileUrl(rest);
  }
}

/** encodeURI keeps `/`; still escape `#` which would truncate the path. */
function encodePathKeepSlashes(p: string): string {
  return encodeURI(p).replace(/#/g, '%23');
}
