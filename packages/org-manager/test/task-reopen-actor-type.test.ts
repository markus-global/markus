/**
 * 「重新打开」的权威契约：completed → in_progress **FMS 允许**，但 terminal-revert 守卫
 * 只允许**人**做这件事，agent 翻案必须被拦。
 *
 * 事故（2026-11-12，Owner 报告）：点「重新打开」毫无反应。
 * 根因：`PUT /api/tasks/:id` 只传了 `updatedBy`、没传 `updatedByType`，
 * `updateTaskStatus` 默认成 'agent' → 守卫抛错 → 前端 `reopenTask` 又没有 catch。
 *
 * 本文件钉住服务层语义，防止路由再次漏传 actor 类型。
 */
import { describe, it, expect, vi } from 'vitest';
import { TaskService } from '../src/task-service.js';

const AGENT = 'agent-a';
const REVIEWER = 'reviewer-1';
const HUMAN = 'user-1';
const ORG = 'org-1';

function makeService() {
  const makeAgent = (id: string) => ({
    config: { name: id, orgId: ORG, agentRole: 'worker' },
    enqueueToMailbox: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    injectUserMessage: vi.fn(),
    sendSessionReply: vi.fn().mockResolvedValue('ok'),
    dropStaleStatusUpdates: vi.fn(),
    getState: vi.fn(() => ({ status: 'idle', activeTaskCount: 0 })),
    sendTaskExecution: vi.fn(async (_id: string, _d: string, logFn: (e: unknown) => Promise<void>) => {
      await logFn({ type: 'status', content: 'execution_finished', persist: true });
    }),
  });
  const agentManager = {
    hasAgent: vi.fn((id: string) => id === AGENT || id === REVIEWER),
    getAgent: vi.fn((id: string) => makeAgent(id)),
    listAgents: vi.fn(() => [{ id: AGENT }]),
  };
  const svc = new TaskService();
  svc.setGovernancePolicy({
    enabled: false, defaultTier: 'auto', maxPendingTasksPerAgent: 100, maxTotalActiveTasks: 100,
    requireApprovalForPriority: [], requireRequirement: false, rules: [],
  });
  svc.setAgentManager(agentManager as never);
  svc.setWSBroadcaster({ broadcast: vi.fn(), broadcastTaskCreate: vi.fn(), broadcastTaskUpdate: vi.fn() } as never);
  return svc;
}

async function completedTask(svc: TaskService) {
  const task = svc.createTask({
    orgId: ORG, title: 'reopen-me', description: 'd',
    assignedAgentId: AGENT, reviewerId: REVIEWER, creatorRole: 'human',
  } as never);
  svc.approveTask(task.id, HUMAN);
  await svc.submitForReview(task.id, []);
  // review → completed（评审通过，人是 actor）
  svc.updateTaskStatus(task.id, 'completed', HUMAN, false, false, 'human', 'Review approved');
  expect(svc.getTask(task.id)!.status).toBe('completed');
  return task.id;
}

describe('重新打开已完成的卡：FMS 允许，但只允许人', () => {
  it('completed → in_progress 在 FSM 里是合法的（所以按钮不该被删）', async () => {
    const svc = makeService();
    const id = await completedTask(svc);
    // 人类显式声明类型 → 允许
    const reopened = svc.updateTaskStatus(id, 'in_progress', HUMAN, false, false, 'human');
    expect(reopened.status).toBe('in_progress');
  });

  it('不声明 actor 类型时默认按 agent 处理 → terminal-revert 守卫拦截（这就是路由漏传的后果）', async () => {
    const svc = makeService();
    const id = await completedTask(svc);
    expect(() => svc.updateTaskStatus(id, 'in_progress', HUMAN)).toThrow(/Terminal state guard/i);
  });

  it('agent 确实不能翻案（守卫是有意为之，别顺手删掉）', async () => {
    const svc = makeService();
    const id = await completedTask(svc);
    expect(() => svc.updateTaskStatus(id, 'in_progress', AGENT, false, false, 'agent')).toThrow(/Terminal state guard/i);
  });

  it('重新打开会新起一轮：executionRound + 1，并清掉上一轮的完成痕迹', async () => {
    const svc = makeService();
    const id = await completedTask(svc);
    const before = svc.getTask(id)!.executionRound ?? 1;
    expect(svc.getTask(id)!.completedAt).toBeTruthy();

    const reopened = svc.updateTaskStatus(id, 'in_progress', HUMAN, false, false, 'human');

    expect(reopened.executionRound).toBe(before + 1);
    // 新轮次不应该拖着上一轮的完成时间/结果
    expect(svc.getTask(id)!.completedAt).toBeFalsy();
    expect(svc.getTask(id)!.result).toBeUndefined();
  });

  it('未结束的卡不会被误加轮次（blocked → in_progress 不是重开）', async () => {
    const svc = makeService();
    const task = svc.createTask({
      orgId: ORG, title: 'hold', description: 'd',
      assignedAgentId: AGENT, reviewerId: REVIEWER, creatorRole: 'human',
    } as never);
    svc.approveTask(task.id, HUMAN);
    svc.updateTaskStatus(task.id, 'blocked', HUMAN, false, false, 'human');
    const before = svc.getTask(task.id)!.executionRound ?? 1;
    svc.updateTaskStatus(task.id, 'in_progress', HUMAN, false, false, 'human');
    expect(svc.getTask(task.id)!.executionRound ?? 1).toBe(before);
  });
});
