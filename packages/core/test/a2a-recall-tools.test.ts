import { describe, it, expect, vi } from 'vitest';
import { createA2ATools, type A2AContext } from '../src/tools/a2a.js';
import { createRecallTool } from '../src/tools/recall.js';

function makeA2AContext(overrides: Partial<A2AContext> = {}): A2AContext {
  return {
    selfId: 'agt_self',
    selfName: 'Self Agent',
    listColleagues: () => [
      { id: 'agt_peer', name: 'Peer', role: 'worker', status: 'idle', teamId: 'team_a', teamName: 'Alpha', agentRole: 'worker', skills: ['search'] },
      { id: 'agt_mgr', name: 'Manager', role: 'manager', status: 'busy', teamId: 'team_a', teamName: 'Alpha', agentRole: 'manager' },
      { id: 'agt_other', name: 'Other', role: 'worker', status: 'idle', teamId: 'team_b', teamName: 'Beta', agentRole: 'worker' },
    ],
    sendMessage: vi.fn(async () => 'reply'),
    delegateTask: vi.fn(async () => ({ status: 'accepted' as const, taskId: 'task_1' })),
    sendGroupMessage: vi.fn(async () => 'sent'),
    createGroupChat: vi.fn(async (name, members) => ({ id: 'grp_1', name })),
    listGroupChats: vi.fn(async () => [{ id: 'grp_1', name: 'Team Chat', type: 'group', channelKey: 'group:team_a' }]),
    getChannelMessages: vi.fn(async () => ({
      messages: [{
        id: 'msg_1',
        senderName: 'Peer',
        senderType: 'agent',
        text: 'Hello team',
        replyToId: 'msg_0',
        replyToSender: 'Self Agent',
        createdAt: new Date().toISOString(),
      }],
      hasMore: false,
    })),
    ...overrides,
  };
}

function findA2ATool(ctx: A2AContext, name: string) {
  const tool = createA2ATools(ctx).find(t => t.name === name);
  if (!tool) throw new Error(`A2A tool ${name} not found`);
  return tool;
}

describe('createA2ATools', () => {
  it('agent_send_message rejects self-messaging', async () => {
    const ctx = makeA2AContext();
    const result = JSON.parse(await findA2ATool(ctx, 'agent_send_message').execute({
      agent_id: 'agt_self',
      message: 'hi',
    }));
    expect(result.status).toBe('error');
  });

  it('agent_send_message dispatches async with conversation id', async () => {
    const ctx = makeA2AContext();
    const result = JSON.parse(await findA2ATool(ctx, 'agent_send_message').execute({
      agent_id: 'agt_peer',
      message: 'Hello',
      wait_for_reply: true,
    }));
    expect(result.status).toBe('dispatched');
    expect(result.conversation_id).toBeDefined();
    expect(ctx.sendMessage).toHaveBeenCalled();
  });

  it('agent_list_colleagues groups by team with manager badge', async () => {
    const ctx = makeA2AContext();
    const text = await findA2ATool(ctx, 'agent_list_colleagues').execute({});
    expect(text).toContain('Team: Alpha');
    expect(text).toContain('[Manager]');
    expect(text).toContain('Team: Beta');
  });

  it('agent_send_group_message sends and handles errors', async () => {
    const ctx = makeA2AContext();
    const ok = JSON.parse(await findA2ATool(ctx, 'agent_send_group_message').execute({
      channel_key: 'group:team_a',
      message: '@Peer update',
      reply_to_message_id: 'msg_0',
    }));
    expect(ok.status).toBe('sent');

    const failCtx = makeA2AContext({
      sendGroupMessage: vi.fn(async () => { throw new Error('channel closed'); }),
    });
    const err = JSON.parse(await findA2ATool(failCtx, 'agent_send_group_message').execute({
      channel_key: 'group:team_a',
      message: 'fail',
    }));
    expect(err.status).toBe('error');
  });

  it('agent_create_group_chat and list_group_chats work', async () => {
    const ctx = makeA2AContext();
    const created = JSON.parse(await findA2ATool(ctx, 'agent_create_group_chat').execute({
      name: 'Sprint Chat',
      member_ids: ['agt_peer'],
    }));
    expect(created.status).toBe('created');

    const listed = JSON.parse(await findA2ATool(ctx, 'agent_list_group_chats').execute({}));
    expect(listed.count).toBe(1);
  });

  it('recall_context fetches channel messages and infers scope', async () => {
    const ctx = makeA2AContext();
    const result = JSON.parse(await findA2ATool(ctx, 'recall_context').execute({
      channel_key: 'group:team_a',
      limit: 10,
    }));
    expect(result.count).toBe(1);
    expect(result.messages[0]).toContain('Peer');

    const missing = JSON.parse(await findA2ATool(ctx, 'recall_context').execute({ scope: 'channel' }));
    expect(missing.status).toBe('error');

    const unknown = JSON.parse(await findA2ATool(ctx, 'recall_context').execute({ scope: 'unknown' }));
    expect(unknown.status).toBe('error');
  });
});

