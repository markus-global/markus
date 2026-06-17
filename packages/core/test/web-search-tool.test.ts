import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSearchTool } from '../src/tools/web-search.js';

describe('WebSearchTool', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...origEnv };
  });

  it('has correct tool metadata', () => {
    expect(WebSearchTool.name).toBe('web_search');
    expect(WebSearchTool.description).toContain('Search the web');
    expect(WebSearchTool.inputSchema.required).toContain('query');
  });

  it('validates missing query', async () => {
    const result = await WebSearchTool.execute({});
    expect(result).toContain('error');
  });

  it('uses DuckDuckGo when no API keys are set', async () => {
    delete process.env['SERPER_API_KEY'];
    delete process.env['TAVILY_API_KEY'];
    delete process.env['BING_SEARCH_API_KEY'];
    delete process.env['GOOGLE_SEARCH_API_KEY'];
    delete process.env['SERPAPI_API_KEY'];
    delete process.env['BRAVE_SEARCH_API_KEY'];
    delete process.env['EXA_API_KEY'];
    delete process.env['BOCHA_API_KEY'];

    // DuckDuckGo scrapes HTML, not JSON
    const ddgHtml = `<html><body>
      <a rel="nofollow" href="https://example.com" class="result-link">Test Result</a>
      <td class="result-snippet">A snippet about the test</td>
    </body></html>`;
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => ddgHtml,
    });

    const result = await WebSearchTool.execute({ query: 'test query', maxResults: 5 });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('success');
    expect(parsed.results.length).toBeGreaterThan(0);
  });

  it('uses Serper when SERPER_API_KEY is set', async () => {
    process.env['SERPER_API_KEY'] = 'test-key';

    const mockResponse = {
      ok: true,
      json: async () => ({
        organic: [
          { title: 'Result 1', link: 'https://example.com', snippet: 'A snippet', date: '2024-01-01' },
        ],
        answerBox: { answer: 'Direct answer' },
      }),
      text: async () => '',
    };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

    const result = await WebSearchTool.execute({ query: 'test' });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('success');
  });

  it('uses Tavily when TAVILY_API_KEY is set', async () => {
    delete process.env['SERPER_API_KEY'];
    process.env['TAVILY_API_KEY'] = 'tvly-test';

    const mockResponse = {
      ok: true,
      json: async () => ({
        results: [
          { title: 'Tavily Result', url: 'https://example.com', content: 'Content' },
        ],
        answer: 'Tavily answer',
      }),
      text: async () => '',
    };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

    const result = await WebSearchTool.execute({ query: 'test' });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('success');
  });

  it('uses Bing when BING_SEARCH_API_KEY is set', async () => {
    delete process.env['SERPER_API_KEY'];
    delete process.env['TAVILY_API_KEY'];
    process.env['BING_SEARCH_API_KEY'] = 'bing-key';

    const mockResponse = {
      ok: true,
      json: async () => ({
        webPages: {
          value: [
            { name: 'Bing Result', url: 'https://bing.com/r', snippet: 'Bing snippet', dateLastCrawled: '2024-01-01' },
          ],
        },
      }),
      text: async () => '',
    };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

    const result = await WebSearchTool.execute({ query: 'test' });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('success');
  });

  it('uses Google when GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_CX are set', async () => {
    delete process.env['SERPER_API_KEY'];
    delete process.env['TAVILY_API_KEY'];
    delete process.env['BING_SEARCH_API_KEY'];
    process.env['GOOGLE_SEARCH_API_KEY'] = 'google-key';
    process.env['GOOGLE_SEARCH_CX'] = 'cx-id';

    const mockResponse = {
      ok: true,
      json: async () => ({
        items: [
          { title: 'Google Result', link: 'https://google.com/r', snippet: 'Google snippet' },
        ],
      }),
      text: async () => '',
    };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

    const result = await WebSearchTool.execute({ query: 'test' });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('success');
  });

  it('uses Brave when BRAVE_SEARCH_API_KEY is set', async () => {
    delete process.env['SERPER_API_KEY'];
    delete process.env['TAVILY_API_KEY'];
    delete process.env['BING_SEARCH_API_KEY'];
    delete process.env['GOOGLE_SEARCH_API_KEY'];
    delete process.env['SERPAPI_API_KEY'];
    process.env['BRAVE_SEARCH_API_KEY'] = 'brave-key';

    const mockResponse = {
      ok: true,
      json: async () => ({
        web: {
          results: [
            { title: 'Brave Result', url: 'https://brave.com/r', description: 'Brave desc' },
          ],
        },
      }),
      text: async () => '',
    };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

    const result = await WebSearchTool.execute({ query: 'test' });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('success');
  });

  it('handles fetch failures gracefully', async () => {
    delete process.env['SERPER_API_KEY'];
    delete process.env['TAVILY_API_KEY'];
    delete process.env['BING_SEARCH_API_KEY'];
    delete process.env['GOOGLE_SEARCH_API_KEY'];
    delete process.env['SERPAPI_API_KEY'];
    delete process.env['BRAVE_SEARCH_API_KEY'];
    delete process.env['EXA_API_KEY'];
    delete process.env['BOCHA_API_KEY'];

    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));

    const result = await WebSearchTool.execute({ query: 'test' });
    expect(result).toContain('error');
  });

  it('uses Exa when EXA_API_KEY is set', async () => {
    delete process.env['SERPER_API_KEY'];
    delete process.env['TAVILY_API_KEY'];
    delete process.env['BING_SEARCH_API_KEY'];
    delete process.env['GOOGLE_SEARCH_API_KEY'];
    delete process.env['SERPAPI_API_KEY'];
    delete process.env['BRAVE_SEARCH_API_KEY'];
    process.env['EXA_API_KEY'] = 'exa-key';

    const mockResponse = {
      ok: true,
      json: async () => ({
        results: [
          { title: 'Exa Result', url: 'https://exa.ai/r', text: 'Exa text', publishedDate: '2024-01-01' },
        ],
      }),
      text: async () => '',
    };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

    const result = await WebSearchTool.execute({ query: 'test' });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('success');
  });

  it('uses Bocha when BOCHA_API_KEY is set', async () => {
    delete process.env['SERPER_API_KEY'];
    delete process.env['TAVILY_API_KEY'];
    delete process.env['BING_SEARCH_API_KEY'];
    delete process.env['GOOGLE_SEARCH_API_KEY'];
    delete process.env['SERPAPI_API_KEY'];
    delete process.env['BRAVE_SEARCH_API_KEY'];
    delete process.env['EXA_API_KEY'];
    process.env['BOCHA_API_KEY'] = 'bocha-key';

    const mockResponse = {
      ok: true,
      json: async () => ({
        webPages: {
          value: [
            { name: 'Bocha Result', url: 'https://bocha.io/r', snippet: 'Bocha snippet' },
          ],
        },
      }),
      text: async () => '',
    };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

    const result = await WebSearchTool.execute({ query: 'test' });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('success');
  });

  it('uses SerpAPI when SERPAPI_API_KEY is set', async () => {
    delete process.env['SERPER_API_KEY'];
    delete process.env['TAVILY_API_KEY'];
    delete process.env['BING_SEARCH_API_KEY'];
    delete process.env['GOOGLE_SEARCH_API_KEY'];
    process.env['SERPAPI_API_KEY'] = 'serp-key';

    const mockResponse = {
      ok: true,
      json: async () => ({
        organic_results: [
          { title: 'SerpAPI Result', link: 'https://serpapi.com/r', snippet: 'Snippet', date: '2024-01-01' },
        ],
        answer_box: { answer: 'Direct answer' },
      }),
      text: async () => '',
    };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

    const result = await WebSearchTool.execute({ query: 'test' });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('success');
  });
});
