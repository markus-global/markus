import type { AgentToolHandler } from '../agent.js';

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  date?: string;
}

const SEARCH_TIMEOUT_MS = 15_000;

// ── Proxy-aware fetch ──────────────────────────────────────────────────────

// Opaque handle — we only need to pass it through to fetch's `dispatcher` option.
let _dispatcher: Record<string, unknown> | undefined | false = false; // false = not yet resolved

async function resolveProxyDispatcher(): Promise<Record<string, unknown> | undefined> {
  if (_dispatcher !== false) return _dispatcher || undefined;
  const proxyUrl =
    process.env['HTTPS_PROXY'] || process.env['HTTP_PROXY'] ||
    process.env['https_proxy'] || process.env['http_proxy'];
  if (!proxyUrl) {
    _dispatcher = undefined;
    return undefined;
  }
  try {
    // Node.js 22+ re-exports undici; use indirect eval to dodge TS module resolution.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const load = new Function('id', 'return import(id)') as (id: string) => Promise<{ ProxyAgent: new (url: string) => Record<string, unknown> }>;
    const { ProxyAgent } = await load('undici');
    _dispatcher = new ProxyAgent(proxyUrl);
  } catch {
    _dispatcher = undefined;
  }
  return _dispatcher || undefined;
}

/**
 * Fetch wrapper that respects HTTPS_PROXY / HTTP_PROXY env vars (via undici
 * ProxyAgent on Node 22+) and enforces a default timeout.
 */
async function proxyFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const dispatcher = await resolveProxyDispatcher();
  const signal = init?.signal ?? AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  const opts: Record<string, unknown> = { ...init, signal };
  if (dispatcher) opts['dispatcher'] = dispatcher;
  return fetch(url, opts as RequestInit);
}

// ── Tool definition ────────────────────────────────────────────────────────

/**
 * Multi-backend web search tool.
 * Priority: Serper (Google) > Brave Search > Bocha > DuckDuckGo Lite/HTML fallback.
 * API keys are read from environment variables.
 */
export const WebSearchTool: AgentToolHandler = {
  name: 'web_search',
  description:
    'Search the web for real-time information. Returns search result titles, snippets, and URLs. ' +
    'Use this when you need up-to-date information that might not be in your training data.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of results to return (default: 8)',
      },
    },
    required: ['query'],
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const query = args['query'] as string;
    const maxResults = (args['maxResults'] as number) ?? 8;

    const backends: Array<{ name: string; fn: typeof searchSerper }> = [
      { name: 'Serper', fn: searchSerper },
      { name: 'Brave', fn: searchBrave },
      { name: 'Bocha', fn: searchBocha },
      { name: 'DuckDuckGo', fn: searchDuckDuckGo },
    ];
    const errors: Array<{ backend: string; error: string }> = [];

    for (const { name, fn } of backends) {
      try {
        const results = await fn(query, maxResults);
        if (results.length > 0) {
          return JSON.stringify({ status: 'success', query, results, count: results.length });
        }
        errors.push({ backend: name, error: 'Returned 0 results' });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ backend: name, error: message });
      }
    }

    const hasNetworkErr = errors.some(e => e.error.includes('Network error') || e.error.includes('timed out'));
    const hints: string[] = [];
    if (hasNetworkErr) {
      hints.push(
        'All search backends failed due to network issues. ' +
        'You can try using the web_fetch tool to fetch a search engine page directly (e.g. https://www.google.com/search?q=YOUR_QUERY or https://www.bing.com/search?q=YOUR_QUERY), ' +
        'or use the browser tool to perform the search interactively.',
      );
    }

    return JSON.stringify({
      status: 'error',
      error: 'All search backends failed.',
      details: errors,
      ...(hints.length > 0 ? { hints } : {}),
    });
  },
};

// ── Serper (Google) backend ────────────────────────────────────────────────

