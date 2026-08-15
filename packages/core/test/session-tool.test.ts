import { describe, it, expect, vi } from 'vitest';
import { createSessionTool, normalizeSessionArgs } from '../src/tools/session.js';
import type { SessionToolContext } from '../src/tools/session.js';

function makeMsg(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cm-1', sessionId: 'cs-1', agentId: 'agt-A', role: 'user', content: 'hi',
    metadata: null, tokensUsed: 0, createdAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function makeSession(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cs-1', agentId: 'agt-A', userId: 'u1', title: 'Main', isMain: true,
    createdAt: '2026-01-01T00:00:00Z', lastMessageAt: '2026-02-01T00:00:00Z',
    ...over,
  };
}

function makeCtx(over: Partial<SessionToolContext> = {}): SessionToolContext {
  return {
    agentId: 'agt-A',
    chatSessionRepo: {
      listSessionsPaginated: vi.fn(() => ({
        sessions: [makeSession()], total: 1, page: 1, pageSize: 20, hasMore: false,
      })),
      getSession: vi.fn(() => makeSession()),
      listMessagesPaginated: vi.fn(() => ({
        messages: [makeMsg()], total: 1, page: 1, pageSize: 50, hasMore: false,
      })),
      countMessagesByAgent: vi.fn(() => 0),
    } as never,
    ...over,
  };
}

describe('normalizeSessionArgs', () => {
  it('识别 session_list', () => {
    expect(normalizeSessionArgs({ operation: 'list', since: '2026-01-01', page: 2 }))
      .toMatchObject({ operation: 'list', since: '2026-01-01', page: 2 });
  });
  it('识别 session_get', () => {
    expect(normalizeSessionArgs({ session_id: 'cs-1', page_size: 10 }))
      .toMatchObject({ operation: 'get', sessionId: 'cs-1', pageSize: 10 });
  });
  it('无参默认 list', () => {
    expect(normalizeSessionArgs({}).operation).toBe('list');
  });
  it('id 别名 & 显式 operation 覆盖', () => {
    expect(normalizeSessionArgs({ id: 'cs-9' }).sessionId).toBe('cs-9');
    expect(normalizeSessionArgs({ operation: 'list', session_id: 'cs-9' }).operation).toBe('list');
  });
});

describe('createSessionTool', () => {
  it('工具名与 schema 正确', () => {
    const tool = createSessionTool(makeCtx());
    expect(tool.name).toBe('session');
    expect(tool.description).toContain('session_list');
    expect(tool.description).toContain('session_get');
  });

  it('session_list 返回分页 + total + hasMore', async () => {
    const ctx = makeCtx();
    const tool = createSessionTool(ctx);
    const res = JSON.parse(await tool.execute({ operation: 'list', page_size: 20 }));
    expect(res.status).toBe('ok');
    expect(res.sessions).toHaveLength(1);
    expect(res.total).toBe(1);
    expect(res.hasMore).toBe(false);
    expect(res.sessions[0]).toMatchObject({ id: 'cs-1', agentId: 'agt-A', title: 'Main' });
  });

  it('session_list 透传 since/until/user_id 到 repo（强制用调用者自身 agentId）', async () => {
    const list = vi.fn(() => ({ sessions: [], total: 0, page: 1, pageSize: 20, hasMore: false }));
    const ctx = makeCtx({ chatSessionRepo: { listSessionsPaginated: list } as never });
    await createSessionTool(ctx).execute({ operation: 'list', since: 'S', until: 'U', agent_id: 'agt-X', page: 2, page_size: 7 });
    // 安全性：list 始终使用调用者 agentId，忽略传入的 agent_id
    expect(list).toHaveBeenCalledWith('agt-A', {
      since: 'S', until: 'U', page: 2, pageSize: 7,
    });
  });

  it('session_get 归属可访问', async () => {
    const repo = {
      getSession: vi.fn(() => makeSession()), // agentId === 'agt-A' === ctx.agentId
      listMessagesPaginated: vi.fn(() => ({ messages: [makeMsg()], total: 1, page: 1, pageSize: 50, hasMore: false })),
    } as never;
    const ctx = makeCtx({ chatSessionRepo: repo });
    const res = JSON.parse(await createSessionTool(ctx).execute({ operation: 'get', session_id: 'cs-1' }));
    expect(res.status).toBe('ok');
    expect(res.session.id).toBe('cs-1');
    expect(res.messages).toHaveLength(1);
    expect(res.totalMessages).toBe(1);
  });

  it('session_get 参与可访问（本 agent 在该 session 发过消息）', async () => {
    const repo = {
      getSession: vi.fn(() => makeSession({ agentId: 'agt-OTHER' })), // 非归属
      countMessagesByAgent: vi.fn(() => 3), // 但本 agent 参与过
      listMessagesPaginated: vi.fn(() => ({ messages: [makeMsg()], total: 1, page: 1, pageSize: 50, hasMore: false })),
    } as never;
    const ctx = makeCtx({ chatSessionRepo: repo });
    const res = JSON.parse(await createSessionTool(ctx).execute({ session_id: 'cs-1' }));
    expect(res.status).toBe('ok');
    expect(repo.countMessagesByAgent).toHaveBeenCalledWith('cs-1', 'agt-A');
  });

  it('session_get 他人且未参与 → forbidden', async () => {
    const repo = {
      getSession: vi.fn(() => makeSession({ agentId: 'agt-OTHER' })),
      countMessagesByAgent: vi.fn(() => 0),
    } as never;
    const ctx = makeCtx({ chatSessionRepo: repo });
    const res = JSON.parse(await createSessionTool(ctx).execute({ session_id: 'cs-other' }));
    expect(res.status).toBe('forbidden');
  });

  it('session_get 不存在的 session → 404 语义', async () => {
    const repo = { getSession: vi.fn(() => null) } as never;
    const ctx = makeCtx({ chatSessionRepo: repo });
    const res = JSON.parse(await createSessionTool(ctx).execute({ session_id: 'cs-missing' }));
    expect(res.status).toBe('not_found');
  });

  it('session_get 缺 session_id → 错误提示', async () => {
    const tool = createSessionTool(makeCtx());
    const res = JSON.parse(await tool.execute({ operation: 'get' }));
    expect(res.status).toBe('error');
    expect(res.message).toContain('session_id');
  });

  it('错误被捕获 → status error', async () => {
    const repo = { listSessionsPaginated: vi.fn(() => { throw new Error('boom'); }) } as never;
    const ctx = makeCtx({ chatSessionRepo: repo });
    const res = JSON.parse(await createSessionTool(ctx).execute({ operation: 'list' }));
    expect(res.status).toBe('error');
  });
});
