import type { AgentToolHandler } from '../agent.js';
import { createLogger } from '@markus/shared';

const log = createLogger('a2a-tools');

export interface A2AContext {
  selfId: string;
  selfName: string;
  listColleagues: () => Array<{ id: string; name: string; role: string; status: string; skills?: string[] }>;
  sendMessage: (targetId: string, message: string, fromId: string, fromName: string) => Promise<string>;
  sendGroupMessage?: (channelKey: string, message: string, senderId: string, senderName: string) => Promise<string>;
  createGroupChat?: (name: string, memberIds: string[]) => Promise<{ id: string; name: string }>;
  listGroupChats?: () => Promise<Array<{ id: string; name: string; type: string; channelKey: string }>>;
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

        log.info(`A2A message dispatched: ${ctx.selfName} → ${targetId}`, { messageLen: message.length });
        // Fire-and-forget: dispatch to target agent and return immediately.
        // The target agent works independently; do not block waiting for its reply.
        ctx.sendMessage(targetId, message, ctx.selfId, ctx.selfName).catch((err: unknown) => {
          log.warn(`A2A message to ${targetId} failed in background`, { error: String(err) });
        });
        return JSON.stringify({ status: 'dispatched', message: 'Message dispatched. The agent will process it independently.' });
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
    ...(ctx.sendGroupMessage ? [{
      name: 'agent_send_group_message',
      description: 'Send a message to a group chat channel (e.g., a team group chat). Messages are visible to all members.',
      inputSchema: {
        type: 'object',
        properties: {
          channel_key: { type: 'string', description: 'The group chat channel key (e.g., "group:<teamId>")' },
          message: { type: 'string', description: 'The message to send' },
        },
        required: ['channel_key', 'message'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const channelKey = args['channel_key'] as string;
        const message = args['message'] as string;
        try {
          const result = await ctx.sendGroupMessage!(channelKey, message, ctx.selfId, ctx.selfName);
          return JSON.stringify({ status: 'sent', result });
        } catch (err) {
          return JSON.stringify({ status: 'error', error: String(err) });
        }
      },
    } as AgentToolHandler] : []),
    ...(ctx.createGroupChat ? [{
      name: 'agent_create_group_chat',
      description: 'Create a new group chat with specific team members for focused discussion.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the group chat' },
          member_ids: { type: 'array', items: { type: 'string' }, description: 'IDs of agents/users to include' },
        },
        required: ['name'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const name = args['name'] as string;
        const memberIds = (args['member_ids'] as string[] | undefined) ?? [];
        try {
          const chat = await ctx.createGroupChat!(name, memberIds);
          return JSON.stringify({ status: 'created', chat });
        } catch (err) {
          return JSON.stringify({ status: 'error', error: String(err) });
        }
      },
    } as AgentToolHandler] : []),
    ...(ctx.listGroupChats ? [{
      name: 'agent_list_group_chats',
      description: 'List all available group chats in your organization, including team chats.',
      inputSchema: { type: 'object', properties: {} },
      async execute(): Promise<string> {
        try {
          const chats = await ctx.listGroupChats!();
          return JSON.stringify({ chats, count: chats.length });
        } catch (err) {
          return JSON.stringify({ status: 'error', error: String(err) });
        }
      },
    } as AgentToolHandler] : []),
  ];
}
