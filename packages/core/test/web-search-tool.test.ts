import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  WebSearchTool,
  testSearchProvider,
  resolveMarkusSearchProvider,
} from '../src/tools/web-search.js';

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

  it('returns error when no search backends are configured', async () => {
    delete process.env['SERPER_API_KEY'];
    delete process.env['TAVILY_API_KEY'];
    delete process.env['BING_SEARCH_API_KEY'];
    delete process.env['GOOGLE_SEARCH_API_KEY'];
    delete process.env['SERPAPI_API_KEY'];
    delete process.env['BRAVE_SEARCH_API_KEY'];
    delete process.env['EXA_API_KEY'];
    delete process.env['BOCHA_API_KEY'];
    delete process.env['MARKUS_SEARCH_URL'];
    delete process.env['MARKUS_HUB_URL'];
    delete process.env['MARKUS_HUB_TOKEN'];
    delete process.env['MARKUS_SUBSCRIPTION_KEY'];
    delete process.env['MARKUS_PROXY_URL'];
    delete process.env['MARKUS_OPENROUTER_KEY'];
    process.env['MARKUS_SEARCH_ENABLED'] = '0';

    const result = await WebSearchTool.execute({ query: 'test query', maxResults: 5 });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('error');
    expect(parsed.error).toMatch(/No search backends configured/i);
    delete process.env['MARKUS_SEARCH_ENABLED'];
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

  const clearOwnSearchKeys = () => {
    for (const k of [
      'SERPER_API_KEY', 'TAVILY_API_KEY', 'BING_SEARCH_API_KEY', 'GOOGLE_SEARCH_API_KEY',
      'SERPAPI_API_KEY', 'BRAVE_SEARCH_API_KEY', 'EXA_API_KEY', 'BOCHA_API_KEY',
      'MARKUS_SEARCH_URL', 'MARKUS_HUB_URL', 'MARKUS_HUB_TOKEN', 'MARKUS_CU_REMAINING',
      'MARKUS_SUBSCRIPTION_KEY', 'MARKUS_PROXY_URL',
      'MARKUS_OPENROUTER_KEY', 'OPENROUTER_API_KEY', 'MARKUS_OPENROUTER_BASE',
    ]) delete process.env[k];
  };

  /** OpenRouter chat/completions-shaped search response. */
  const orSearchResponse = (results: Array<{ url: string; title?: string; snippet?: string }>) => {
    const arr = results.map(r => ({
      title: r.title ?? r.url,
      url: r.url,
      snippet: r.snippet ?? '',
    }));
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(arr) } }],
      }),
      text: async () => JSON.stringify({
        choices: [{ message: { content: JSON.stringify(arr) } }],
      }),
    };
  };

  it('resolveMarkusSearchProvider picks bocha for zh and tavily otherwise', () => {
    expect(resolveMarkusSearchProvider({ language: 'zh-CN' })).toBe('bocha');
    expect(resolveMarkusSearchProvider({ language: 'en' })).toBe('tavily');
    expect(resolveMarkusSearchProvider({ markusProvider: 'tavily', language: 'zh-CN' })).toBe('tavily');
    expect(resolveMarkusSearchProvider({ markusProvider: 'bocha', language: 'en' })).toBe('bocha');
  });

  it('uses OpenRouter chat/completions with member key for Markus search', async () => {
    clearOwnSearchKeys();
    delete process.env['MARKUS_SEARCH_ENABLED'];
    process.env['MARKUS_OPENROUTER_KEY'] = 'sk-or-test';

    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(orSearchResponse([
      { url: 'https://example.com/r', title: 'Markus Result', snippet: 'Hosted snippet' },
    ]));

    const result = await WebSearchTool.execute({ query: 'test', maxResults: 5 });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('success');
    expect(parsed.results[0].title).toBe('Markus Result');
    expect(parsed.results[0].url).toBe('https://example.com/r');

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('openrouter.ai/api/v1/chat/completions');
    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string>; body: string };
    expect(init.headers['Authorization']).toBe('Bearer sk-or-test');
    const body = JSON.parse(init.body);
    expect(body.messages[0].content).toContain('test');
    expect(body.provider).toBeUndefined();
  });

  it('prefers BYOK when Hub balance is zero/unknown even if Markus is configured', async () => {
    clearOwnSearchKeys();
    process.env['SERPER_API_KEY'] = 'serper-test';
    process.env['MARKUS_OPENROUTER_KEY'] = 'sk-or-test';
    process.env['MARKUS_HUB_TOKEN'] = 'hub-token';
    process.env['MARKUS_CU_REMAINING'] = '0';
    delete process.env['MARKUS_SEARCH_ENABLED'];

    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        organic: [{ title: 'Serper First', link: 'https://x/y', snippet: 'from serper' }],
      }),
    });

    const result = await WebSearchTool.execute({ query: 'test' });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('success');
    expect(parsed.results[0].title).toBe('Serper First');
    expect(String(fetchMock.mock.calls[0][0])).toContain('serper.dev');
  });

  it('prefers Markus search when Hub is connected and CU remaining > 0', async () => {
    clearOwnSearchKeys();
    process.env['SERPER_API_KEY'] = 'serper-test';
    process.env['MARKUS_OPENROUTER_KEY'] = 'sk-or-test';
    process.env['MARKUS_HUB_TOKEN'] = 'hub-token';
    process.env['MARKUS_CU_REMAINING'] = '120';
    delete process.env['MARKUS_SEARCH_ENABLED'];

    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(orSearchResponse([
      { url: 'https://example.com/r', title: 'Markus First', snippet: 'hosted' },
    ]));

    const result = await WebSearchTool.execute({ query: 'test' });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('success');
    expect(parsed.results[0].title).toBe('Markus First');
    expect(String(fetchMock.mock.calls[0][0])).toContain('openrouter.ai');
  });

  it('skips Markus search when member key is unset', async () => {
    clearOwnSearchKeys();
    delete process.env['MARKUS_SEARCH_ENABLED'];
    delete process.env['MARKUS_OPENROUTER_KEY'];
    process.env['BRAVE_SEARCH_API_KEY'] = 'brave-key';

    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ web: { results: [{ title: 'Brave', url: 'https://b/r', description: 'd' }] } }),
      text: async () => '',
    });

    const result = await WebSearchTool.execute({ query: 'test' });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('success');
    expect(String(fetchMock.mock.calls[0][0])).toContain('brave');
  });

  it('maps OR 402 search errors to CU_EXCEEDED without vendor URL', async () => {
    clearOwnSearchKeys();
    delete process.env['MARKUS_SEARCH_ENABLED'];
    process.env['MARKUS_OPENROUTER_KEY'] = 'sk-or-test';

    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: false,
      status: 402,
      statusText: 'Payment Required',
      text: async () => JSON.stringify({ error: { message: 'Key limit exceeded https://openrouter.ai/workspaces/x' } }),
      json: async () => ({ error: { message: 'Key limit exceeded' } }),
    });

    const result = await WebSearchTool.execute({ query: 'test' });
    expect(result).not.toMatch(/openrouter\.ai/i);
    expect(String(fetchMock.mock.calls[0][0])).toContain('chat/completions');
  });

  it('does not send provider field in OR search body', async () => {
    clearOwnSearchKeys();
    delete process.env['MARKUS_SEARCH_ENABLED'];
    process.env['MARKUS_OPENROUTER_KEY'] = 'sk-or-test';

    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(orSearchResponse([{ url: 'https://example.com/ok', title: 'OK' }]));

    await WebSearchTool.execute({ query: '测试', maxResults: 3 });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.provider).toBeUndefined();
    expect(body.messages[0].content).toContain('测试');
  });

  it('skips unconfigured backends entirely (only tries configured ones)', async () => {
    clearOwnSearchKeys();
    delete process.env['MARKUS_SUBSCRIPTION_KEY'];
    process.env['BRAVE_SEARCH_API_KEY'] = 'brave-key';

    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ web: { results: [{ title: 'Brave', url: 'https://b/r', description: 'd' }] } }),
      text: async () => '',
    });

    const result = await WebSearchTool.execute({ query: 'test' });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('success');
    // Exactly one backend attempted (Brave) — no other providers, no DDG fallback.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('brave');
  });

  it('skips a provider listed in SEARCH_DISABLED_PROVIDERS even if its key is set', async () => {
    clearOwnSearchKeys();
    delete process.env['MARKUS_SUBSCRIPTION_KEY'];
    delete process.env['MARKUS_OPENROUTER_KEY'];
    process.env['SERPER_API_KEY'] = 'serper-test';
    process.env['SEARCH_DISABLED_PROVIDERS'] = 'serper';
    process.env['MARKUS_SEARCH_ENABLED'] = '0';

    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () => '',
      json: async () => ({}),
    });

    const result = JSON.parse(await WebSearchTool.execute({ query: 'test' }));
    expect(result.status).toBe('error');
    // Serper endpoint must never be called when disabled.
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain('serper');
    }
    delete process.env['SEARCH_DISABLED_PROVIDERS'];
    delete process.env['MARKUS_SEARCH_ENABLED'];
  });

  it('skips Markus-hosted search when disabled via MARKUS_SEARCH_ENABLED=0', async () => {
    clearOwnSearchKeys();
    process.env['MARKUS_OPENROUTER_KEY'] = 'sk-or-test';
    process.env['MARKUS_SEARCH_ENABLED'] = '0';

    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({ ok: true, text: async () => '<html></html>', json: async () => ({}) });

    const result = await WebSearchTool.execute({ query: 'test' });
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain('chat/completions');
    }
    expect(result).toBeTypeOf('string');
  });

  describe('testSearchProvider', () => {
    it('returns ok with count + sample when the backend responds', async () => {
      process.env['TAVILY_API_KEY'] = 'tvly-test';
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({ results: [{ title: 'Probe', url: 'https://example.com', content: 'c' }] }),
        text: async () => '',
      });

      const r = await testSearchProvider('tavily');
      expect(r.ok).toBe(true);
      expect(r.count).toBe(1);
      expect(r.sample?.title).toBe('Probe');
      expect(typeof r.latencyMs).toBe('number');
    });

    it('returns an error for an unknown provider', async () => {
      const r = await testSearchProvider('nope');
      expect(r.ok).toBe(false);
      expect(r.error).toContain('Unknown search provider');
    });

    it('applies and restores env overrides (Markus OR search)', async () => {
      delete process.env['MARKUS_OPENROUTER_KEY'];
      const fetchMock = fetch as ReturnType<typeof vi.fn>;
      fetchMock.mockResolvedValue(orSearchResponse([{ title: 'Hosted', url: 'https://x/y', snippet: 's' }]));

      const r = await testSearchProvider('markus', {
        MARKUS_OPENROUTER_KEY: 'sk-or-test',
        MARKUS_SEARCH_ENABLED: '1',
      });
      expect(r.ok).toBe(true);
      expect(String(fetchMock.mock.calls[0][0])).toContain('chat/completions');
      const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
      expect(init.headers['Authorization']).toBe('Bearer sk-or-test');
      expect(process.env['MARKUS_OPENROUTER_KEY']).toBeUndefined();
    });

    it('reports failure when the backend throws', async () => {
      process.env['TAVILY_API_KEY'] = 'tvly-test';
      (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
      const r = await testSearchProvider('tavily');
      expect(r.ok).toBe(false);
      expect(r.error).toContain('boom');
    });
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
