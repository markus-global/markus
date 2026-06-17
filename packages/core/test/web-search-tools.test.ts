import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSearchTool } from '../src/tools/web-search.js';

const DDG_LITE_HTML = `
<a rel="nofollow" href="https://example.com/page" class="result-link">Example Result</a>
<td class="result-snippet">A helpful snippet about example.</td>
`;

const DDG_HTML = `
<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ftest.com">Test Title</a>
<a class="result__snippet">Test snippet text</a>
`;

function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
  vi.stubGlobal('fetch', vi.fn((url: string | URL, init?: RequestInit) => {
    const urlStr = String(url);
    const result = handler(urlStr, init);
    return Promise.resolve(result);
  }));
}

describe('WebSearchTool', () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [
      'SERPER_API_KEY', 'TAVILY_API_KEY', 'BING_SEARCH_API_KEY',
      'GOOGLE_SEARCH_API_KEY', 'GOOGLE_SEARCH_CX', 'SERPAPI_API_KEY',
      'BRAVE_SEARCH_API_KEY', 'EXA_API_KEY', 'BOCHA_API_KEY',
      'HTTPS_PROXY', 'HTTP_PROXY',
    ]) {
      envBackup[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [key, val] of Object.entries(envBackup)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it('has expected name and required query parameter', () => {
    expect(WebSearchTool.name).toBe('web_search');
    expect(WebSearchTool.inputSchema.required).toContain('query');
  });

  it('returns Serper results when SERPER_API_KEY is configured', async () => {
    process.env.SERPER_API_KEY = 'serper-key';
    mockFetch((url) => {
      if (url.includes('serper.dev')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            organic: [{ title: 'Serper Hit', link: 'https://serper.example', snippet: 'From Serper' }],
          }),
        };
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = JSON.parse(await WebSearchTool.execute({ query: 'test query', maxResults: 3 }));
    expect(result.status).toBe('success');
    expect(result.results[0].title).toBe('Serper Hit');
    expect(result.count).toBe(1);
  });

  it('falls through to Tavily when Serper returns zero results', async () => {
    process.env.SERPER_API_KEY = 'serper-key';
    process.env.TAVILY_API_KEY = 'tavily-key';
    mockFetch((url) => {
      if (url.includes('serper.dev')) {
        return { ok: true, json: async () => ({ organic: [] }) };
      }
      if (url.includes('tavily.com')) {
        return {
          ok: true,
          json: async () => ({
            results: [{ title: 'Tavily Hit', url: 'https://tavily.example', content: 'Tavily snippet' }],
          }),
        };
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = JSON.parse(await WebSearchTool.execute({ query: 'fallback test' }));
    expect(result.status).toBe('success');
    expect(result.results[0].url).toBe('https://tavily.example');
  });

  it('uses Bing backend when configured', async () => {
    process.env.BING_SEARCH_API_KEY = 'bing-key';
    mockFetch((url) => {
      if (url.includes('bing.microsoft.com')) {
        return {
          ok: true,
          json: async () => ({
            webPages: { value: [{ name: 'Bing Hit', url: 'https://bing.example', snippet: 'Bing text' }] },
          }),
        };
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = JSON.parse(await WebSearchTool.execute({ query: 'bing query' }));
    expect(result.status).toBe('success');
    expect(result.results[0].title).toBe('Bing Hit');
  });

  it('uses Google Custom Search when configured', async () => {
    process.env.GOOGLE_SEARCH_API_KEY = 'google-key';
    process.env.GOOGLE_SEARCH_CX = 'cx-id';
    mockFetch((url) => {
      if (url.includes('googleapis.com/customsearch')) {
        return {
          ok: true,
          json: async () => ({
            items: [{ title: 'Google Hit', link: 'https://google.example', snippet: 'Google text' }],
          }),
        };
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = JSON.parse(await WebSearchTool.execute({ query: 'google query' }));
    expect(result.status).toBe('success');
    expect(result.results[0].url).toBe('https://google.example');
  });

  it('uses SerpAPI backend when configured', async () => {
    process.env.SERPAPI_API_KEY = 'serp-key';
    mockFetch((url) => {
      if (url.includes('serpapi.com')) {
        return {
          ok: true,
          json: async () => ({
            organic_results: [{ title: 'Serp Hit', link: 'https://serp.example', snippet: 'Serp text' }],
          }),
        };
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = JSON.parse(await WebSearchTool.execute({ query: 'serp query' }));
    expect(result.status).toBe('success');
    expect(result.results[0].title).toBe('Serp Hit');
  });

  it('uses Brave backend when configured', async () => {
    process.env.BRAVE_SEARCH_API_KEY = 'brave-key';
    mockFetch((url) => {
      if (url.includes('search.brave.com')) {
        return {
          ok: true,
          json: async () => ({
            web: { results: [{ title: 'Brave Hit', url: 'https://brave.example', description: 'Brave desc' }] },
          }),
        };
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = JSON.parse(await WebSearchTool.execute({ query: 'brave query' }));
    expect(result.status).toBe('success');
    expect(result.results[0].snippet).toBe('Brave desc');
  });

  it('uses Exa backend when configured', async () => {
    process.env.EXA_API_KEY = 'exa-key';
    mockFetch((url) => {
      if (url.includes('exa.ai')) {
        return {
          ok: true,
          json: async () => ({
            results: [{ title: 'Exa Hit', url: 'https://exa.example', text: 'Exa content' }],
          }),
        };
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = JSON.parse(await WebSearchTool.execute({ query: 'exa query' }));
    expect(result.status).toBe('success');
    expect(result.results[0].snippet).toBe('Exa content');
  });

  it('uses Bocha backend when configured', async () => {
    process.env.BOCHA_API_KEY = 'bocha-key';
    mockFetch((url) => {
      if (url.includes('bochaai.com')) {
        return {
          ok: true,
          json: async () => ({
            webPages: {
              value: [{ name: 'Bocha Hit', url: 'https://bocha.example', snippet: 'fallback', summary: 'Bocha summary' }],
            },
          }),
        };
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = JSON.parse(await WebSearchTool.execute({ query: 'bocha query' }));
    expect(result.status).toBe('success');
    expect(result.results[0].snippet).toBe('Bocha summary');
  });

  it('falls back to DuckDuckGo lite when no API keys are set', async () => {
    mockFetch((url) => {
      if (url.includes('lite.duckduckgo.com')) {
        return { ok: true, status: 200, statusText: 'OK', text: async () => DDG_LITE_HTML };
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = JSON.parse(await WebSearchTool.execute({ query: 'ddg lite' }));
    expect(result.status).toBe('success');
    expect(result.results[0].title).toBe('Example Result');
    expect(result.results[0].url).toBe('https://example.com/page');
  });

  it('falls back to DuckDuckGo html endpoint when lite returns no results', async () => {
    mockFetch((url) => {
      if (url.includes('lite.duckduckgo.com')) {
        return { ok: true, text: async () => '<html><body>no results</body></html>' };
      }
      if (url.includes('html.duckduckgo.com')) {
        return { ok: true, text: async () => DDG_HTML };
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = JSON.parse(await WebSearchTool.execute({ query: 'ddg html' }));
    expect(result.status).toBe('success');
    expect(result.results[0].title).toBe('Test Title');
  });

  it('returns error with network hints when all backends fail with network errors', async () => {
    process.env.SERPER_API_KEY = 'serper-key';
    mockFetch(() => {
      throw new Error('ECONNREFUSED');
    });

    const result = JSON.parse(await WebSearchTool.execute({ query: 'network fail' }));
    expect(result.status).toBe('error');
    expect(result.error).toContain('All search backends failed');
    expect(result.hints?.[0]).toContain('network');
  });

  it('reports HTTP errors from configured backends', async () => {
    process.env.SERPER_API_KEY = 'serper-key';
    process.env.TAVILY_API_KEY = 'tavily-key';
    mockFetch((url) => {
      if (url.includes('serper.dev') || url.includes('tavily.com')) {
        return { ok: false, status: 403, statusText: 'Forbidden' };
      }
      return { ok: false, status: 500, statusText: 'Error', text: async () => '' };
    });

    const result = JSON.parse(await WebSearchTool.execute({ query: 'http errors' }));
    expect(result.status).toBe('error');
    expect(result.details.length).toBeGreaterThan(0);
  });

  it('handles non-Error thrown values in backend catch', async () => {
    process.env.SERPER_API_KEY = 'serper-key';
    mockFetch(() => {
      throw 'string failure';
    });

    const result = JSON.parse(await WebSearchTool.execute({ query: 'string error' }));
    expect(result.status).toBe('error');
    expect(result.details.some((d: { error: string }) => d.error.includes('string failure'))).toBe(true);
  });
});
