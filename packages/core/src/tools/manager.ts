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

    ...(ctx.listTemplates
      ? [
          {
            name: 'team_list_templates',
            description: 'List available agent templates that can be hired. Each template has a role, description, and category.',
            inputSchema: {
              type: 'object',
              properties: {},
            },
            async execute(): Promise<string> {
              try {
                const templates = ctx.listTemplates!();
                return JSON.stringify({ templates, count: templates.length });
              } catch (error) {
                return JSON.stringify({ status: 'error', error: String(error) });
              }
            },
          } as AgentToolHandler,
        ]
      : []),

    ...(ctx.hireFromTemplate
      ? [
          {
            name: 'team_hire_agent',
            description: 'Hire a new agent from a template and add them to your team. After hiring, onboard the agent: send a welcome message with project context via agent_send_message, then assign initial tasks via task_create.',
            inputSchema: {
              type: 'object',
              properties: {
                template_id: { type: 'string', description: 'Template ID (from team_list_templates)' },
                name: { type: 'string', description: 'Display name for the new agent' },
                skills: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Optional skill IDs to assign',
                },
              },
              required: ['template_id', 'name'],
            },
            async execute(args: Record<string, unknown>): Promise<string> {
              try {
                const result = await ctx.hireFromTemplate!(
                  args['template_id'] as string,
                  args['name'] as string,
                  args['skills'] as string[] | undefined,
                );
                return JSON.stringify({
                  status: 'success',
                  agent: result,
                  next_steps: 'Agent created and started. Next: onboard them with project context via agent_send_message, then assign initial tasks via task_create.',
                });
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
                const result = await ctx.installArtifact!(
                  args['type'] as 'agent' | 'team' | 'skill',
                  args['name'] as string,
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
