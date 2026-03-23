import type { AgentToolHandler } from '../agent.js';
import { createLogger } from '@markus/shared';

const log = createLogger('manager-tools');

export interface CreateTaskParams {
  title: string;
  description: string;
  assignedAgentId: string;
  reviewerAgentId: string;
  priority?: string;
  blockedBy?: string[];
  requirementId?: string;
  projectId?: string;
}

export interface ManagerToolsContext {
  listAgents: () => Array<{ id: string; name: string; role: string; status: string; skills?: string[] }>;
  delegateMessage: (agentId: string, message: string, fromManager: string) => Promise<string>;
  createTask: (params: CreateTaskParams) => string;
  getTeamStatus: () => Array<{ id: string; name: string; role: string; status: string; currentTask?: string; tokensUsedToday: number }>;
  findDuplicateTasks?: (orgId: string) => Array<{ group: string; tasks: Array<{ id: string; title: string; status: string; createdAt: string }> }>;
  cleanupDuplicateTasks?: (orgId: string) => { cancelledIds: string[]; count: number };
  getTaskBoardHealth?: (orgId: string) => Record<string, unknown>;
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
    {
      name: 'create_task',
      description: [
        'Create a new task and assign it to a team member with a designated reviewer.',
        'IMPORTANT: assigned_agent_id and reviewer_agent_id are required — use team_list first.',
        'Use blocked_by to declare dependencies on other tasks.',
        'Always provide requirement_id and project_id for tasks.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Task title' },
          description: { type: 'string', description: 'Detailed task description' },
          assigned_agent_id: { type: 'string', description: 'Agent ID to assign this task to. REQUIRED. Use team_list to find the right agent by role/skills.' },
          reviewer_agent_id: { type: 'string', description: 'Agent ID who will review the task when execution finishes. REQUIRED — must differ from assigned_agent_id when both are agents.' },
          priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'], description: 'Task priority' },
          blocked_by: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of task IDs that must complete before this task can start. Use this to express dependencies between tasks.',
          },
          requirement_id: { type: 'string', description: 'ID of the approved requirement this task fulfills. Required for tasks.' },
          project_id: { type: 'string', description: 'Project ID this task belongs to.' },
        },
        required: ['title', 'description', 'assigned_agent_id', 'reviewer_agent_id'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        try {
          const assignedAgentId = args['assigned_agent_id'] as string | undefined;
          const reviewerAgentId = args['reviewer_agent_id'] as string | undefined;
          if (!assignedAgentId?.trim()) {
            return JSON.stringify({
              status: 'error',
              error: 'assigned_agent_id is required. Use team_list to find the right agent.',
            });
          }
          if (!reviewerAgentId?.trim()) {
            return JSON.stringify({
              status: 'error',
              error: 'reviewer_agent_id is required. Every task must have a designated reviewer.',
            });
          }
          if (reviewerAgentId === assignedAgentId) {
            return JSON.stringify({
              status: 'error',
              error: 'reviewer_agent_id must differ from assigned_agent_id.',
            });
          }
          const taskId = ctx.createTask({
            title: args['title'] as string,
            description: args['description'] as string,
            assignedAgentId,
            reviewerAgentId,
            priority: args['priority'] as string | undefined,
            blockedBy: args['blocked_by'] as string[] | undefined,
            requirementId: args['requirement_id'] as string | undefined,
            projectId: args['project_id'] as string | undefined,
          });
          return JSON.stringify({ status: 'success', taskId });
        } catch (error) {
          return JSON.stringify({ status: 'error', error: String(error) });
        }
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
  ];
}
