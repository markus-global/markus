import type { AgentToolHandler } from '../agent.js';
import { createLogger } from '@markus/shared';

const log = createLogger('manager-tools');

export interface ManagerToolsContext {
  listAgents: () => Array<{ id: string; name: string; role: string; status: string; skills?: string[] }>;
  delegateMessage: (agentId: string, message: string, fromManager: string) => Promise<string>;
  getTeamStatus: () => Array<{ id: string; name: string; role: string; status: string; currentTask?: string; tokensUsedToday: number }>;
  findDuplicateTasks?: (orgId: string) => Array<{ group: string; tasks: Array<{ id: string; title: string; status: string; createdAt: string }> }>;
  cleanupDuplicateTasks?: (orgId: string) => { cancelledIds: string[]; count: number };
  getTaskBoardHealth?: (orgId: string) => Record<string, unknown>;
  updateTeam?: (teamId: string, data: { name?: string; description?: string }) => Promise<{ id: string; name: string; description?: string }>;
  updateAgentConfig?: (agentId: string, data: { name?: string }) => Promise<{ id: string; name: string }>;
}

export interface PackageToolsContext {
  installArtifact?: () => ((type: 'agent' | 'team' | 'skill', name: string) => Promise<{ type: string; installed: unknown }>) | undefined;
  listArtifacts?: () => ((type?: 'agent' | 'team' | 'skill') => Array<{ type: string; name: string; description?: string }>) | undefined;
  hireFromTemplate?: () => ((templateId: string, name: string, skills?: string[]) => Promise<{ id: string; name: string; role: string }>) | undefined;
  listTemplates?: () => (() => Array<{ id: string; name: string; description: string; roleId: string; category: string }>) | undefined;
  searchHub?: () => ((opts?: { type?: string; query?: string }) => Promise<Array<{ id: string; name: string; type: string; description: string; author: string; version?: string; downloads?: number }>>) | undefined;
  downloadAndInstall?: () => ((itemId: string) => Promise<{ type: string; installed: unknown }>) | undefined;
  requestApproval?: (request: { toolName: string; toolArgs: Record<string, unknown>; reason: string }) => Promise<{ approved: boolean; comment?: string }>;
}

