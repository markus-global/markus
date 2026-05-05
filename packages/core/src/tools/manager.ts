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
  hireFromTemplate?: (templateId: string, name: string, skills?: string[]) => Promise<{ id: string; name: string; role: string }>;
  listTemplates?: () => Array<{ id: string; name: string; description: string; roleId: string; category: string }>;
  installArtifact?: (type: 'agent' | 'team' | 'skill', name: string) => Promise<{ type: string; installed: unknown }>;
  listArtifacts?: (type?: 'agent' | 'team' | 'skill') => Array<{ type: string; name: string; description?: string }>;
  updateTeam?: (teamId: string, data: { name?: string; description?: string }) => Promise<{ id: string; name: string; description?: string }>;
  updateAgentConfig?: (agentId: string, data: { name?: string }) => Promise<{ id: string; name: string }>;
}

export interface BuilderToolsContext {
  installArtifact?: (type: 'agent' | 'team' | 'skill', name: string) => Promise<{ type: string; installed: unknown }>;
  listArtifacts?: (type?: 'agent' | 'team' | 'skill') => Array<{ type: string; name: string; description?: string }>;
}

export function createBuilderTools(ctx: BuilderToolsContext): AgentToolHandler[] {
  return [
    ...(ctx.listArtifacts
      ? [
          {
            name: 'builder_list',
            description: 'List builder artifacts (custom-created or Hub-downloaded agent/team/skill packages). These can be installed with builder_install.',
            inputSchema: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  enum: ['agent', 'team', 'skill'],
                  description: 'Filter by artifact type (optional)',
                },
              },
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                const artifacts = ctx.listArtifacts!(args['type'] as 'agent' | 'team' | 'skill' | undefined);
                return JSON.stringify({ artifacts, count: artifacts.length });
              } catch (error) {
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
        ]
      : []),

    ...(ctx.installArtifact
      ? [
          {
            name: 'builder_install',
            description: 'Install a builder artifact — deploys an agent, team, or skill package into the live organization. For agents/teams: after installation, onboard with project context and assign initial tasks.',
            inputSchema: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  enum: ['agent', 'team', 'skill'],
                  description: 'Artifact type',
                },
                name: { type: 'string', description: 'Artifact name (from builder_list)' },
              },
              required: ['type', 'name'],
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                const type = (args['type'] as string | undefined)?.trim() as 'agent' | 'team' | 'skill' | undefined;
                const name = (args['name'] as string | undefined)?.trim();
                if (!type || !['agent', 'team', 'skill'].includes(type)) return JSON.stringify({ status: 'error', error: 'type is required and must be one of: agent, team, skill' });
                if (!name) return JSON.stringify({ status: 'error', error: 'name is required — provide the artifact name from builder_list' });
                const result = await ctx.installArtifact!(
                  type,
                  name,
                );
                const isAgentOrTeam = result.type === 'agent' || result.type === 'team';
                return JSON.stringify({
                  status: 'success',
                  ...result,
                  ...(isAgentOrTeam ? {
                    next_steps: 'Installed successfully. Next: onboard new agent(s) with project context via agent_send_message, then assign initial tasks via task_create.',
                  } : {}),
                });
              } catch (error) {
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
        ]
      : []),
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
        // Fire-and-forget: dispatch to target agent and return immediately.
        // The target agent works independently; do not block waiting for its reply.
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

    ...(ctx.listArtifacts
      ? [
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
              try {
                const type = args['type'] as string | undefined;
                const artifacts = ctx.listArtifacts!(type as 'agent' | 'team' | 'skill' | undefined);
                const roles = (!type || type === 'agent') && ctx.listTemplates ? ctx.listTemplates() : [];
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

    ...(ctx.installArtifact
      ? [
          {
            name: 'package_install',
            description: 'Install a package into the live organization. type "agent": hire/install an agent (from a built-in role or a custom package). type "team": deploy a full team with all members, norms, and starter tasks. type "skill": install a skill package. Use package_list to see what is available.',
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
              try {
                const type = (args['type'] as string | undefined)?.trim();
                const name = (args['name'] as string | undefined)?.trim();
                if (!type || !['agent', 'team', 'skill'].includes(type)) return JSON.stringify({ status: 'error', error: 'type is required and must be one of: agent, team, skill' });
                if (!name) return JSON.stringify({ status: 'error', error: 'name is required — use package_list to see available packages' });

                if (type === 'agent') {
                  try {
                    const result = await ctx.installArtifact!(type, name);
                    return JSON.stringify({
                      status: 'success',
                      ...result,
                      next_steps: 'Installed successfully. Next: onboard new agent with project context via agent_send_message, then assign tasks via task_create.',
                    });
                  } catch {
                    if (ctx.hireFromTemplate) {
                      const agentName = (args['agent_name'] as string | undefined)?.trim();
                      if (!agentName) return JSON.stringify({ status: 'error', error: 'agent_name is required when installing from a built-in role — provide a display name for the new agent' });
                      const result = await ctx.hireFromTemplate(name, agentName, args['skills'] as string[] | undefined);
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

                const result = await ctx.installArtifact!(type as 'team' | 'skill', name);
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
        ]
      : []),
  ];
}
