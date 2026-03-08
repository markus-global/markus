import type { AgentToolHandler } from '../agent.js';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';

const MAX_CONTENT_LENGTH = 100_000;

/**
 * Extract readable content from HTML using Mozilla Readability + Turndown.
 * Returns clean markdown instead of raw HTML.
 */
export function extractReadableContent(html: string, url: string): { title: string; content: string; byline?: string } | null {
  try {
    const { document } = parseHTML(html);

    // Remove script and style elements before Readability processing
    for (const el of document.querySelectorAll('script, style, noscript, iframe')) {
      el.remove();
    }

    const reader = new Readability(document as any, { charThreshold: 100 });
    const article = reader.parse();
    if (!article || !article.content) return null;

    const turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
    });

    // Preserve code blocks
    turndown.addRule('pre', {
      filter: 'pre',
      replacement: (content, node) => {
        const code = (node as any).querySelector?.('code');
        const lang = code?.getAttribute?.('class')?.match?.(/language-(\w+)/)?.[1] ?? '';
        return `\n\`\`\`${lang}\n${content.trim()}\n\`\`\`\n`;
      },
    });

    const markdown = turndown.turndown(article.content);

    return {
      title: article.title || '',
      content: markdown,
      byline: article.byline || undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Simple fallback: strip HTML tags and collapse whitespace.
 */
function stripToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export const WebFetchTool: AgentToolHandler = {
  name: 'web_fetch',
  description:
    'Fetch the content of a URL and return it as readable text/markdown. ' +
    'Automatically extracts main content from HTML pages (strips navigation, ads, etc). ' +
    'Useful for reading web pages, documentation, articles, and APIs.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch',
      },
      mode: {
        type: 'string',
        enum: ['readable', 'raw', 'markdown'],
        description: 'Extraction mode: "readable" (default) extracts main content as markdown, "raw" returns raw response body, "markdown" converts full page to markdown',
      },
      method: {
        type: 'string',
        enum: ['GET', 'POST', 'PUT', 'DELETE'],
        description: 'HTTP method (default: GET)',
      },
      headers: {
        type: 'object',
        description: 'HTTP headers to send',
      },
      body: {
        type: 'string',
        description: 'Request body (for POST/PUT)',
      },
    },
    required: ['url'],
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const url = args['url'] as string;
    const mode = (args['mode'] as string) ?? 'readable';
    const method = (args['method'] as string) ?? 'GET';
    const headers = args['headers'] as Record<string, string> | undefined;
    const body = args['body'] as string | undefined;

    try {
      const res = await fetch(url, {
        method,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          ...headers,
        },
        body,
        redirect: 'follow',
      });

      const contentType = res.headers.get('content-type') ?? '';
      const text = await res.text();

      // For non-HTML content, return as-is
      if (!contentType.includes('html')) {
        const truncated = text.length > MAX_CONTENT_LENGTH;
        return JSON.stringify({
          status: 'success',
          url,
          httpStatus: res.status,
          contentType,
          content: text.slice(0, MAX_CONTENT_LENGTH),
          truncated,
        });
      }

      // Raw mode: return the HTML as-is
      if (mode === 'raw') {
        return JSON.stringify({
          status: 'success',
          url,
          httpStatus: res.status,
          contentType,
          content: text.slice(0, MAX_CONTENT_LENGTH),
          truncated: text.length > MAX_CONTENT_LENGTH,
        });
      }

      // Readable / Markdown mode: extract content
      const article = extractReadableContent(text, url);

      if (article) {
        const content = article.content.slice(0, MAX_CONTENT_LENGTH);
        const header = article.title ? `# ${article.title}\n\n` : '';
        const byline = article.byline ? `*${article.byline}*\n\n` : '';
        const fullContent = `${header}${byline}${content}`;

        return JSON.stringify({
          status: 'success',
          url,
          httpStatus: res.status,
          title: article.title,
          content: fullContent.slice(0, MAX_CONTENT_LENGTH),
          truncated: fullContent.length > MAX_CONTENT_LENGTH,
          extractionMethod: 'readability',
        });
      }

      // Readability failed, fall back to text stripping
      const plainText = stripToText(text);
      return JSON.stringify({
        status: 'success',
        url,
        httpStatus: res.status,
        content: plainText.slice(0, MAX_CONTENT_LENGTH),
        truncated: plainText.length > MAX_CONTENT_LENGTH,
        extractionMethod: 'text_strip',
        note: 'Readability extraction failed, returning stripped text',
      });
    } catch (error) {
      return JSON.stringify({ status: 'error', error: `Fetch failed: ${String(error)}` });
    }
  },
};
