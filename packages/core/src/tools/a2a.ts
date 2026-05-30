import type { AgentToolHandler } from '../agent.js';
import { createLogger, generateId } from '@markus/shared';
import type { TaskDelegation, DelegationResult } from '@markus/a2a';

const log = createLogger('a2a-tools');

export interface A2AContext {
  selfId: string;
  selfName: string;
  listColleagues: () => Array<{ id: string; name: string; role: string; status: string; skills?: string[]; teamId?: string; teamName?: string; agentRole?: string }>;
  sendMessage: (targetId: string, message: string, fromId: string, fromName: string, priority?: number, waitForReply?: boolean) => Promise<string>;
  delegateTask?: (targetId: string, delegation: TaskDelegation) => Promise<DelegationResult>;
  sendGroupMessage?: (channelKey: string, message: string, senderId: string, senderName: string, replyToId?: string) => Promise<string>;
  createGroupChat?: (name: string, memberIds: string[]) => Promise<{ id: string; name: string }>;
  listGroupChats?: () => Promise<Array<{ id: string; name: string; type: string; channelKey: string }>>;
  getChannelMessages?: (channelKey: string, limit: number, before?: string) => Promise<{ messages: Array<{ id?: string; senderName: string; senderType: string; text: string; replyToId?: string; replyToSender?: string; replyToText?: string; createdAt: string }>; hasMore: boolean }>;
}