describe('createRecallTool', () => {
  const baseCtx = {
    agentId: 'agt_1',
    listActivities: vi.fn(() => [{
      id: 'act_1',
      type: 'task',
      label: 'Deploy',
      taskId: 'task_1',
      startedAt: new Date().toISOString(),
      totalTokens: 100,
      totalTools: 3,
      success: true,
      summary: 'Deployed successfully',
    }]),
    getActivityLogs: vi.fn((id: string) => id === 'act_1'
      ? [{ seq: 1, type: 'log', content: 'Started deploy', createdAt: new Date().toISOString() }]
      : []),
    searchActivities: vi.fn(() => []),
  };

  it('lists activities with filters', async () => {
    const tool = createRecallTool(baseCtx);
    const result = JSON.parse(await tool.execute({ operation: 'list', type: 'task', limit: 5 }));
    expect(result.status).toBe('ok');
    expect(result.activities).toHaveLength(1);
  });

  it('returns empty list message', async () => {
    const tool = createRecallTool({
      ...baseCtx,
      listActivities: vi.fn(() => []),
    });
    const result = JSON.parse(await tool.execute({ operation: 'list' }));
    expect(result.message).toContain('No activities');
  });

  it('gets activity logs with truncation for long content', async () => {
    const tool = createRecallTool({
      ...baseCtx,
      getActivityLogs: vi.fn(() => [{
        seq: 1,
        type: 'log',
        content: 'x'.repeat(600),
        createdAt: new Date().toISOString(),
      }]),
    });
    const result = JSON.parse(await tool.execute({ operation: 'get', activity_id: 'act_1' }));
    expect(result.logs[0].content).toContain('truncated');
  });

  it('search requires query and backend', async () => {
    const tool = createRecallTool(baseCtx);
    expect(JSON.parse(await tool.execute({ operation: 'search' })).status).toBe('error');

    const noSearch = createRecallTool({
      agentId: 'agt_1',
      listActivities: baseCtx.listActivities,
      getActivityLogs: baseCtx.getActivityLogs,
    });
    expect(JSON.parse(await noSearch.execute({ operation: 'search', query: 'deploy' })).status).toBe('error');
  });

  it('search returns matches', async () => {
    const tool = createRecallTool({
      ...baseCtx,
      searchActivities: vi.fn(() => [{
        id: 'act_2',
        type: 'chat',
        label: 'Debug session',
        startedAt: new Date().toISOString(),
        totalTokens: 50,
        totalTools: 1,
        success: true,
        summary: 'Found auth error',
      }]),
    });
    const result = JSON.parse(await tool.execute({ operation: 'search', query: 'auth' }));
    expect(result.activities).toHaveLength(1);
  });

  it('handles list/get errors and unknown operation', async () => {
    const tool = createRecallTool({
      ...baseCtx,
      listActivities: vi.fn(() => { throw new Error('db down'); }),
    });
    expect(JSON.parse(await tool.execute({ operation: 'list' })).status).toBe('error');
    expect(JSON.parse(await tool.execute({ operation: 'get' })).status).toBe('error');
    expect(JSON.parse(await tool.execute({ operation: 'bogus' })).status).toBe('error');
  });
});
