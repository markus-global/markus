import type { AgentToolHandler } from '../agent.js';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';

const MAX_CONTENT_LENGTH = 100_000;

/**
 * Targeted web content extraction tool.
 * Allows extracting specific parts of a web page using CSS selectors,
 * or extracting all links/headings/tables from a page.
 */
export const WebExtractTool: AgentToolHandler = {
  name: 'web_extract',
  description:
    'Extract specific content from a web page using CSS selectors or predefined extraction modes. ' +
    'Use this to pull structured data from web pages: specific sections, all links, tables, code blocks, etc.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to extract content from',
      },
      selector: {
        type: 'string',
        description: 'CSS selector to target specific elements (e.g. "main", ".article-body", "#content", "table", "pre code")',
      },
      extractMode: {
        type: 'string',
        enum: ['text', 'markdown', 'links', 'headings', 'tables', 'code', 'meta'],
        description: 'What to extract: "text" (default) for selected text content, "markdown" for markdown conversion, "links" for all links, "headings" for document outline, "tables" for table data, "code" for code blocks, "meta" for page metadata (title, description, og tags)',
      },
    },
    required: ['url'],
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const url = args['url'] as string;
    const selector = args['selector'] as string | undefined;
    const extractMode = (args['extractMode'] as string) ?? 'text';

    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        redirect: 'follow',
      });

      if (!res.ok) {
        return JSON.stringify({ status: 'error', error: `HTTP ${res.status}: ${res.statusText}` });
      }

      const html = await res.text();
      const { document } = parseHTML(html);

      // Remove noisy elements
      for (const el of document.querySelectorAll('script, style, noscript')) {
        el.remove();
      }

      switch (extractMode) {
        case 'meta':
          return JSON.stringify({ status: 'success', url, meta: extractMeta(document) });

        case 'links':
          return JSON.stringify({ status: 'success', url, links: extractLinks(document, url) });

        case 'headings':
          return JSON.stringify({ status: 'success', url, headings: extractHeadings(document) });

        case 'tables':
          return JSON.stringify({ status: 'success', url, tables: extractTables(document) });

        case 'code':
          return JSON.stringify({ status: 'success', url, codeBlocks: extractCode(document) });

        case 'markdown': {
          const target = selector ? document.querySelector(selector) : document.querySelector('main, article, [role="main"], .content, #content, body');
          if (!target) {
            return JSON.stringify({ status: 'error', error: selector ? `No element matches selector: ${selector}` : 'No main content found' });
          }
          const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
          const md = turndown.turndown((target as any).innerHTML ?? (target as any).outerHTML ?? '');
          return JSON.stringify({
            status: 'success', url,
            content: md.slice(0, MAX_CONTENT_LENGTH),
            truncated: md.length > MAX_CONTENT_LENGTH,
          });
        }

        default: {
          // text mode: extract text content from selected or main element
          const target = selector
            ? document.querySelectorAll(selector)
            : [document.querySelector('main, article, [role="main"], .content, #content, body')];

          const elements = selector ? Array.from(target) : [target[0]];
          if (elements.length === 0 || !elements[0]) {
            return JSON.stringify({ status: 'error', error: selector ? `No elements match selector: ${selector}` : 'No content found' });
          }

          const texts = elements.map(el => {
            const text = (el as any).textContent ?? '';
            return text.replace(/\s+/g, ' ').trim();
          });

          const combined = texts.join('\n\n');
          return JSON.stringify({
            status: 'success', url,
            matchCount: elements.length,
            content: combined.slice(0, MAX_CONTENT_LENGTH),
            truncated: combined.length > MAX_CONTENT_LENGTH,
          });
        }
      }
    } catch (error) {
      return JSON.stringify({ status: 'error', error: `Extraction failed: ${String(error)}` });
    }
  },
};

function extractMeta(doc: any): Record<string, string | null> {
  const getMeta = (name: string): string | null => {
    const el = doc.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
    return el?.getAttribute('content') ?? null;
  };

  return {
    title: doc.querySelector('title')?.textContent ?? null,
    description: getMeta('description'),
    ogTitle: getMeta('og:title'),
    ogDescription: getMeta('og:description'),
    ogImage: getMeta('og:image'),
    ogType: getMeta('og:type'),
    author: getMeta('author'),
    keywords: getMeta('keywords'),
    canonical: doc.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null,
  };
}

function extractLinks(doc: any, baseUrl: string): Array<{ text: string; href: string }> {
  const links: Array<{ text: string; href: string }> = [];
  const seen = new Set<string>();

  for (const a of doc.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') ?? '';
    const text = (a.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!href || !text || href.startsWith('#') || href.startsWith('javascript:')) continue;

    let fullUrl: string;
    try {
      fullUrl = new URL(href, baseUrl).href;
    } catch {
      fullUrl = href;
    }

    if (!seen.has(fullUrl)) {
      seen.add(fullUrl);
      links.push({ text, href: fullUrl });
    }
  }

  return links.slice(0, 200);
}

function extractHeadings(doc: any): Array<{ level: number; text: string }> {
  const headings: Array<{ level: number; text: string }> = [];
  for (const h of doc.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const level = parseInt(h.tagName[1] ?? '1', 10);
    const text = (h.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text) headings.push({ level, text });
  }
  return headings;
}

function extractTables(doc: any): Array<{ headers: string[]; rows: string[][] }> {
  const tables: Array<{ headers: string[]; rows: string[][] }> = [];
  for (const table of doc.querySelectorAll('table')) {
    const headers: string[] = [];
    for (const th of table.querySelectorAll('thead th, tr:first-child th')) {
      headers.push((th.textContent ?? '').replace(/\s+/g, ' ').trim());
    }
    const rows: string[][] = [];
    const bodyRows = table.querySelectorAll('tbody tr, tr');
    for (const tr of bodyRows) {
      const cells: string[] = [];
      for (const td of tr.querySelectorAll('td')) {
        cells.push((td.textContent ?? '').replace(/\s+/g, ' ').trim());
      }
      if (cells.length > 0) rows.push(cells);
    }
    if (headers.length > 0 || rows.length > 0) {
      tables.push({ headers, rows: rows.slice(0, 100) });
    }
  }
  return tables.slice(0, 20);
}

function extractCode(doc: any): Array<{ language: string; code: string }> {
  const blocks: Array<{ language: string; code: string }> = [];
  for (const pre of doc.querySelectorAll('pre')) {
    const code = pre.querySelector('code');
    const lang = code?.getAttribute('class')?.match(/language-(\w+)/)?.[1] ?? '';
    const text = (code ?? pre).textContent ?? '';
    if (text.trim()) {
      blocks.push({ language: lang, code: text.trim() });
    }
  }
  return blocks.slice(0, 50);
}
