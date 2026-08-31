import { describe, it, expect, beforeEach } from 'vitest';
import {
  AGENT_A,
  AGENT_B,
  REVIEWER,
  createTestServer,
  request,
  type TestContext,
} from './api-server-test-helpers.js';

/**
 * OB-2 后端测试（API 层）：GET /api/agents 在每个 agent 的 runtime 上附加 `stall`
 * 判定（疑似卡死定位）——stalled/stallKind/stuckOnTaskId/stuckOnTitle/currentTaskId/
 * lastActivityAgoMin/suggestions。
 * 断言 stale-heartbeat（心跳停滞）、dead-dependency（依赖已死仍等待）、不误杀正常场景。
 */
describe('GET /api/agents → runtime.stall（OB-2 卡死定位）', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestServer();
  });

  function seedDeadDependency() {
    return seedDeadBlocked();
  }

  it('running 心跳新鲜 → runtime.stall.stalled=false（不误杀正常在跑）', async () => {
    const now = Date.now();
    (ctx.agentManager.listAgents as any).mockReturnValue([
      {
        id: AGENT_A, name: 'Agent A', role: 'Developer', agentRole: 'worker',
        status: 'working', activeTaskIds: ['t-live'], currentTaskId: 't-live',
        currentActivity: { id: 'a', type: 'task', label: '实现登录', taskId: 't-live', startedAt: new Date(now - 30_000).toISOString() },
        lastHeartbeat: new Date(now - 5_000).toISOString(), // 5 秒前，新鲜
        tokensUsedToday: 10,
      },
      { id: AGENT_B, name: 'Agent B', role: 'QA', agentRole: 'worker', status: 'idle', activeTaskIds: [], tokensUsedToday: 0 },
    ]);
    const res = await request(ctx.server, 'GET', '/api/agents');
    const agents = res.json.agents as Array<Record<string, any>>;
    const a = agents.find(x => x.id === AGENT_A)!;
    expect(a.runtime.stall.stalled).toBe(false);
    const b = agents.find(x => x.id === AGENT_B)!;
    expect(b.runtime.stall.stalled).toBe(false);
  });

  it('running + 低频心跳 5 小时前但进度心跳新鲜（lastProgressAt 2 分钟前）→ 不判卡死', async () => {
    const now = Date.now();
    (ctx.agentManager.listAgents as any).mockReturnValue([
      {
        id: AGENT_A, name: 'Agent A', role: 'Developer', agentRole: 'worker',
        status: 'working', activeTaskIds: ['t-long'], currentTaskId: 't-long',
        currentActivity: { id: 'a', type: 'task', label: '长任务', taskId: 't-long', startedAt: new Date(now - 60 * 60_000).toISOString() },
        lastHeartbeat: new Date(now - 5 * 3600_000).toISOString(), // 5 小时前（默认心跳间隔 6h，正常）
        lastProgressAt: new Date(now - 2 * 60_000).toISOString(), // 2 分钟前，持续有工具/LLM 事件
        tokensUsedToday: 10,
      },
    ]);
    const res = await request(ctx.server, 'GET', '/api/agents');
    const a = (res.json.agents as Array<Record<string, any>>).find(x => x.id === AGENT_A)!;
    expect(a.runtime.stall.stalled).toBe(false);
    // 进度心跳优先于低频心跳派生最后活动时间
    expect(a.runtime.lastActivityAt).toBe(new Date(now - 2 * 60_000).toISOString());
  });

  it('running 心跳长时间停滞（>10min）→ stale-heartbeat，定位到当前任务', async () => {
    (ctx.agentManager.listAgents as any).mockReturnValue([
      {
        id: AGENT_A, name: 'Agent A', role: 'Developer', agentRole: 'worker',
        status: 'working', activeTaskIds: ['t-stale'], currentTaskId: 't-stale',
        currentActivity: { id: 'a', type: 'task', label: '实现登录', taskId: 't-stale', startedAt: '2026-08-27T09:00:00.000Z' },
        lastHeartbeat: '2026-08-27T11:20:00.000Z', // 40 分钟前
        tokensUsedToday: 10,
      },
    ]);
    const res = await request(ctx.server, 'GET', '/api/agents');
    const a = (res.json.agents as Array<Record<string, any>>).find(x => x.id === AGENT_A)!;
    expect(a.runtime.stall.stalled).toBe(true);
    expect(a.runtime.stall.stallKind).toBe('stale-heartbeat');
    expect(a.runtime.stall.stuckOnTaskId).toBe('t-stale');
    expect(typeof a.runtime.stall.lastActivityAgoMin).toBe('number');
    expect(a.runtime.stall.suggestions.length).toBeGreaterThan(0);
  });

  it('waiting-dependency 但依赖已 failed → dead-dependency，定位到已死依赖（而非当前任务）', async () => {
    const { depTaskId, blockedTaskId } = seedDeadBlocked();
    (ctx.agentManager.listAgents as any).mockReturnValue([
      {
        id: AGENT_A, name: 'Agent A', role: 'Developer', agentRole: 'worker',
        status: 'working', activeTaskIds: [blockedTaskId], currentTaskId: blockedTaskId,
        currentActivity: { id: 'a', type: 'task', label: '依赖迁移的功能开发', taskId: blockedTaskId, startedAt: '2026-08-27T09:00:00.000Z' },
        lastHeartbeat: '2026-08-27T11:50:00.000Z',
        tokensUsedToday: 9,
      },
    ]);
    const res = await request(ctx.server, 'GET', '/api/agents');
    const a = (res.json.agents as Array<Record<string, any>>).find(x => x.id === AGENT_A)!;
    expect(a.runtime.stall.stalled).toBe(true);
    expect(a.runtime.stall.stallKind).toBe('dead-dependency');
    expect(a.runtime.stall.stuckOnTaskId).toBe(depTaskId); // 卡在死依赖上，而非当前任务
    expect(a.runtime.stall.currentTaskId).toBe(blockedTaskId);
    expect(a.runtime.stall.suggestions.length).toBeGreaterThan(0);
  });

  it('不污染：idle 的 agent 即使带 stall 字段也 stalled=false', async () => {
    (ctx.agentManager.listAgents as any).mockReturnValue([
      { id: AGENT_A, name: 'Agent A', role: 'Developer', agentRole: 'worker', status: 'idle', activeTaskIds: [], tokensUsedToday: 0 },
      { id: AGENT_B, name: 'Agent B', role: 'QA', agentRole: 'worker', status: 'idle', activeTaskIds: [], tokensUsedToday: 0 },
    ]);
    const res = await request(ctx.server, 'GET', '/api/agents');
    const agents = res.json.agents as Array<Record<string, any>>;
    for (const ag of agents) {
      expect(ag.runtime.stall.stalled).toBe(false);
    }
  });

  function seedDeadBlocked() {
    const dep = ctx.taskService.createTask({
      title: '已死数据迁移', description: '', assignedAgentId: AGENT_B, reviewerId: REVIEWER, priority: 'medium',
    } as any);
    ctx.taskService.updateTaskStatus(dep.id, 'failed');
    const blocked = ctx.taskService.createTask({
      title: '依赖迁移的功能开发', description: '被前置依赖阻塞', assignedAgentId: AGENT_A, reviewerId: REVIEWER,
      priority: 'medium', blockedBy: [dep.id],
    } as any);
    return { depTaskId: dep.id, blockedTaskId: blocked.id };
  }
});