async function searchSerper(query: string, maxResults: number): Promise<SearchResult[]> {
  const apiKey = process.env['SERPER_API_KEY'];
  if (!apiKey) throw new Error('SERPER_API_KEY not configured');

  let res: Response;
  try {
    res = await proxyFetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: query, num: maxResults }),
    });
  } catch (err: unknown) {
    throw new Error(`Network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const data = (await res.json()) as {
    organic?: Array<{ title: string; link: string; snippet: string; date?: string }>;
  };

  return (data.organic ?? []).slice(0, maxResults).map(r => ({
    title: r.title,
    url: r.link,
    snippet: r.snippet,
    date: r.date,
  }));
}

// ── Brave Search backend ───────────────────────────────────────────────────

async function searchBrave(query: string, maxResults: number): Promise<SearchResult[]> {
  const apiKey = process.env['BRAVE_SEARCH_API_KEY'];
  if (!apiKey) throw new Error('BRAVE_SEARCH_API_KEY not configured');

  const params = new URLSearchParams({ q: query, count: String(maxResults) });
  let res: Response;
  try {
    res = await proxyFetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      },
    });
  } catch (err: unknown) {
    throw new Error(`Network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const data = (await res.json()) as {
    web?: { results?: Array<{ title: string; url: string; description: string; page_age?: string }> };
  };

  return (data.web?.results ?? []).slice(0, maxResults).map(r => ({
    title: r.title,
    url: r.url,
    snippet: r.description,
    date: r.page_age,
  }));
}

// ── Bocha (博查) backend ────────────────────────────────────────────────────

async function searchBocha(query: string, maxResults: number): Promise<SearchResult[]> {
  const apiKey = process.env['BOCHA_API_KEY'];
  if (!apiKey) throw new Error('BOCHA_API_KEY not configured');

  let res: Response;
  try {
    res = await proxyFetch('https://api.bochaai.com/v1/web-search', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, count: maxResults, summary: true }),
    });
  } catch (err: unknown) {
    throw new Error(`Network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const data = (await res.json()) as {
    webPages?: {
      value?: Array<{
        name: string;
        url: string;
        snippet: string;
        summary?: string;
        datePublished?: string;
      }>;
    };
  };

  return (data.webPages?.value ?? []).slice(0, maxResults).map(r => ({
    title: r.name,
    url: r.url,
    snippet: r.summary || r.snippet,
    date: r.datePublished,
  }));
}

// ── DuckDuckGo fallback (no API key) ───────────────────────────────────────

const DDG_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const DDG_ENDPOINTS = [
  'https://lite.duckduckgo.com/lite/',
  'https://html.duckduckgo.com/html/',
] as const;

/**
 * Try DuckDuckGo Lite first, then HTML endpoint. Both are scraped so neither
 * needs an API key. Each endpoint gets its own attempt with independent timeout.
 */
async function searchDuckDuckGo(query: string, maxResults: number): Promise<SearchResult[]> {
  const encoded = encodeURIComponent(query);
  let lastError: Error | undefined;

  for (const base of DDG_ENDPOINTS) {
    try {
      const res = await proxyFetch(`${base}?q=${encoded}`, {
        headers: { 'User-Agent': DDG_UA },
      });

      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status} ${res.statusText}`);
        continue;
      }

      const html = await res.text();
      const results = base.includes('lite')
        ? parseDDGLite(html, maxResults)
        : parseDDGHtml(html, maxResults);
      if (results.length > 0) return results;
      lastError = new Error(`Parsed 0 results from ${base}`);
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw new Error(`Network error: ${lastError?.message ?? 'all DuckDuckGo endpoints failed'}`);
}

// ── DDG HTML parsers ───────────────────────────────────────────────────────

function parseDDGLite(html: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];

  const linkRegex = /<a[^>]+rel="nofollow"[^>]*href="([^"]*)"[^>]*class="result-link"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRegex = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g;

  const links: Array<{ url: string; title: string }> = [];
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const url = match[1] ?? '';
    const title = stripHtml(match[2] ?? '');
    if (url && title) links.push({ url, title });
  }

  const snippets: string[] = [];
  while ((match = snippetRegex.exec(html)) !== null) {
    snippets.push(stripHtml(match[1] ?? ''));
  }

  if (links.length === 0) {
    const generalLink = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const seen = new Set<string>();
    while ((match = generalLink.exec(html)) !== null) {
      const url = match[1] ?? '';
      const title = stripHtml(match[2] ?? '');
      if (url && title && !seen.has(url) && !url.includes('duckduckgo.com')) {
        seen.add(url);
        links.push({ url, title });
      }
    }
  }

  for (let i = 0; i < Math.min(links.length, max); i++) {
    results.push({
      title: links[i]!.title,
      url: links[i]!.url,
      snippet: snippets[i] ?? '',
    });
  }

  return results;
}

function parseDDGHtml(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const linkRegex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  const links: Array<{ url: string; title: string }> = [];
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const url = decodeURIComponent((match[1] ?? '').replace(/.*uddg=/, '').replace(/&.*/, ''));
    const title = stripHtml(match[2] ?? '');
    if (url && title) links.push({ url, title });
  }

  const snippets: string[] = [];
  while ((match = snippetRegex.exec(html)) !== null) {
    snippets.push(stripHtml(match[1] ?? ''));
  }

  for (let i = 0; i < Math.min(links.length, maxResults); i++) {
    results.push({
      title: links[i]!.title,
      url: links[i]!.url,
      snippet: snippets[i] ?? '',
    });
  }

  return results;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
