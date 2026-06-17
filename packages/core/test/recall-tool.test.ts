import { describe, it, expect, vi } from 'vitest';
import { createRecallTool, type RecallContext } from '../src/tools/recall.js';

function makeCtx(overrides: Partial<RecallContext> = {}): RecallContext {
  return {
    agentId: 'agent-1',
    listActivities: vi.fn(() => []),
    getActivityLogs: vi.fn(() => []),
    searchActivities: vi.fn(() => []),
    ...overrides,
  };
}

describe('RecallTool', () => {
  it('has correct tool metadata', () => {
    const tool = createRecallTool(makeCtx());
    expect(tool.name).toBe('recall_activity');
    expect(tool.inputSchema.required).toContain('operation');
  });

  it('list returns empty activities', async () => {
    const tool = createRecallTool(makeCtx());
    const result = JSON.parse(await tool.execute({ operation: 'list' }));
    expect(result.status).toBe('ok');
    expect(result.activities).toEqual([]);
  });

  it('list returns activities with filters', async () => {
    const ctx = makeCtx({
      listActivities: vi.fn(() => [{
        id: 'act-1', type: 'task', label: 'Build feature', taskId: 'task-1',
        startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T01:00:00Z',
        totalTokens: 1000, totalTools: 5, success: true, summary: 'Done',
      }]),
    });
    const tool = createRecallTool(ctx);
    const result = JSON.parse(await tool.execute({ operation: 'list', type: 'task', task_id: 'task-1', limit: 10 }));
    expect(result.status).toBe('ok');
    expect(result.activities).toHaveLength(1);
    expect(result.activities[0].id).toBe('act-1');
  });

  it('list handles errors gracefully', async () => {
    const ctx = makeCtx({
      listActivities: vi.fn(() => { throw new Error('DB error'); }),
    });
    const tool = createRecallTool(ctx);
    const result = JSON.parse(await tool.execute({ operation: 'list' }));
    expect(result.status).toBe('error');
  });

  it('get requires activity_id', async () => {
    const tool = createRecallTool(makeCtx());
    const result = JSON.parse(await tool.execute({ operation: 'get' }));
    expect(result.status).toBe('error');
    expect(result.message).toContain('activity_id is required');
  });

  it('get returns logs', async () => {
    const ctx = makeCtx({
      getActivityLogs: vi.fn(() => [
        { seq: 1, type: 'tool_call', content: 'Called file_read', createdAt: '2024-01-01T00:00:00Z' },
      ]),
    });
    const tool = createRecallTool(ctx);
    const result = JSON.parse(await tool.execute({ operation: 'get', activity_id: 'act-1' }));
    expect(result.status).toBe('ok');
    expect(result.logs).toHaveLength(1);
  });

  it('get truncates long content', async () => {
    const ctx = makeCtx({
      getActivityLogs: vi.fn(() => [
        { seq: 1, type: 'tool_call', content: 'x'.repeat(1000), createdAt: '2024-01-01T00:00:00Z' },
      ]),
    });
    const tool = createRecallTool(ctx);
    const result = JSON.parse(await tool.execute({ operation: 'get', activity_id: 'act-1' }));
    expect(result.logs[0].content).toContain('[truncated]');
  });

  it('get returns empty for no logs', async () => {
    const tool = createRecallTool(makeCtx());
    const result = JSON.parse(await tool.execute({ operation: 'get', activity_id: 'missing' }));
    expect(result.status).toBe('ok');
    expect(result.logs).toEqual([]);
  });

  it('get handles errors gracefully', async () => {
    const ctx = makeCtx({
      getActivityLogs: vi.fn(() => { throw new Error('Not found'); }),
    });
    const tool = createRecallTool(ctx);
    const result = JSON.parse(await tool.execute({ operation: 'get', activity_id: 'act-1' }));
    expect(result.status).toBe('error');
  });

  it('search requires query', async () => {
    const tool = createRecallTool(makeCtx());
    const result = JSON.parse(await tool.execute({ operation: 'search' }));
    expect(result.status).toBe('error');
    expect(result.message).toContain('query is required');
  });

  it('search returns results', async () => {
    const ctx = makeCtx({
      searchActivities: vi.fn(() => [{
        id: 'act-1', type: 'task', label: 'Auth fix', startedAt: '2024-01-01T00:00:00Z',
        totalTokens: 500, totalTools: 3, success: true, summary: 'Fixed auth', keywords: 'auth,login',
      }]),
    });
    const tool = createRecallTool(ctx);
    const result = JSON.parse(await tool.execute({ operation: 'search', query: 'auth', limit: 5 }));
    expect(result.status).toBe('ok');
    expect(result.activities).toHaveLength(1);
  });

  it('search returns empty when no matches', async () => {
    const ctx = makeCtx({ searchActivities: vi.fn(() => []) });
    const tool = createRecallTool(ctx);
    const result = JSON.parse(await tool.execute({ operation: 'search', query: 'nonexistent' }));
    expect(result.status).toBe('ok');
    expect(result.message).toContain('No activities matching');
  });

  it('search unavailable when no searchActivities callback', async () => {
    const ctx = makeCtx({ searchActivities: undefined });
    const tool = createRecallTool(ctx);
    const result = JSON.parse(await tool.execute({ operation: 'search', query: 'test' }));
    expect(result.status).toBe('error');
    expect(result.message).toContain('not available');
  });

  it('search handles errors gracefully', async () => {
    const ctx = makeCtx({
      searchActivities: vi.fn(() => { throw new Error('Index error'); }),
    });
    const tool = createRecallTool(ctx);
    const result = JSON.parse(await tool.execute({ operation: 'search', query: 'test' }));
    expect(result.status).toBe('error');
  });

  it('unknown operation returns error', async () => {
    const tool = createRecallTool(makeCtx());
    const result = JSON.parse(await tool.execute({ operation: 'delete' }));
    expect(result.status).toBe('error');
    expect(result.message).toContain('Unknown operation');
  });
});
