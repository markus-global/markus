import { describe, it, expect } from 'vitest';
import { buildAgentRuntimeInfo } from '../src/agent-runtime.js';

describe('buildAgentRuntimeInfo — 运行阶段派生（OB-1）', () => {
  const NOW = Date.parse('2026-08-27T12:00:00.000Z');

  it('idle：无活动、无任务、无错误 → phase=idle，无阻塞', () => {
    const r = buildAgentRuntimeInfo(
      { agentId: 'a1', status: 'idle', activeTaskIds: [], tokensUsedToday: 5 },
      () => undefined,
      NOW,
    );
    expect(r.phase).toBe('idle');
    expect(r.blockedBy).toEqual([]);
    expect(r.activeTaskIds).toEqual([]);
    expect(r.tokensUsedToday).toBe(5);
  });

  it('running：working + 有活动 → phase=running，含已运行分钟与最后活动', () => {
    const r = buildAgentRuntimeInfo(
      {
        agentId: 'a1',
        status: 'working',
        activeTaskIds: ['t1'],
        currentActivity: {
          id: 'act-1', type: 'task', label: '实现登录模块',
          taskId: 't1', startedAt: '2026-08-27T11:30:00.000Z',
        },
        lastHeartbeat: '2026-08-27T11:55:00.000Z',
        tokensUsedToday: 123,
      },
      () => ({ id: 't1', title: '实现登录模块', status: 'in_progress' }),
      NOW,
    );
    expect(r.phase).toBe('running');
    expect(r.currentTaskId).toBe('t1');
    expect(r.activityLabel).toBe('实现登录模块');
    // 11:30 → 12:00 = 30 分钟
    expect(r.runningMinutes).toBe(30);
    expect(r.lastHeartbeat).toBe('2026-08-27T11:55:00.000Z');
    expect(r.blockedBy).toEqual([]);
  });

  it('waiting-dependency：activeTask 有未满足的 blockedBy → 定位到具体依赖任务标题', () => {
    const r = buildAgentRuntimeInfo(
      {
        agentId: 'a1',
        status: 'working',
        activeTaskIds: ['t2'],
        currentActivity: { id: 'act-1', type: 'task', label: 'B', taskId: 't2', startedAt: '2026-08-27T11:00:00.000Z' },
      },
      (tid) => {
        if (tid === 't2') return { id: 't2', title: 'B', status: 'in_progress', blockedBy: ['t1'] };
        if (tid === 't1') return { id: 't1', title: '数据迁移', status: 'in_progress' };
        return undefined;
      },
      NOW,
    );
    expect(r.phase).toBe('waiting-dependency');
    expect(r.blockingTaskIds).toEqual(['t1']);
    expect(r.blockedBy).toHaveLength(1);
    expect(r.blockedBy[0]).toEqual({
      taskId: 't1', title: '数据迁移', status: 'in_progress',
    });
  });

  it('blocked：当前任务自身 status=blocked + 依赖未完成 → phase=blocked（卡死在依赖上）', () => {
    const r = buildAgentRuntimeInfo(
      { agentId: 'a1', status: 'working', currentTaskId: 'tB', currentActivity: { type: 'task', label: 'B', taskId: 'tB', startedAt: '2026-08-27T10:00:00.000Z', id: 'actB' } },
      (tid) => {
        if (tid === 'tB') return { id: 'tB', title: 'B 服务', status: 'blocked', blockedBy: ['tA'] };
        if (tid === 'tA') return { id: 'tA', title: 'A 前置', status: 'pending' };
        return undefined;
      },
      NOW,
    );
    expect(r.phase).toBe('blocked');
    expect(r.blockedBy[0].title).toBe('A 前置');
    expect(r.blockedBy[0].status).toBe('pending');
  });

  it('waiting-dependency：任务已就绪（自身非 blocked）但依赖未完成 → 等待依赖而非已阻塞', () => {
    const r = buildAgentRuntimeInfo(
      { agentId: 'a1', status: 'working', currentTaskId: 'tB', currentActivity: { type: 'task', label: 'B', taskId: 'tB', startedAt: '2026-08-27T10:00:00.000Z', id: 'actB' } },
      (tid) => {
        if (tid === 'tB') return { id: 'tB', title: 'B 服务', status: 'in_progress', blockedBy: ['tA'] };
        if (tid === 'tA') return { id: 'tA', title: 'A 前置', status: 'pending' };
        return undefined;
      },
      NOW,
    );
    expect(r.phase).toBe('waiting-dependency');
    expect(r.blockedBy[0].title).toBe('A 前置');
  });

  it('lastErrorAt 有值即透传，且在 degraded 派生时保持 error 信息', () => {
    const r = buildAgentRuntimeInfo(
      {
        agentId: 'a1', status: 'working', activeTaskIds: ['t1'],
        currentActivity: { type: 'task', label: 'X', taskId: 't1', startedAt: '2026-08-27T11:30:00.000Z', id: 'act' },
        lastError: 'API 超时', lastErrorAt: '2026-08-27T11:58:00.000Z',
      },
      () => undefined,
      NOW,
    );
    expect(r.phase).toBe('degraded');
    expect(r.lastError).toBe('API 超时');
    expect(r.lastErrorAt).toBe('2026-08-27T11:58:00.000Z');
  });

  it('degraded：working + 近期 lastError → phase=degraded（仍可读进度，但提示留意）', () => {
    const r = buildAgentRuntimeInfo(
      {
        agentId: 'a1', status: 'working', activeTaskIds: ['t1'],
        currentActivity: { type: 'task', label: 'X', taskId: 't1', startedAt: '2026-08-27T11:30:00.000Z', id: 'act' },
        lastError: 'API 超时', lastErrorAt: '2026-08-27T11:58:00.000Z',
      },
      () => undefined,
      NOW,
    );
    expect(r.phase).toBe('degraded');
    expect(r.lastError).toBe('API 超时');
  });

  it('error：status=error → phase=error', () => {
    const r = buildAgentRuntimeInfo(
      { agentId: 'a1', status: 'error', lastError: 'boom', lastErrorAt: '2026-08-27T11:00:00.000Z' },
      () => undefined,
      NOW,
    );
    expect(r.phase).toBe('error');
  });

  it('不污染其他任务：buildAgentRuntimeInfo 是纯函数，多次调用结果一致且无共享状态', () => {
    const input = {
      agentId: 'a1', status: 'working', activeTaskIds: ['t2'],
      currentActivity: { type: 'task', label: 'B', taskId: 't2', startedAt: '2026-08-27T11:00:00.000Z', id: 'act' },
    };
    const lookup = (tid: string) =>
      tid === 't2'
        ? { id: 't2', title: 'B', status: 'in_progress', blockedBy: ['t1'] }
        : { id: 't1', title: 'A', status: 'in_progress' };
    const r1 = buildAgentRuntimeInfo(input, lookup, NOW);
    const r2 = buildAgentRuntimeInfo(input, lookup, NOW);
    expect(r1).toEqual(r2);
  });
});