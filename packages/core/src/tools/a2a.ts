import type { AgentToolHandler } from '../agent.js';
import { createLogger } from '@markus/shared';

const log = createLogger('a2a-tools');

export interface A2AContext {
  selfId: string;
  selfName: string;
  listColleagues: () => Array<{ id: string; name: string; role: string; status: string; skills?: string[] }>;
  sendMessage: (targetId: string, message: string, fromId: string, fromName: string) => Promise<string>;
}

export function createA2ATools(ctx: A2AContext): AgentToolHandler[] {
  return [
    {
      name: 'agent_send_message',
      description: 'Send a message to another agent (colleague) in your organization. Use this to collaborate, ask questions, or request help from teammates.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The ID of the agent to message' },
          message: { type: 'string', description: 'The message to send' },
        },
        required: ['agent_id', 'message'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const targetId = args['agent_id'] as string;
        const message = args['message'] as string;

        if (targetId === ctx.selfId) {
          return JSON.stringify({ status: 'error', error: 'Cannot send a message to yourself' });
        }

        try {
          log.info(`A2A message: ${ctx.selfName} → ${targetId}`, { messageLen: message.length });
          const reply = await ctx.sendMessage(targetId, message, ctx.selfId, ctx.selfName);
          return JSON.stringify({ status: 'delivered', reply: reply.slice(0, 3000) });
        } catch (error) {
          return JSON.stringify({ status: 'error', error: String(error) });
        }
      },
    },
    {
      name: 'agent_list_colleagues',
      description: 'List all other agents in your organization that you can collaborate with. Shows their names, roles, skills, and current status.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      async execute(): Promise<string> {
        const colleagues = ctx.listColleagues().filter(a => a.id !== ctx.selfId);
        return JSON.stringify({ colleagues, count: colleagues.length });
      },
    },
  ];
}
