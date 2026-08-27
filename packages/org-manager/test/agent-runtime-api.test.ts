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
 * OB-1 后端测试（API 层）：GET /api/agents 在每个 agent 上派生运行时信息 `runtime`
 * — phase / activityLabel / blockedBy(含依赖任务标题) / lastHeartbeat / runningMinutes。
 * 断言 idle / running / waiting-dependency 三种真实状态，且不污染其他 agent。
 */
describe('GET /api/agents → runtime（OB-1 运行轨迹可见）', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestServer();
  });

  function seedBlockedScenario(): { depTaskId: string; blockedTaskId: string } {
    const dep = ctx.taskService.createTask({
      orgId: 'default',
      title: '前置数据迁移',
      description: '',
      assignedAgentId: AGENT_A,
      reviewerId: REVIEWER,
      priority: 'medium',
    } as any);
    const blocked = ctx.taskService.createTask({
      orgId: 'default',
      title: '依赖迁移的功能开发',
      description: '被前置依赖阻塞',
      assignedAgentId: AGENT_A,
      reviewerId: REVIEWER,
      priority: 'medium',
      blockedBy: [dep.id],
    } as any);
    return { depTaskId: dep.id, blockedTaskId: blocked.id };
  }

  it('每个 agent 都带 runtime 派生字段（idle / running / waiting-dependency）', async () => {
    const { depTaskId, blockedTaskId } = seedBlockedScenario();

    // AGENT_A：working + 干一个被依赖阻塞的任务 → waiting-dependency 且能定位到「前置数据迁移」
    // AGENT_B：idle 无活动 → idle，无阻塞
    (ctx.agentManager.listAgents as any).mockReturnValue([
      {
        id: AGENT_A,
        name: 'Agent A',
        role: 'Developer',
        agentRole: 'worker',
        status: 'working',
        activeTaskIds: [blockedTaskId],
        currentTaskId: blockedTaskId,
        currentActivity: {
          id: 'act-a',
          type: 'task',
          label: '依赖迁移的功能开发',
          taskId: blockedTaskId,
          startedAt: '2026-08-27T11:00:00.000Z',
        },
        lastHeartbeat: '2026-08-27T11:50:00.000Z',
        tokensUsedToday: 320,
      },
      {
        id: AGENT_B,
        name: 'Agent B',
        role: 'QA',
        agentRole: 'worker',
        status: 'idle',
        activeTaskIds: [],
        currentTaskId: undefined,
        lastHeartbeat: undefined,
        tokensUsedToday: 5,
      },
    ]);

    const res = await request(ctx.server, 'GET', '/api/agents');
    expect(res.status).toBe(200);
    const agents = res.json.agents as Array<Record<string, any>>;
    expect(agents).toHaveLength(2);

    const agentA = agents.find(a => a.id === AGENT_A)!;
    const agentB = agents.find(a => a.id === AGENT_B)!;

    // ── AGENT_A：waiting-dependency + 阻塞点可定位（标题/状态） ──
    expect(agentA.runtime.phase).toBe('waiting-dependency');
    expect(agentA.runtime.activityLabel).toContain('迁移');
    expect(agentA.runtime.currentTaskId).toBe(blockedTaskId);
    expect(agentA.runtime.blockingTaskIds).toEqual([depTaskId]);
    expect(agentA.runtime.blockedBy).toHaveLength(1);
    expect(agentA.runtime.blockedBy[0]).toEqual({
      taskId: depTaskId,
      title: '前置数据迁移',
      status: expect.stringMatching(/in_progress|pending|blocked/),
    });
    expect(agentA.runtime.lastHeartbeat).toBe('2026-08-27T11:50:00.000Z');
    expect(typeof agentA.runtime.runningMinutes).toBe('number');

    // ── AGENT_B：idle，阻塞为空，不被 A 污染 ──
    expect(agentB.runtime.phase).toBe('idle');
    expect(agentB.runtime.blockedBy).toEqual([]);
    expect(agentB.runtime.activeTaskIds).toEqual([]);
  });

  it('running：working + 无阻塞 → phase=running，含活动标签与已运行分钟', async () => {
    (ctx.agentManager.listAgents as any).mockReturnValue([
      {
        id: AGENT_A,
        name: 'Agent A',
        role: 'Developer',
        agentRole: 'worker',
        status: 'working',
        activeTaskIds: ['t-lone'],
        currentTaskId: 't-lone',
        currentActivity: {
          type: 'task', label: '独立开发模块X', taskId: 't-lone',
          startedAt: '2026-08-27T11:30:00.000Z', id: 'act-lone',
        },
        lastHeartbeat: '2026-08-27T11:40:00.000Z',
      },
      {
        id: AGENT_B, name: 'Agent B', role: 'QA', agentRole: 'worker',
        status: 'idle', activeTaskIds: [], tokensUsedToday: 0,
      },
    ]);
    // 让 t-lone 的压力对象存在（无 blockedBy 分布）
    ctx.taskService.createTask({
      orgId: 'default', title: '独立开发任务X', description: '',
      assignedAgentId: AGENT_A, reviewerId: REVIEWER, priority: 'medium',
    } as any);

    const res = await request(ctx.server, 'GET', '/api/agents');
    const agents = res.json.agents as Array<Record<string, any>>;
    const agentA = agents.find(a => a.id === AGENT_A)!;
    expect(agentA.runtime.phase).toBe('running');
    expect(agentA.runtime.activityLabel).toBe('独立开发模块X');
    expect(agentA.runtime.blockedBy).toEqual([]);
    expect(typeof agentA.runtime.runningMinutes).toBe('number');
  });
});