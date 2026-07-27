import type { AgentToolHandler } from '../agent.js';

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  date?: string;
}

const SEARCH_TIMEOUT_MS = 15_000;

// ── Proxy-aware fetch ──────────────────────────────────────────────────────

const NOT_RESOLVED = Symbol('not-resolved');
let _dispatcher: Record<string, unknown> | undefined | typeof NOT_RESOLVED = NOT_RESOLVED;

async function resolveProxyDispatcher(): Promise<Record<string, unknown> | undefined> {
  if (_dispatcher !== NOT_RESOLVED) return _dispatcher;
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
  return _dispatcher;
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
 * Priority is conditional:
 *   - Hub connected and CU remaining > 0 → Markus hosted first, then BYOK
 *   - otherwise → BYOK first, then Markus (if configured)
 * Only backends whose keys are actually configured are attempted — unconfigured
 * providers are skipped entirely.
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
        description: 'Maximum number of results to return (default: 5)',
      },
    },
    required: ['query'],
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const query = args['query'] as string;
    const maxResults = (args['maxResults'] as number) ?? 5;

    // A provider can be turned off from settings even when a key is present.
    // The disabled ids are propagated via SEARCH_DISABLED_PROVIDERS (comma list).
    const disabled = new Set(
      (process.env['SEARCH_DISABLED_PROVIDERS'] || '')
        .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    );
    const on = (id: string) => !disabled.has(id);

    const byokDefs: Array<{ name: string; fn: typeof searchSerper; configured: () => boolean }> = [
      { name: 'Serper', fn: searchSerper, configured: () => on('serper') && !!process.env['SERPER_API_KEY'] },
      { name: 'Tavily', fn: searchTavily, configured: () => on('tavily') && !!process.env['TAVILY_API_KEY'] },
      { name: 'Bing', fn: searchBing, configured: () => on('bing') && !!process.env['BING_SEARCH_API_KEY'] },
      { name: 'Google', fn: searchGoogle, configured: () => on('google') && !!process.env['GOOGLE_SEARCH_API_KEY'] && !!process.env['GOOGLE_SEARCH_CX'] },
      { name: 'SerpAPI', fn: searchSerpApi, configured: () => on('serpapi') && !!process.env['SERPAPI_API_KEY'] },
      { name: 'Brave', fn: searchBrave, configured: () => on('brave') && !!process.env['BRAVE_SEARCH_API_KEY'] },
      { name: 'Exa', fn: searchExa, configured: () => on('exa') && !!process.env['EXA_API_KEY'] },
      { name: 'Bocha', fn: searchBocha, configured: () => on('bocha') && !!process.env['BOCHA_API_KEY'] },
    ];
    const markusConfigured =
      on('markus')
      && !!resolveMarkusOrKey()
      && process.env['MARKUS_SEARCH_ENABLED'] !== '0';
    const byokBackends = byokDefs.filter(b => b.configured()).map(b => ({ name: b.name, fn: b.fn }));
    const markusBackend = markusConfigured ? [{ name: 'Markus', fn: searchMarkus }] : [];
    // Prefer Markus only when Hub is connected and remaining CU is known and > 0.
    // Zero / unknown / disconnected → BYOK first (avoid burning empty balance).
    const preferMarkus = shouldPreferMarkusSearch();

    const backends: Array<{ name: string; fn: typeof searchSerper }> = preferMarkus
      ? [...markusBackend, ...byokBackends]
      : [...byokBackends, ...markusBackend];
    if (backends.length === 0) {
      return JSON.stringify({
        status: 'error',
        error: 'No search backends configured.',
        hints: [
          'Enable Markus hosted search or add a BYOK search API key in Settings → Web Search. ' +
          'You can also use web_fetch or browser tools to retrieve web content directly.',
        ],
      });
    }
    const errors: Array<{ backend: string; error: string }> = [];

    for (const { name, fn } of backends) {
      try {
        const results = await fn(query, maxResults);
        if (results.length > 0) {
          // Trim snippets so the expensive main chat model reads less context.
          const trimmed = results.map(r => ({
            ...r,
            snippet: r.snippet.length > 280 ? `${r.snippet.slice(0, 277)}...` : r.snippet,
          }));
          return JSON.stringify({ status: 'success', query, results: trimmed, count: trimmed.length });
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
        'or use browser tools (browser_navigate, browser_snapshot) if available via the chrome-devtools skill to perform the search interactively.',
      );
    } else {
      hints.push(
        'All search backends returned no results. Try alternative queries, broader terms, or use web_fetch to fetch a search engine results page directly. ' +
        'If you have browser tools available (via the chrome-devtools skill), you can use browser_navigate and browser_snapshot to access web content interactively — ' +
        'this is especially useful for JS-rendered pages, rate-limited sites, or when search API keys are not configured.',
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

// ── Tavily backend ────────────────────────────────────────────────────────

async function searchTavily(query: string, maxResults: number): Promise<SearchResult[]> {
  const apiKey = process.env['TAVILY_API_KEY'];
  if (!apiKey) throw new Error('TAVILY_API_KEY not configured');

  let res: Response;
  try {
    res = await proxyFetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: maxResults,
        include_answer: false,
      }),
    });
  } catch (err: unknown) {
    throw new Error(`Network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const data = (await res.json()) as {
    results?: Array<{ title: string; url: string; content: string; published_date?: string }>;
  };

  return (data.results ?? []).slice(0, maxResults).map(r => ({
    title: r.title,
    url: r.url,
    snippet: r.content,
    date: r.published_date,
  }));
}

// ── Bing Web Search backend ──────────────────────────────────────────────

async function searchBing(query: string, maxResults: number): Promise<SearchResult[]> {
  const apiKey = process.env['BING_SEARCH_API_KEY'];
  if (!apiKey) throw new Error('BING_SEARCH_API_KEY not configured');

  const params = new URLSearchParams({ q: query, count: String(maxResults), mkt: 'en-US' });
  let res: Response;
  try {
    res = await proxyFetch(`https://api.bing.microsoft.com/v7.0/search?${params}`, {
      headers: { 'Ocp-Apim-Subscription-Key': apiKey },
    });
  } catch (err: unknown) {
    throw new Error(`Network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const data = (await res.json()) as {
    webPages?: {
      value?: Array<{ name: string; url: string; snippet: string; dateLastCrawled?: string }>;
    };
  };

  return (data.webPages?.value ?? []).slice(0, maxResults).map(r => ({
    title: r.name,
    url: r.url,
    snippet: r.snippet,
    date: r.dateLastCrawled,
  }));
}

// ── Google Custom Search (Programmable Search Engine) backend ─────────────

async function searchGoogle(query: string, maxResults: number): Promise<SearchResult[]> {
  const apiKey = process.env['GOOGLE_SEARCH_API_KEY'];
  const cx = process.env['GOOGLE_SEARCH_CX'];
  if (!apiKey) throw new Error('GOOGLE_SEARCH_API_KEY not configured');
  if (!cx) throw new Error('GOOGLE_SEARCH_CX not configured');

  const params = new URLSearchParams({
    key: apiKey,
    cx,
    q: query,
    num: String(Math.min(maxResults, 10)),
  });
  let res: Response;
  try {
    res = await proxyFetch(`https://www.googleapis.com/customsearch/v1?${params}`);
  } catch (err: unknown) {
    throw new Error(`Network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const data = (await res.json()) as {
    items?: Array<{ title: string; link: string; snippet: string; pagemap?: { metatags?: Array<{ 'article:published_time'?: string }> } }>;
  };

  return (data.items ?? []).slice(0, maxResults).map(r => ({
    title: r.title,
    url: r.link,
    snippet: r.snippet,
    date: r.pagemap?.metatags?.[0]?.['article:published_time'],
  }));
}

// ── SerpAPI backend ──────────────────────────────────────────────────────

async function searchSerpApi(query: string, maxResults: number): Promise<SearchResult[]> {
  const apiKey = process.env['SERPAPI_API_KEY'];
  if (!apiKey) throw new Error('SERPAPI_API_KEY not configured');

  const params = new URLSearchParams({
    api_key: apiKey,
    q: query,
    engine: 'google',
    num: String(maxResults),
  });
  let res: Response;
  try {
    res = await proxyFetch(`https://serpapi.com/search.json?${params}`);
  } catch (err: unknown) {
    throw new Error(`Network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const data = (await res.json()) as {
    organic_results?: Array<{ title: string; link: string; snippet: string; date?: string }>;
  };

  return (data.organic_results ?? []).slice(0, maxResults).map(r => ({
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

// ── Exa (AI-native search) backend ──────────────────────────────────────────

async function searchExa(query: string, maxResults: number): Promise<SearchResult[]> {
  const apiKey = process.env['EXA_API_KEY'];
  if (!apiKey) throw new Error('EXA_API_KEY not configured');

  let res: Response;
  try {
    res = await proxyFetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        numResults: maxResults,
        type: 'auto',
        contents: { text: { maxCharacters: 300 } },
      }),
    });
  } catch (err: unknown) {
    throw new Error(`Network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const data = (await res.json()) as {
    results?: Array<{ title: string; url: string; text?: string; publishedDate?: string }>;
  };

  return (data.results ?? []).slice(0, maxResults).map(r => ({
    title: r.title,
    url: r.url,
    snippet: r.text ?? '',
    date: r.publishedDate,
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

// ── Markus Cloud search (OpenRouter member key, client-direct) ─────────────

export type MarkusSearchProviderId = 'bocha' | 'tavily';

/** Legacy helper kept for Settings UI / tests (no longer affects hosted search). */
export function resolveMarkusSearchProvider(
  opts?: { markusProvider?: string; language?: string },
): MarkusSearchProviderId {
  const override = (
    opts?.markusProvider
    || process.env['MARKUS_SEARCH_PROVIDER']
    || ''
  ).trim().toLowerCase();
  if (override === 'bocha' || override === 'tavily') return override;

  const lang = (
    opts?.language
    || process.env['MARKUS_SEARCH_LANGUAGE']
    || ''
  ).trim().toLowerCase();
  if (lang.startsWith('zh')) return 'bocha';
  return 'tavily';
}

function resolveMarkusOrKey(): string {
  const key = (
    process.env['MARKUS_OPENROUTER_KEY']
    || process.env['OPENROUTER_API_KEY']
    || ''
  ).trim();
  if (key.startsWith('sk-or-') || (key && !/^markus[_-]/i.test(key))) return key;
  return '';
}

/** Hub connected + remaining CU > 0 → try Markus search before BYOK. */
export function shouldPreferMarkusSearch(): boolean {
  const hubConnected = !!(
    process.env['MARKUS_HUB_TOKEN']?.trim()
    || process.env['MARKUS_OPENROUTER_KEY']?.trim()
  );
  if (!hubConnected) return false;
  const raw = process.env['MARKUS_CU_REMAINING'];
  if (raw === undefined || raw === '') return false;
  const remaining = Number(raw);
  return Number.isFinite(remaining) && remaining > 0;
}

function resolveMarkusOrBase(): string {
  const base = (process.env['MARKUS_OPENROUTER_BASE'] || process.env['OPENROUTER_BASE_URL'] || 'https://openrouter.ai/api/v1')
    .trim()
    .replace(/\/+$/, '');
  return base || 'https://openrouter.ai/api/v1';
}

function parseSearchJson(content: string, count: number): SearchResult[] {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? content).trim();
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const arr = JSON.parse(candidate.slice(start, end + 1)) as Array<Record<string, unknown>>;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(r => typeof r.url === 'string' && r.url)
      .slice(0, count)
      .map(r => ({
        title: String(r.title || r.url),
        url: String(r.url),
        snippet: String(r.snippet ?? r.description ?? ''),
        date: typeof r.date === 'string' ? r.date : undefined,
      }));
  } catch {
    return [];
  }
}

/**
 * Markus Cloud search via OpenRouter with the Hub-issued member key.
 * Bills against the same OR key USD limit as chat (Hub reconcile).
 */
async function searchMarkus(query: string, maxResults: number): Promise<SearchResult[]> {
  const key = resolveMarkusOrKey();
  if (!key) throw new Error('OpenRouter member key not configured — reconnect to Hub');
  if (process.env['MARKUS_SEARCH_ENABLED'] === '0') {
    throw new Error('Markus-hosted search disabled');
  }

  const capped = Math.max(1, Math.min(25, Math.round(maxResults)));
  const base = resolveMarkusOrBase();
  const model = process.env['MARKUS_SEARCH_OR_MODEL'] || 'perplexity/sonar';

  let res: Response;
  try {
    res = await proxyFetch(`${base}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(60_000),
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://markus.global',
        'X-Title': 'Markus',
        'X-Markus-Client': 'markus-desktop/1.0',
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content:
              `Web search. Return up to ${capped} results as a JSON array of objects with keys title, url, snippet. ` +
              `Query: ${query}`,
          },
        ],
        temperature: 0.2,
        max_tokens: 2048,
      }),
    });
  } catch (err: unknown) {
    throw new Error(`Network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  const bodyText = await res.text().catch(() => '');
  if (!res.ok) {
    // OpenRouter 402 = payment_required; 429 = rate limit (not credits). Prefer explicit
    // credit wording so a transient upstream 402 is not always "credits exhausted".
    if (
      /CU_EXCEEDED|CU_MONTHLY_EXCEEDED/i.test(bodyText)
      || (res.status === 402 && /insufficient (credits?|quota|balance)|key limit exceeded|payment_required|credits? (exhausted|exceeded)/i.test(bodyText || 'payment_required'))
    ) {
      throw new Error('CU_EXCEEDED: Credits exhausted. Please top up or upgrade your plan.');
    }
    if (res.status === 429) {
      throw new Error(`MARKUS_RATE_LIMITED: ${bodyText.slice(0, 200) || 'Rate limit exceeded'}`);
    }
    let detail = '';
    try {
      const parsed = JSON.parse(bodyText) as { error?: { message?: string }; message?: string };
      detail = parsed.error?.message || parsed.message || '';
    } catch { /* ignore */ }
    detail = detail.replace(/https?:\/\/[^\s]*openrouter\.ai[^\s]*/gi, '').trim();
    throw new Error(
      detail
        ? `HTTP ${res.status} ${res.statusText}: ${detail}`
        : `HTTP ${res.status} ${res.statusText}`,
    );
  }

  let content = '';
  try {
    const data = JSON.parse(bodyText) as {
      choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
      citations?: string[];
    };
    const raw = data.choices?.[0]?.message?.content;
    if (typeof raw === 'string') content = raw;
    else if (Array.isArray(raw)) content = raw.map(p => (typeof p === 'string' ? p : p.text ?? '')).join('');

    const parsed = parseSearchJson(content, capped);
    if (parsed.length > 0) return parsed;

    const citations = data.citations ?? [];
    if (citations.length > 0) {
      return citations.slice(0, capped).map((url, i) => ({
        title: url,
        url,
        snippet: content.slice(0, 280) || `Result ${i + 1}`,
      }));
    }
  } catch { /* fall through */ }

  if (content.trim()) {
    return [{ title: query, url: 'about:blank', snippet: content.slice(0, 500) }];
  }
  throw new Error('Empty search response');
}

// ── Connectivity test ──────────────────────────────────────────────────────

export interface SearchProviderTestResult {
  ok: boolean;
  /** Round-trip latency in milliseconds. */
  latencyMs?: number;
  /** Number of results returned by the probe query. */
  count?: number;
  /** First result, as a small proof the backend works. */
  sample?: { title: string; url: string };
  error?: string;
}

/** Maps a settings provider id to its backend implementation. */
const TEST_BACKENDS: Record<string, (query: string, maxResults: number) => Promise<SearchResult[]>> = {
  serper: searchSerper,
  tavily: searchTavily,
  bing: searchBing,
  google: searchGoogle,
  serpapi: searchSerpApi,
  brave: searchBrave,
  exa: searchExa,
  bocha: searchBocha,
  markus: searchMarkus,
};

/**
 * Probe a single search backend with a fixed query so the UI can tell the user
 * whether their key works — analogous to the "reply hello" LLM connectivity test.
 *
 * `overrides` are applied to `process.env` for the duration of the call (and then
 * restored), letting callers test an unsaved key or inject the Markus subscription
 * key resolved from config.
 */
export async function testSearchProvider(
  provider: string,
  overrides?: Record<string, string | undefined>,
): Promise<SearchProviderTestResult> {
  const fn = TEST_BACKENDS[provider];
  if (!fn) return { ok: false, error: `Unknown search provider: ${provider}` };

  const saved: Record<string, string | undefined> = {};
  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      saved[k] = process.env[k];
      if (v === undefined || v === '') delete process.env[k];
      else process.env[k] = v;
    }
  }

  const started = Date.now();
  try {
    const results = await fn('hello world', 3);
    const latencyMs = Date.now() - started;
    if (results.length === 0) {
      return { ok: false, latencyMs, error: 'No results returned — the key may be invalid or the quota exhausted.' };
    }
    const first = results[0]!;
    return { ok: true, latencyMs, count: results.length, sample: { title: first.title, url: first.url } };
  } catch (err: unknown) {
    return { ok: false, latencyMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

