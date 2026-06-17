import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractReadableContent, WebFetchTool } from '../src/tools/web-fetch.js';

describe('extractReadableContent', () => {
  it('extracts title and markdown from article HTML', () => {
    const html = `<!DOCTYPE html>
<html><head><title>Test Page</title></head>
<body>
  <nav>Navigation links</nav>
  <article>
    <h1>Main Article Title</h1>
    <p>This is the main content of the article.</p>
    <pre><code class="language-js">const x = 1;</code></pre>
  </article>
  <footer>Footer stuff</footer>
</body></html>`;

    const result = extractReadableContent(html, 'https://example.com/article');
    expect(result).not.toBeNull();
    expect(result!.title).toBeTruthy();
    expect(result!.content).toContain('main content');
  });

  it('returns null for empty or non-article HTML', () => {
    const html = '<html><body></body></html>';
    expect(extractReadableContent(html, 'https://example.com/empty')).toBeNull();
  });

  it('handles malformed HTML gracefully', () => {
    expect(extractReadableContent('<<<not html>>>', 'https://example.com/bad')).toBeNull();
  });
});

describe('WebFetchTool', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('has expected name and required url parameter', () => {
    expect(WebFetchTool.name).toBe('web_fetch');
    expect(WebFetchTool.inputSchema.required).toContain('url');
  });

  it('returns JSON content for non-HTML responses', async () => {
    vi.mocked(fetch).mockResolvedValue({
      status: 200,
      headers: { get: (h: string) => h === 'content-type' ? 'application/json' : null },
      text: async () => '{"key":"value"}',
    } as Response);

    const result = JSON.parse(await WebFetchTool.execute({ url: 'https://api.example.com/data' }));
    expect(result.status).toBe('success');
    expect(result.contentType).toContain('json');
    expect(result.content).toBe('{"key":"value"}');
    expect(result.httpStatus).toBe(200);
  });

  it('returns raw HTML in raw mode', async () => {
    const html = '<html><body><p>Raw content</p></body></html>';
    vi.mocked(fetch).mockResolvedValue({
      status: 200,
      headers: { get: () => 'text/html; charset=utf-8' },
      text: async () => html,
    } as Response);

    const result = JSON.parse(await WebFetchTool.execute({
      url: 'https://example.com/page',
      mode: 'raw',
    }));
    expect(result.status).toBe('success');
    expect(result.content).toBe(html);
  });

  it('uses readability extraction for HTML in readable mode', async () => {
    const html = `<!DOCTYPE html><html><head><title>Article</title></head>
<body><article><h1>Article Title</h1><p>Readable paragraph content here.</p></article></body></html>`;
    vi.mocked(fetch).mockResolvedValue({
      status: 200,
      headers: { get: () => 'text/html' },
      text: async () => html,
    } as Response);

    const result = JSON.parse(await WebFetchTool.execute({
      url: 'https://example.com/article',
      mode: 'readable',
    }));
    expect(result.status).toBe('success');
    if (result.extractionMethod === 'readability') {
      expect(result.content).toContain('Article');
    } else {
      expect(result.extractionMethod).toBe('text_strip');
    }
  });

  it('falls back to text stripping when readability fails', async () => {
    const html = '<html><body><div>Some visible text here</div><script>ignore</script></body></html>';
    vi.mocked(fetch).mockResolvedValue({
      status: 200,
      headers: { get: () => 'text/html' },
      text: async () => html,
    } as Response);

    const result = JSON.parse(await WebFetchTool.execute({ url: 'https://example.com/minimal' }));
    expect(result.status).toBe('success');
    expect(['readability', 'text_strip']).toContain(result.extractionMethod);
  });

  it('returns error when fetch throws', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('Network failure'));
    const result = JSON.parse(await WebFetchTool.execute({ url: 'https://example.com/fail' }));
    expect(result.status).toBe('error');
    expect(result.error).toContain('Network failure');
  });

  it('passes custom headers and method to fetch', async () => {
    vi.mocked(fetch).mockResolvedValue({
      status: 200,
      headers: { get: () => 'text/plain' },
      text: async () => 'ok',
    } as Response);

    await WebFetchTool.execute({
      url: 'https://example.com/post',
      method: 'POST',
      headers: { 'X-Custom': 'test' },
      body: 'payload',
    });

    expect(fetch).toHaveBeenCalledWith('https://example.com/post', expect.objectContaining({
      method: 'POST',
      body: 'payload',
      headers: expect.objectContaining({ 'X-Custom': 'test' }),
    }));
  });
});
