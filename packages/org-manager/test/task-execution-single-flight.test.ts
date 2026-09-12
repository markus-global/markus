import { describe, it, expect, vi } from 'vitest';
import { TaskService } from '../src/task-service.js';

/**
 * T2 · 派发侧实体独占（task 级单飞）回归测试
 *
 * 回归目标（验收断言）：同一 task 在已有活跃执行会话时，第二次「派发」
 * （runTask / runTaskFresh）必须被**拒绝**，不产生第二个执行会话 —— 断言
 * agent.sendTaskExecution 仅被调用一次 + `task.dispatch_rejected_duplicate`
 * 可观测留痕（谁/何时/原会话）。执行到达终态后，合法重派（抢占/重试/定时重跑）
 * 必须放行（不误伤）。
 *
 * 未修复基线上，第二次派发会再次调用 sendTaskExecution（同一 task 被两会话并发执行）。
 */

const AGENT_A = 'agent-a';
const REVIEWER = 'reviewer-1';
const ORG = 'org-1';

type LogEntry = { type: string; content: string; persist?: boolean; metadata?: Record<string, unknown> };

function makeAgentManager(onExecute?: (taskId: string) => Promise<void>) {
  const makeAgent = (id: string) => ({
    config: { name: id, orgId: ORG, agentRole: id === REVIEWER ? 'manager' : 'worker' },
    enqueueToMailbox: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    injectUserMessage: vi.fn(),
    sendSessionReply: vi.fn().mockResolvedValue('ok'),
    dropStaleStatusUpdates: vi.fn(),
    getState: vi.fn(() => ({ status: 'busy', activeTaskCount: 1 })),
    sendTaskExecution: vi.fn(async (taskId: string, _desc: string, logFn: (e: LogEntry) => Promise<void>) => {
      if (onExecute) {
        await onExecute(taskId);
        return;
      }
      await logFn({ type: 'status', content: 'started', persist: true });
      await logFn({ type: 'status', content: 'execution_finished', persist: true });
    }),
  });
  const agents = new Map<string, ReturnType<typeof makeAgent>>([
    [AGENT_A, makeAgent(AGENT_A)],
    [REVIEWER, makeAgent(REVIEWER)],
  ]);
  return {
    hasAgent: vi.fn((id: string) => agents.has(id)),
    getAgent: vi.fn((id: string) => {
      const a = agents.get(id);
      if (!a) throw new Error(`Agent not found: ${id}`);
      return a;
    }),
    listAgents: vi.fn(() => [{ id: AGENT_A }]),
  };
}

function makeService(onExecute?: (taskId: string) => Promise<void>) {
  const agentManager = makeAgentManager(onExecute);
  const ws = { broadcast: vi.fn(), broadcastTaskCreate: vi.fn(), broadcastTaskUpdate: vi.fn() };
  const svc = new TaskService();
  svc.setGovernancePolicy({
    enabled: false,
    defaultTier: 'auto',
    maxPendingTasksPerAgent: 100,
    maxTotalActiveTasks: 100,
    requireApprovalForPriority: ['urgent'],
    requireRequirement: false,
    rules: [],
  });
  svc.setAgentManager(agentManager as never);
  svc.setWSBroadcaster(ws as never);
  return { svc, agentManager, ws };
}

const flush = (ms = 5) => new Promise<void>(resolve => setTimeout(resolve, ms));

function createStartedTask(svc: TaskService) {
  const task = svc.createTask({
    orgId: ORG,
    title: 'Task',
    description: 'Do something',
    assignedAgentId: AGENT_A,
    reviewerId: REVIEWER,
    creatorRole: 'human',
  } as never);
  return task;
}

describe('TaskService T2 · 派发侧实体独占（task 级单飞）', () => {
  it('活跃执行期内重复派发被拒绝：仅一次执行 + dispatch_rejected_duplicate 可观测', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started: string[] = [];
    const { svc, agentManager, ws } = makeService(async taskId => {
      started.push(taskId);
      await gate; // 保持第一个执行活跃（在飞）
    });

    const task = createStartedTask(svc);
    svc.approveTask(task.id, 'user-1'); // 触发 auto-start（setImmediate → runTask）
    await flush(10);

    const agent = agentManager.getAgent(AGENT_A);
    expect(agent.sendTaskExecution).toHaveBeenCalledTimes(1);

    // 第二个派发（模拟另一会话 / 重复派发）
    await svc.runTask(task.id);

    // 断言：仅一次执行；第二次被拒绝并留痕
    expect(agent.sendTaskExecution).toHaveBeenCalledTimes(1);
    expect(started).toEqual([task.id]);
    expect(ws.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'task:dispatch:duplicate-rejected',
        payload: expect.objectContaining({
          taskId: task.id,
          agentId: AGENT_A,
          existingSessionId: `task_${task.id}_r1`,
        }),
      }),
    );

    // 终态后释放：合法重派放行（不误伤）
    release();
    await flush(20);
    await svc.runTask(task.id);
    expect(agent.sendTaskExecution).toHaveBeenCalledTimes(2);
  });

  it('不同 task 各自单飞、互不影响', async () => {
    const started: string[] = [];
    const { svc, agentManager } = makeService(async taskId => { started.push(taskId); });

    const t1 = createStartedTask(svc);
    const t2 = createStartedTask(svc);
    svc.approveTask(t1.id, 'user-1');
    svc.approveTask(t2.id, 'user-1');
    await flush(20);

    const agent = agentManager.getAgent(AGENT_A);
    expect(agent.sendTaskExecution).toHaveBeenCalledTimes(2);
    expect(started.sort()).toEqual([t1.id, t2.id].sort());
  });
});