export function createPackageTools(ctx: PackageToolsContext): AgentToolHandler[] {
  return [
    {
      name: 'package_list',
      description: 'List all available packages. type "agent": built-in roles (developer, content-writer, etc.) and custom agent packages. type "team": team templates (content-team, research-lab, etc.). type "skill": skill packages. Omit type to list all. Install with package_install. To find more online, use hub_search.',
      inputSchema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['agent', 'team', 'skill'],
            description: 'Filter by type (optional). Omit to list all.',
          },
        },
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const listArtifacts = ctx.listArtifacts?.();
        if (!listArtifacts) return JSON.stringify({ status: 'error', error: 'Package service is not available yet. Please try again later.' });
        try {
          const type = args['type'] as string | undefined;
          const artifacts = listArtifacts(type as 'agent' | 'team' | 'skill' | undefined);
          const listTemplates = ctx.listTemplates?.();
          const roles = (!type || type === 'agent') && listTemplates ? listTemplates() : [];
          const roleItems = roles.map((r: { id?: string; name?: string; description?: string }) => ({
            type: 'agent' as const,
            source: 'role' as const,
            name: r.id ?? r.name,
            description: r.description ?? r.name,
            ...r,
          }));
          const items = [...roleItems, ...artifacts];
          return JSON.stringify({ items, count: items.length });
        } catch (error) {
          return JSON.stringify({ status: 'error', error: String(error) });
        }
      },
    } as AgentToolHandler,

    {
      name: 'package_install',
      description: 'Install a package into the live organization. type "agent": hire/install an agent (from a built-in role or a custom package). type "team": deploy a full team with all members, norms, and starter tasks. type "skill": install a skill package. Requires user approval. Use package_list to see what is available.',
      inputSchema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['agent', 'team', 'skill'],
            description: 'Package type',
          },
          name: { type: 'string', description: 'Package name (from package_list)' },
          agent_name: { type: 'string', description: 'Display name for the new agent (required when installing from a built-in role, e.g. "developer")' },
          skills: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional skill IDs to assign to the new agent',
          },
        },
        required: ['type', 'name'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const installArtifact = ctx.installArtifact?.();
        if (!installArtifact) return JSON.stringify({ status: 'error', error: 'Package service is not available yet. Please try again later.' });
        try {
          const type = (args['type'] as string | undefined)?.trim();
          const name = (args['name'] as string | undefined)?.trim();
          if (!type || !['agent', 'team', 'skill'].includes(type)) return JSON.stringify({ status: 'error', error: 'type is required and must be one of: agent, team, skill' });
          if (!name) return JSON.stringify({ status: 'error', error: 'name is required — use package_list to see available packages' });

          if (ctx.requestApproval) {
            const { approved, comment } = await ctx.requestApproval({
              toolName: 'package_install',
              toolArgs: { type, name, agent_name: args['agent_name'] },
              reason: `Agent wants to install ${type} "${name}" into the organization`,
            });
            if (!approved) return JSON.stringify({ status: 'rejected', reason: comment || 'User denied package installation' });
          }

          if (type === 'agent') {
            try {
              const result = await installArtifact(type, name);
              return JSON.stringify({
                status: 'success',
                ...result,
                next_steps: 'Installed successfully. Next: onboard new agent with project context via agent_send_message, then assign tasks via task_create.',
              });
            } catch {
              const hireFromTemplate = ctx.hireFromTemplate?.();
              if (hireFromTemplate) {
                const agentName = (args['agent_name'] as string | undefined)?.trim();
                if (!agentName) return JSON.stringify({ status: 'error', error: 'agent_name is required when installing from a built-in role — provide a display name for the new agent' });
                const result = await hireFromTemplate(name, agentName, args['skills'] as string[] | undefined);
                return JSON.stringify({
                  status: 'success',
                  type: 'agent',
                  agent: result,
                  next_steps: 'Agent hired and started. Next: onboard with project context via agent_send_message, then assign tasks via task_create.',
                });
              }
              throw new Error(`Agent package not found: ${name}. Use package_list to see available packages.`);
            }
          }

          const result = await installArtifact(type as 'team' | 'skill', name);
          return JSON.stringify({
            status: 'success',
            ...result,
            ...(type === 'team' ? {
              next_steps: 'Installed successfully. Next: onboard new agent(s) with project context via agent_send_message, then assign initial tasks via task_create.',
            } : {}),
          });
        } catch (error) {
          return JSON.stringify({ status: 'error', error: String(error) });
        }
      },
    } as AgentToolHandler,

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
        const searchHub = ctx.searchHub?.();
        if (!searchHub) return JSON.stringify({ status: 'error', error: 'Hub service is not available. Please try again later.' });
        try {
          const items = await searchHub({
            type: args['type'] as string | undefined,
            query: args['query'] as string | undefined,
          });
          return JSON.stringify({ items, count: items.length });
        } catch (error) {
          return JSON.stringify({ status: 'error', error: String(error) });
        }
      },
    } as AgentToolHandler,

    {
      name: 'hub_install',
      description: 'Download an item from Markus Hub and install it. Combines download, save as artifact, and install into a single step. Requires user approval. For agents/teams: remember to onboard the new agent(s) after installation.',
      inputSchema: {
        type: 'object',
        properties: {
          item_id: { type: 'string', description: 'Hub item ID (from hub_search results)' },
        },
        required: ['item_id'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const downloadAndInstall = ctx.downloadAndInstall?.();
        if (!downloadAndInstall) return JSON.stringify({ status: 'error', error: 'Hub service is not available. Please try again later.' });
        try {
          const itemId = (args['item_id'] as string | undefined)?.trim();
          if (!itemId) return JSON.stringify({ status: 'error', error: 'item_id is required — use hub_search to find available items first' });

          if (ctx.requestApproval) {
            const { approved, comment } = await ctx.requestApproval({
              toolName: 'hub_install',
              toolArgs: { item_id: itemId },
              reason: `Agent wants to download and install Hub item "${itemId}" into the organization`,
            });
            if (!approved) return JSON.stringify({ status: 'rejected', reason: comment || 'User denied Hub installation' });
          }

          const result = await downloadAndInstall(itemId);
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
    } as AgentToolHandler,
  ];
}

export function createManagerTools(ctx: ManagerToolsContext): AgentToolHandler[] {
  return [
    {
      name: 'team_list',
      description: 'List all agents in your team with their roles, skills, and current status.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      async execute(): Promise<string> {
        const agents = ctx.listAgents();
        return JSON.stringify({ agents, count: agents.length });
      },
    },
    {
      name: 'team_status',
      description: 'Get detailed status of all team members including current tasks and token usage.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      async execute(): Promise<string> {
        const status = ctx.getTeamStatus();
        return JSON.stringify({ team: status, count: status.length });
      },
    },
    {
      name: 'delegate_message',
      description: 'Send a message to a specific agent on your team. Use this to delegate work or ask for updates.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The ID of the agent to send the message to' },
          message: { type: 'string', description: 'The message to send' },
        },
        required: ['agent_id', 'message'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const targetId = args['agent_id'] as string;
        const message = args['message'] as string;
        ctx.delegateMessage(targetId, message, 'manager').catch((err: unknown) => {
          log.warn(`Delegated task to ${targetId} failed in background`, { error: String(err) });
        });
        return JSON.stringify({ status: 'dispatched', message: 'Task dispatched. The agent will work on it independently.' });
      },
    },

    ...(ctx.findDuplicateTasks
      ? [
          {
            name: 'task_check_duplicates',
            description: 'Check for duplicate tasks on the board. Returns groups of suspected duplicate tasks that have similar titles within the same requirement/agent scope. Use during heartbeat to maintain board hygiene.',
            inputSchema: {
              type: 'object',
              properties: {
                org_id: { type: 'string', description: 'Organization ID to check' },
              },
              required: ['org_id'],
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                const groups = ctx.findDuplicateTasks!(args['org_id'] as string);
                return JSON.stringify({
                  status: 'success',
                  duplicateGroups: groups,
                  totalGroups: groups.length,
                  message: groups.length === 0
                    ? 'No duplicates found.'
                    : `Found ${groups.length} group(s) of suspected duplicates. Review and use task_cleanup_duplicates to cancel them.`,
                });
              } catch (error) {
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
        ]
      : []),

    ...(ctx.cleanupDuplicateTasks
      ? [
          {
            name: 'task_cleanup_duplicates',
            description: 'Auto-cancel duplicate pending/assigned tasks. For each group of duplicates, keeps the oldest task and cancels the rest. Returns the list of cancelled task IDs.',
            inputSchema: {
              type: 'object',
              properties: {
                org_id: { type: 'string', description: 'Organization ID to clean up' },
              },
              required: ['org_id'],
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                const result = ctx.cleanupDuplicateTasks!(args['org_id'] as string);
                return JSON.stringify({
                  status: 'success',
                  ...result,
                  message: result.count === 0
                    ? 'No duplicates to clean up.'
                    : `Cancelled ${result.count} duplicate task(s).`,
                });
              } catch (error) {
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
        ]
      : []),

    ...(ctx.getTaskBoardHealth
      ? [
          {
            name: 'task_board_health',
            description: 'Get a health summary of the task board: status counts, duplicate warnings, stale blocked tasks, unassigned tasks, and agent workload. Use during heartbeat for board hygiene.',
            inputSchema: {
              type: 'object',
              properties: {
                org_id: { type: 'string', description: 'Organization ID to check' },
              },
              required: ['org_id'],
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                const health = ctx.getTaskBoardHealth!(args['org_id'] as string);
                return JSON.stringify({ status: 'success', ...health });
              } catch (error) {
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
        ]
      : []),

    ...(ctx.updateTeam
      ? [
          {
            name: 'team_update',
            description: 'Update your team\'s name or description.',
            inputSchema: {
              type: 'object',
              properties: {
                team_id: { type: 'string', description: 'Team ID to update (defaults to your own team)' },
                name: { type: 'string', description: 'New team name' },
                description: { type: 'string', description: 'New team description' },
              },
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                const teamId = (args['team_id'] as string | undefined)?.trim();
                const name = (args['name'] as string | undefined)?.trim();
                const description = args['description'] as string | undefined;
                if (!teamId) return JSON.stringify({ status: 'error', error: 'team_id is required' });
                if (name === undefined && description === undefined) {
                  return JSON.stringify({ status: 'error', error: 'At least one of name or description must be provided' });
                }
                const data: { name?: string; description?: string } = {};
                if (name !== undefined) data.name = name;
                if (description !== undefined) data.description = description;
                const result = await ctx.updateTeam!(teamId, data);
                return JSON.stringify({ status: 'success', team: result });
              } catch (error) {
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
        ]
      : []),

    ...(ctx.updateAgentConfig
      ? [
          {
            name: 'agent_update',
            description: 'Update an agent\'s display name. Only agents in your team can be updated.',
            inputSchema: {
              type: 'object',
              properties: {
                agent_id: { type: 'string', description: 'The ID of the agent to update' },
                name: { type: 'string', description: 'New display name for the agent' },
              },
              required: ['agent_id', 'name'],
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                const agentId = (args['agent_id'] as string | undefined)?.trim();
                const name = (args['name'] as string | undefined)?.trim();
                if (!agentId) return JSON.stringify({ status: 'error', error: 'agent_id is required' });
                if (!name) return JSON.stringify({ status: 'error', error: 'name is required' });
                const result = await ctx.updateAgentConfig!(agentId, { name });
                return JSON.stringify({ status: 'success', agent: result });
              } catch (error) {
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
        ]
      : []),
  ];
}
