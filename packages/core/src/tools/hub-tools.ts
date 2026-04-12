import type { AgentToolHandler } from '../agent.js';

export interface HubToolsContext {
  searchHub: (opts?: { type?: string; query?: string }) => Promise<Array<{ id: string; name: string; type: string; description: string; author: string; version?: string; downloads?: number }>>;
  downloadAndInstall: (itemId: string) => Promise<{ type: string; installed: unknown }>;
}

export function createHubTools(ctx: HubToolsContext): AgentToolHandler[] {
  return [
    {
      name: 'hub_search',
      description: 'Search Markus Hub for community-published agents, teams, and skills. Returns a list of available items with descriptions and popularity.',
      inputSchema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['agent', 'team', 'skill'],
            description: 'Filter by item type (optional)',
          },
          query: {
            type: 'string',
            description: 'Search query (optional)',
          },
        },
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        try {
          const items = await ctx.searchHub({
            type: args['type'] as string | undefined,
            query: args['query'] as string | undefined,
          });
          return JSON.stringify({ items, count: items.length });
        } catch (error) {
          return JSON.stringify({ status: 'error', error: String(error) });
        }
      },
    },
    {
      name: 'hub_install',
      description: 'Download an item from Markus Hub and install it. Combines download, save as artifact, and install into a single step. For agents/teams: remember to onboard the new agent(s) after installation.',
      inputSchema: {
        type: 'object',
        properties: {
          item_id: { type: 'string', description: 'Hub item ID (from hub_search results)' },
        },
        required: ['item_id'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        try {
          const result = await ctx.downloadAndInstall(args['item_id'] as string);
          const isAgentOrTeam = result.type === 'agent' || result.type === 'team';
          return JSON.stringify({
            status: 'success',
            ...result,
            ...(isAgentOrTeam ? {
              next_steps: 'Downloaded and installed from Hub. Next: onboard new agent(s) with project context via agent_send_message, then assign initial tasks via task_create.',
            } : {}),
          });
        } catch (error) {
          return JSON.stringify({ status: 'error', error: String(error) });
        }
      },
    },
  ];
}
