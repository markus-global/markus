import type { AgentToolHandler } from '../agent.js';

export const WebFetchTool: AgentToolHandler = {
  name: 'web_fetch',
  description: 'Fetch the content of a URL and return it as text. Useful for reading web pages, APIs, etc.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch',
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
    const method = (args['method'] as string) ?? 'GET';
    const headers = args['headers'] as Record<string, string> | undefined;
    const body = args['body'] as string | undefined;

    try {
      const res = await fetch(url, {
        method,
        headers,
        body,
      });

      const contentType = res.headers.get('content-type') ?? '';
      const text = await res.text();

      return JSON.stringify({
        status: res.status,
        contentType,
        body: text.slice(0, 50_000),
        truncated: text.length > 50_000,
      });
    } catch (error) {
      return JSON.stringify({ error: `Fetch failed: ${String(error)}` });
    }
  },
};
