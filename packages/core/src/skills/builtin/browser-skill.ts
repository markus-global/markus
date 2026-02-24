import type { AgentToolHandler } from '../../agent.js';
import type { SkillManifest, SkillInstance } from '../types.js';

const manifest: SkillManifest = {
  name: 'browser',
  version: '0.1.0',
  description: 'Browser automation: navigate, click, type, screenshot, extract content',
  author: 'markus',
  category: 'browser',
  tags: ['browser', 'automation', 'web', 'scraping', 'screenshot'],
  tools: [
    {
      name: 'browser_navigate',
      description: 'Navigate to a URL and return the page title and text content',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to navigate to' },
          waitFor: { type: 'number', description: 'Milliseconds to wait after navigation (default 2000)' },
        },
        required: ['url'],
      },
    },
    {
      name: 'browser_screenshot',
      description: 'Take a screenshot of the current page and save to disk',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to save the screenshot' },
          fullPage: { type: 'boolean', description: 'Capture full page (default false)' },
        },
        required: ['path'],
      },
    },
    {
      name: 'browser_click',
      description: 'Click an element matching a CSS selector',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector of element to click' },
        },
        required: ['selector'],
      },
    },
    {
      name: 'browser_type',
      description: 'Type text into an input element',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector of input element' },
          text: { type: 'string', description: 'Text to type' },
          clear: { type: 'boolean', description: 'Clear the field before typing (default true)' },
        },
        required: ['selector', 'text'],
      },
    },
    {
      name: 'browser_extract',
      description: 'Extract text content from elements matching a CSS selector',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector' },
          attribute: { type: 'string', description: 'Attribute to extract instead of text (e.g. href, src)' },
        },
        required: ['selector'],
      },
    },
    {
      name: 'browser_evaluate',
      description: 'Execute JavaScript in the browser context and return the result',
      inputSchema: {
        type: 'object',
        properties: {
          script: { type: 'string', description: 'JavaScript code to execute' },
        },
        required: ['script'],
      },
    },
  ],
  requiredPermissions: ['browser'],
};

interface BrowserSession {
  process?: import('node:child_process').ChildProcess;
  wsEndpoint?: string;
}

const sessions = new Map<string, BrowserSession>();

async function getOrCreateSession(agentId: string): Promise<BrowserSession> {
  const existing = sessions.get(agentId);
  if (existing) return existing;

  const session: BrowserSession = {};
  sessions.set(agentId, session);
  return session;
}

export function createBrowserSkill(): SkillInstance {
  const tools: AgentToolHandler[] = [
    {
      name: 'browser_navigate',
      description: manifest.tools[0]!.description,
      inputSchema: manifest.tools[0]!.inputSchema,
      execute: async (args: Record<string, unknown>) => {
        const url = args['url'] as string;
        const waitFor = (args['waitFor'] as number) ?? 2000;

        try {
          const response = await fetch(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Markus Agent Browser/1.0)',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
            signal: AbortSignal.timeout(30000),
          });

          const html = await response.text();

          const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
          const title = titleMatch?.[1] ?? 'No title';

          const textContent = html
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 5000);

          return `Navigated to: ${url}\nTitle: ${title}\nStatus: ${response.status}\n\nContent:\n${textContent}`;
        } catch (err) {
          return `Error navigating to ${url}: ${String(err)}`;
        }
      },
    },
    {
      name: 'browser_screenshot',
      description: manifest.tools[1]!.description,
      inputSchema: manifest.tools[1]!.inputSchema,
      execute: async (args: Record<string, unknown>) => {
        return `Screenshot capability requires Puppeteer/Playwright. Configure BROWSER_EXECUTABLE_PATH for full support. Screenshot path: ${args['path']}`;
      },
    },
    {
      name: 'browser_click',
      description: manifest.tools[2]!.description,
      inputSchema: manifest.tools[2]!.inputSchema,
      execute: async (args: Record<string, unknown>) => {
        return `Click action on "${args['selector']}" requires a live browser session. Use browser_navigate first to fetch page content, then identify elements.`;
      },
    },
    {
      name: 'browser_type',
      description: manifest.tools[3]!.description,
      inputSchema: manifest.tools[3]!.inputSchema,
      execute: async (args: Record<string, unknown>) => {
        return `Type action on "${args['selector']}" requires a live browser session. For form submissions, consider using web_fetch with POST method instead.`;
      },
    },
    {
      name: 'browser_extract',
      description: manifest.tools[4]!.description,
      inputSchema: manifest.tools[4]!.inputSchema,
      execute: async (args: Record<string, unknown>) => {
        return `Extract requires a loaded page. Use browser_navigate to load a page first. CSS selector: "${args['selector']}"`;
      },
    },
    {
      name: 'browser_evaluate',
      description: manifest.tools[5]!.description,
      inputSchema: manifest.tools[5]!.inputSchema,
      execute: async (args: Record<string, unknown>) => {
        return `JavaScript evaluation requires a live browser session. Script: "${(args['script'] as string).slice(0, 100)}"`;
      },
    },
  ];

  return { manifest, tools };
}