export function createA2ATools(ctx: A2AContext): AgentToolHandler[] {
  return [
    {
      name: 'agent_send_message',
      description: [
        'Send a message to another agent (colleague) in your organization.',
        'This tool is ALWAYS asynchronous (fire-and-forget): the message enters the target agent\'s mailbox and you continue working.',
        'The recipient will process it on their own schedule and may reply via their own agent_send_message.',
        'Use conversation_id to correlate multi-turn exchanges — you and the recipient will both see this ID.',
        'Record what you asked in your working memory so you recognize the reply when it arrives.',
        'IMPORTANT: Do NOT use this tool to request substantial work from another agent.',
        'If you need another agent to perform multi-step work, file changes, or extended execution,',
        'use requirement_propose + task_create instead — tasks provide tracking, review, and audit trail.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The ID of the agent to message' },
          message: { type: 'string', description: 'The message to send' },
          conversation_id: {
            type: 'string',
            description: 'Optional correlation ID for multi-turn exchanges. Auto-generated if omitted. Include this when replying to a previous message to maintain context.',
          },
          wait_for_reply: {
            type: 'boolean',
            description: '[DEPRECATED — ignored] A2A is always async. Record your question in working memory and process the reply when it arrives.',
          },
        },
        required: ['agent_id', 'message'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const targetId = args['agent_id'] as string;
        const message = args['message'] as string;
        const conversationId = (args['conversation_id'] as string) || generateId('conv');
        const waitForReply = args['wait_for_reply'] as boolean | undefined;

        if (targetId === ctx.selfId) {
          return JSON.stringify({ status: 'error', error: 'Cannot send a message to yourself' });
        }

        if (waitForReply) {
          log.warn(`A2A wait_for_reply=true is deprecated and ignored (deadlock risk). Sending async. Sender: ${ctx.selfName} → ${targetId}`);
        }

        const taggedMessage = `[conversation:${conversationId}]\n${message}`;
        log.info(`A2A send (async): ${ctx.selfName} → ${targetId}`, { messageLen: message.length, conversationId });
        ctx.sendMessage(targetId, taggedMessage, ctx.selfId, ctx.selfName, undefined, false).catch((err: unknown) => {
          log.warn(`A2A async message to ${targetId} failed in background`, { error: String(err) });
        });
        return JSON.stringify({
          status: 'dispatched',
          conversation_id: conversationId,
          message: 'Message sent asynchronously. The agent will process it on their schedule. Record your question in working memory to recognize the reply.',
        });
      },
    },
    {
      name: 'agent_list_colleagues',
      description: 'List all other agents in your organization grouped by team. Shows team structure, roles, skills, and current status.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      async execute(): Promise<string> {
        const colleagues = ctx.listColleagues().filter(a => a.id !== ctx.selfId);
        const byTeam = new Map<string, typeof colleagues>();
        for (const c of colleagues) {
          const key = c.teamId ?? '__ungrouped__';
          if (!byTeam.has(key)) byTeam.set(key, []);
          byTeam.get(key)!.push(c);
        }

        const lines: string[] = [];
        lines.push(`Organization colleagues: ${colleagues.length} agents\n`);

        for (const [teamId, members] of byTeam) {
          const manager = members.find(m => m.agentRole === 'manager');
          const teamLabel = members[0]?.teamName ?? teamId;
          if (teamId === '__ungrouped__') {
            lines.push(`── Ungrouped ──`);
          } else {
            lines.push(`── Team: ${teamLabel}${manager ? ` (manager: ${manager.name})` : ''} ──`);
          }
          const sorted = [...members].sort((a, b) => (a.agentRole === 'manager' ? -1 : b.agentRole === 'manager' ? 1 : 0));
          for (const m of sorted) {
            const badge = m.agentRole === 'manager' ? ' [Manager]' : '';
            const skills = m.skills?.length ? ` | skills: ${m.skills.join(', ')}` : '';
            lines.push(`  • ${m.name} (${m.id})${badge} — ${m.role} | ${m.status}${skills}`);
          }
          lines.push('');
        }
        return lines.join('\n');
      },
    },
    ...(ctx.sendGroupMessage ? [{
      name: 'agent_send_group_message',
      description: 'Send a message to a group chat channel. Use @Name or @[Full Name] in the message text to notify specific agents (this controls routing — without @, the message is just a broadcast). Use reply_to_message_id to create a visual reply link.',
      inputSchema: {
        type: 'object',
        properties: {
          channel_key: { type: 'string', description: 'The group chat channel key (e.g., "group:<teamId>")' },
          message: { type: 'string', description: 'The message to send. Use @Name or @[Full Name] to direct the message to specific agents.' },
          reply_to_message_id: { type: 'string', description: 'Optional. The ID of a specific channel message you are replying to. Creates a visual reply link in the chat UI.' },
        },
        required: ['channel_key', 'message'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const channelKey = args['channel_key'] as string;
        const message = args['message'] as string;
        const replyToId = args['reply_to_message_id'] as string | undefined;
        try {
          const result = await ctx.sendGroupMessage!(channelKey, message, ctx.selfId, ctx.selfName, replyToId);
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
    ...(ctx.getChannelMessages ? [{
      name: 'recall_context',
      description: [
        'Recall historical context you may need to respond effectively.',
        'Use this BEFORE responding when the provided context is insufficient.',
        '',
        'Supported scopes:',
        '• "channel" — Read chat messages from a group chat or DM channel. Requires channel_key.',
        '  Use when you joined a discussion late, were @mentioned, or need to understand prior conversation.',
        '',
        'For other context types, use these existing tools instead:',
        '• task_get — Full task details including all comments (scope=task context)',
        '• requirement_get — Full requirement details including all comments (scope=requirement context)',
        '• recall_activity — Your own execution history, activity logs, and past work (scope=your activities)',
        '• memory_search — Your saved memories and notes (scope=personal knowledge)',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            enum: ['channel'],
            description: 'Type of context to recall. Currently: "channel" for chat/group messages.',
          },
          channel_key: {
            type: 'string',
            description: 'Required when scope="channel". The channel key (e.g., "group:<teamId>" for team chats, "dm:<id1>_<id2>" for DMs).',
          },
          limit: { type: 'number', description: 'Number of items to fetch (default 80, max 200).' },
          before: { type: 'string', description: 'ISO timestamp — fetch items older than this for pagination. Omit for most recent.' },
        },
        required: ['scope'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        // Infer scope from provided arguments when the LLM omits it
        let scope = args['scope'] as string | undefined;
        if (!scope && args['channel_key']) {
          scope = 'channel';
        }

        if (scope === 'channel') {
          const channelKey = args['channel_key'] as string;
          if (!channelKey) {
            return JSON.stringify({ status: 'error', error: 'channel_key is required when scope="channel"' });
          }
          const limit = Math.min((args['limit'] as number) ?? 80, 200);
          const before = args['before'] as string | undefined;
          try {
            const result = await ctx.getChannelMessages!(channelKey, limit, before);
            const formatted = result.messages.map(m => {
              const prefix = m.id ? `[${m.id}]` : '';
              const sender = m.senderType === 'agent' ? `[agent] ${m.senderName}` : `[human] ${m.senderName}`;
              const replyInfo = m.replyToId ? ` (replying to ${m.replyToId}${m.replyToSender ? ` by ${m.replyToSender}` : ''})` : '';
              return `${prefix}[${m.createdAt}] ${sender}${replyInfo}: ${m.text.slice(0, 2000)}`;
            });
            return JSON.stringify({
              messages: formatted,
              count: result.messages.length,
              hasMore: result.hasMore,
              oldestTimestamp: result.messages[0]?.createdAt,
            });
          } catch (err) {
            return JSON.stringify({ status: 'error', error: String(err) });
          }
        }

        return JSON.stringify({
          status: 'error',
          error: `Unknown scope: "${scope}". Use "channel" for chat messages, or use task_get / requirement_get / recall_activity for other context.`,
        });
      },
    } as AgentToolHandler] : []),
  ];
}
