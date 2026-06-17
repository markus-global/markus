import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebExtractTool } from '../src/tools/web-extract.js';

describe('WebExtractTool', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('has correct tool metadata', () => {
    expect(WebExtractTool.name).toBe('web_extract');
    expect(WebExtractTool.inputSchema.required).toContain('url');
  });

  it('extracts text content from a page', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => '<html><body><main><p>Hello world</p></main></body></html>',
    });

    const result = await WebExtractTool.execute({ url: 'https://example.com', extractMode: 'text' });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('success');
    expect(parsed.content).toContain('Hello world');
  });

  it('extracts links from a page', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => '<html><body><a href="https://a.com">Link A</a><a href="https://b.com">Link B</a></body></html>',
    });

    const result = await WebExtractTool.execute({ url: 'https://example.com', extractMode: 'links' });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('success');
    expect(parsed.links.length).toBeGreaterThanOrEqual(2);
  });

  it('extracts headings from a page', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => '<html><body><h1>Title</h1><h2>Section</h2><h3>Sub</h3></body></html>',
    });

    const result = await WebExtractTool.execute({ url: 'https://example.com', extractMode: 'headings' });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('success');
    expect(parsed.headings.length).toBe(3);
  });

  it('extracts tables from a page', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => '<html><body><table><tr><th>Name</th><th>Age</th></tr><tr><td>Alice</td><td>30</td></tr></table></body></html>',
    });

    const result = await WebExtractTool.execute({ url: 'https://example.com', extractMode: 'tables' });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('success');
    expect(parsed.tables.length).toBe(1);
  });

  it('extracts code blocks from a page', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => '<html><body><pre><code>const x = 1;</code></pre></body></html>',
    });

    const result = await WebExtractTool.execute({ url: 'https://example.com', extractMode: 'code' });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('success');
    expect(parsed.codeBlocks.length).toBe(1);
  });

  it('extracts meta information from a page', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => '<html><head><title>My Page</title><meta name="description" content="A page"></head><body></body></html>',
    });

    const result = await WebExtractTool.execute({ url: 'https://example.com', extractMode: 'meta' });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('success');
    expect(parsed.meta.title).toBe('My Page');
  });

  it('uses CSS selector to target elements', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => '<html><body><div class="article"><p>Article content</p></div><div class="sidebar">Ignore</div></body></html>',
    });

    const result = await WebExtractTool.execute({ url: 'https://example.com', selector: '.article' });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('success');
    expect(parsed.content).toContain('Article content');
  });

  it('handles HTTP errors gracefully', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    const result = await WebExtractTool.execute({ url: 'https://example.com/missing' });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('error');
    expect(parsed.error).toContain('404');
  });

  it('handles fetch failures gracefully', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Connection refused'));

    const result = await WebExtractTool.execute({ url: 'https://unreachable.com' });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('error');
  });

  it('converts to markdown when extractMode is markdown', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => '<html><body><h1>Title</h1><p>Paragraph with <strong>bold</strong></p></body></html>',
    });

    const result = await WebExtractTool.execute({ url: 'https://example.com', extractMode: 'markdown' });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('success');
    expect(parsed.content).toContain('Title');
  });
});
