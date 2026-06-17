import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebExtractTool } from '../src/tools/web-extract.js';

const SAMPLE_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Sample Page</title>
  <meta name="description" content="A sample page for testing">
  <meta property="og:title" content="OG Title">
  <meta property="og:description" content="OG Description">
  <meta property="og:image" content="https://example.com/image.png">
  <meta property="og:type" content="article">
  <meta name="author" content="Test Author">
  <meta name="keywords" content="test, sample">
  <link rel="canonical" href="https://example.com/page">
</head>
<body>
  <main>
    <h1>Main Heading</h1>
    <h2>Sub Heading</h2>
    <p>Main paragraph content here.</p>
    <a href="/relative">Relative Link</a>
    <a href="https://external.com">External Link</a>
    <a href="#anchor">Anchor</a>
    <a href="javascript:void(0)">JS Link</a>
    <table>
      <thead><tr><th>Name</th><th>Value</th></tr></thead>
      <tbody><tr><td>Alpha</td><td>1</td></tr></tbody>
    </table>
    <pre><code class="language-typescript">const x = 1;</code></pre>
  </main>
  <script>console.log('noise')</script>
  <style>.hidden { display: none; }</style>
</body>
</html>`;

describe('WebExtractTool', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('has expected name and required url parameter', () => {
    expect(WebExtractTool.name).toBe('web_extract');
    expect(WebExtractTool.inputSchema.required).toContain('url');
  });

  it('returns HTTP error for failed fetch', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    } as Response);

    const result = JSON.parse(await WebExtractTool.execute({ url: 'https://example.com/missing' }));
    expect(result.status).toBe('error');
    expect(result.error).toContain('404');
  });

  it('extracts meta tags', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      text: async () => SAMPLE_HTML,
    } as Response);

    const result = JSON.parse(await WebExtractTool.execute({
      url: 'https://example.com/page',
      extractMode: 'meta',
    }));
    expect(result.status).toBe('success');
    expect(result.meta.title).toBe('Sample Page');
    expect(result.meta.description).toBe('A sample page for testing');
    expect(result.meta.ogTitle).toBe('OG Title');
    expect(result.meta.canonical).toBe('https://example.com/page');
  });

  it('extracts links with resolved URLs', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      text: async () => SAMPLE_HTML,
    } as Response);

    const result = JSON.parse(await WebExtractTool.execute({
      url: 'https://example.com/page',
      extractMode: 'links',
    }));
    expect(result.status).toBe('success');
    expect(result.links.some((l: { href: string }) => l.href === 'https://example.com/relative')).toBe(true);
    expect(result.links.some((l: { text: string }) => l.text === 'External Link')).toBe(true);
    expect(result.links.some((l: { text: string }) => l.text === 'Anchor')).toBe(false);
  });

  it('extracts headings outline', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      text: async () => SAMPLE_HTML,
    } as Response);

    const result = JSON.parse(await WebExtractTool.execute({
      url: 'https://example.com/page',
      extractMode: 'headings',
    }));
    expect(result.status).toBe('success');
    expect(result.headings).toEqual([
      { level: 1, text: 'Main Heading' },
      { level: 2, text: 'Sub Heading' },
    ]);
  });

  it('extracts table data', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      text: async () => SAMPLE_HTML,
    } as Response);

    const result = JSON.parse(await WebExtractTool.execute({
      url: 'https://example.com/page',
      extractMode: 'tables',
    }));
    expect(result.status).toBe('success');
    expect(result.tables[0].headers).toEqual(['Name', 'Value']);
    expect(result.tables[0].rows[0]).toEqual(['Alpha', '1']);
  });

  it('extracts code blocks with language', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      text: async () => SAMPLE_HTML,
    } as Response);

    const result = JSON.parse(await WebExtractTool.execute({
      url: 'https://example.com/page',
      extractMode: 'code',
    }));
    expect(result.status).toBe('success');
    expect(result.codeBlocks[0].language).toBe('typescript');
    expect(result.codeBlocks[0].code).toContain('const x = 1');
  });

  it('extracts markdown from main content', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      text: async () => SAMPLE_HTML,
    } as Response);

    const result = JSON.parse(await WebExtractTool.execute({
      url: 'https://example.com/page',
      extractMode: 'markdown',
    }));
    expect(result.status).toBe('success');
    expect(result.content).toContain('Main Heading');
    expect(result.truncated).toBe(false);
  });

  it('extracts text with CSS selector', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      text: async () => SAMPLE_HTML,
    } as Response);

    const result = JSON.parse(await WebExtractTool.execute({
      url: 'https://example.com/page',
      selector: 'p',
    }));
    expect(result.status).toBe('success');
    expect(result.content).toContain('Main paragraph');
    expect(result.matchCount).toBe(1);
  });

  it('returns error when selector matches nothing in markdown mode', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      text: async () => SAMPLE_HTML,
    } as Response);

    const result = JSON.parse(await WebExtractTool.execute({
      url: 'https://example.com/page',
      extractMode: 'markdown',
      selector: '.nonexistent',
    }));
    expect(result.status).toBe('error');
    expect(result.error).toContain('No element matches selector');
  });

  it('returns error when selector matches nothing in text mode', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      text: async () => SAMPLE_HTML,
    } as Response);

    const result = JSON.parse(await WebExtractTool.execute({
      url: 'https://example.com/page',
      selector: '.missing',
    }));
    expect(result.status).toBe('error');
    expect(result.error).toContain('No elements match selector');
  });

  it('handles fetch exceptions gracefully', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('Network down'));

    const result = JSON.parse(await WebExtractTool.execute({ url: 'https://example.com/page' }));
    expect(result.status).toBe('error');
    expect(result.error).toContain('Extraction failed');
  });
});
