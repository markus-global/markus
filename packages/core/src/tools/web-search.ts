import type { AgentToolHandler } from '../agent.js';

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  date?: string;
}

/**
 * Multi-backend web search tool.
 * Priority: Serper (Google) > Brave Search > DuckDuckGo Lite fallback.
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

    // Try backends in priority order
    const backends = [searchSerper, searchBrave, searchDuckDuckGoLite];
    for (const backend of backends) {
      try {
        const results = await backend(query, maxResults);
        if (results.length > 0) {
          return JSON.stringify({ status: 'success', query, results, count: results.length });
        }
      } catch {
        // try next backend
      }
    }

    return JSON.stringify({
      status: 'error',
      error: 'All search backends failed. Configure SERPER_API_KEY or BRAVE_SEARCH_API_KEY for better results.',
    });
  },
};

async function searchSerper(query: string, maxResults: number): Promise<SearchResult[]> {
  const apiKey = process.env['SERPER_API_KEY'];
  if (!apiKey) throw new Error('No SERPER_API_KEY');

  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ q: query, num: maxResults }),
  });

  if (!res.ok) throw new Error(`Serper HTTP ${res.status}`);

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

async function searchBrave(query: string, maxResults: number): Promise<SearchResult[]> {
  const apiKey = process.env['BRAVE_SEARCH_API_KEY'];
  if (!apiKey) throw new Error('No BRAVE_SEARCH_API_KEY');

  const params = new URLSearchParams({ q: query, count: String(maxResults) });
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey,
    },
  });

  if (!res.ok) throw new Error(`Brave HTTP ${res.status}`);

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

/**
 * DuckDuckGo Lite fallback — no API key required.
 * Uses the lightweight HTML version which is more stable than the full HTML endpoint.
 */
async function searchDuckDuckGoLite(query: string, maxResults: number): Promise<SearchResult[]> {
  const encoded = encodeURIComponent(query);

  // Try the lite endpoint first (table-based, very stable HTML)
  const res = await fetch(`https://lite.duckduckgo.com/lite/?q=${encoded}`, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });

  if (!res.ok) {
    // Fallback to the HTML endpoint
    return searchDuckDuckGoHtml(query, maxResults);
  }

  const html = await res.text();
  return parseDDGLite(html, maxResults);
}

function parseDDGLite(html: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];

  // DDG Lite uses a table layout. Each result is in a <tr> with class "result-link" and "result-snippet"
  // The structure is: link row, then snippet row, then spacer row
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

  // If DDG Lite parsing yields nothing, try the general anchor approach
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

async function searchDuckDuckGoHtml(query: string, maxResults: number): Promise<SearchResult[]> {
  const encoded = encodeURIComponent(query);
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encoded}`, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });

  if (!res.ok) throw new Error(`DDG HTML HTTP ${res.status}`);

  const html = await res.text();
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
