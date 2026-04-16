import type { AgentToolHandler } from '../agent.js';
import { createLogger } from '@markus/shared';
import type { TaskDelegation, DelegationResult } from '@markus/a2a';

const log = createLogger('a2a-tools');

export interface A2AContext {
  selfId: string;
  selfName: string;
  listColleagues: () => Array<{ id: string; name: string; role: string; status: string; skills?: string[] }>;
  sendMessage: (targetId: string, message: string, fromId: string, fromName: string, priority?: number) => Promise<string>;
  delegateTask?: (targetId: string, delegation: TaskDelegation) => Promise<DelegationResult>;
  sendGroupMessage?: (channelKey: string, message: string, senderId: string, senderName: string) => Promise<string>;
  createGroupChat?: (name: string, memberIds: string[]) => Promise<{ id: string; name: string }>;
  listGroupChats?: () => Promise<Array<{ id: string; name: string; type: string; channelKey: string }>>;
}

export function createA2ATools(ctx: A2AContext): AgentToolHandler[] {
  return [
    {
      name: 'agent_send_message',
      description: [
        'Send a message to another agent (colleague) in your organization.',
        'This tool is for STATUS NOTIFICATIONS, QUICK COORDINATION, and SIMPLE QUESTIONS only.',
        'Two modes: (1) wait_for_reply=true — block until the target agent responds, then return their reply.',
        'Use this when you need feedback, an answer, or a decision (e.g., asking a question, requesting a review opinion).',
        '(2) wait_for_reply=false (default) — fire-and-forget notification.',
        'Use this for one-way announcements (e.g., "I submitted task X for review", status updates).',
        'IMPORTANT: Do NOT use this tool to request substantial work from another agent.',
        'If you need another agent to perform multi-step work, file changes, or extended execution,',
        'use requirement_propose + task_create instead — tasks provide tracking, review, and audit trail.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The ID of the agent to message' },
          message: { type: 'string', description: 'The message to send' },
          wait_for_reply: {
            type: 'boolean',
            description: 'If true, wait for the target agent to process the message and return their reply. Use for questions/requests. Default: false (notification mode).',
          },
        },
        required: ['agent_id', 'message'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const targetId = args['agent_id'] as string;
        const message = args['message'] as string;
        const waitForReply = (args['wait_for_reply'] as boolean) ?? false;

        if (targetId === ctx.selfId) {
          return JSON.stringify({ status: 'error', error: 'Cannot send a message to yourself' });
        }

        if (waitForReply) {
          log.info(`A2A request (sync): ${ctx.selfName} → ${targetId}`, { messageLen: message.length });
          try {
            const reply = await ctx.sendMessage(targetId, message, ctx.selfId, ctx.selfName, 0);
            log.info(`A2A reply received: ${targetId} → ${ctx.selfName}`, { replyLen: reply.length });
            return JSON.stringify({ status: 'replied', from: targetId, reply });
          } catch (err: unknown) {
            log.warn(`A2A sync message to ${targetId} failed`, { error: String(err) });
            return JSON.stringify({ status: 'error', error: `Failed to get reply: ${String(err)}` });
          }
        }

        log.info(`A2A notify (async): ${ctx.selfName} → ${targetId}`, { messageLen: message.length });
        ctx.sendMessage(targetId, message, ctx.selfId, ctx.selfName).catch((err: unknown) => {
          log.warn(`A2A async message to ${targetId} failed in background`, { error: String(err) });
        });
        return JSON.stringify({ status: 'dispatched', message: 'Notification sent. The agent will process it independently.' });
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
