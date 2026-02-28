import type { AgentToolHandler } from '../agent.js';
import { createLogger } from '@markus/shared';

const log = createLogger('manager-tools');

export interface ManagerToolsContext {
  listAgents: () => Array<{ id: string; name: string; role: string; status: string; skills?: string[] }>;
  delegateMessage: (agentId: string, message: string, fromManager: string) => Promise<string>;
  createTask: (title: string, description: string, assignedAgentId?: string, priority?: string) => string;
  getTeamStatus: () => Array<{ id: string; name: string; role: string; status: string; currentTask?: string; tokensUsedToday: number }>;
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
      description: 'Create a new task and optionally assign it to a team member.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Task title' },
          description: { type: 'string', description: 'Detailed task description' },
          assigned_agent_id: { type: 'string', description: 'Optional: ID of the agent to assign this task to' },
          priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'], description: 'Task priority' },
        },
        required: ['title', 'description'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        try {
          const taskId = ctx.createTask(
            args['title'] as string,
            args['description'] as string,
            args['assigned_agent_id'] as string | undefined,
            args['priority'] as string | undefined,
          );
          return JSON.stringify({ status: 'success', taskId });
        } catch (error) {
          return JSON.stringify({ status: 'error', error: String(error) });
        }
      },
    },
  ];
}
