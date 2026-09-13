/**
 * P1 · 评审收口 (task_id, round) 幂等 + review_request 单播投递 —— org-manager 验收测试
 *
 * 对应需求 req_236bca1ab0ca8ed425537bed / 任务 tsk_31b23ce898b9d8264b165454：
 *   - 根因 #1：投递侧仅内存去重（`activeReviews` 实例 Set、发送成功即 delete）
 *              → 重启/跨进程失效，且窗口期不覆盖「多分身同持」。
 *   - 验收：同 (task_id, round) 的重复 approve / revision **幂等**
 *           （第二次调用返回当前状态、不产生额外状态转移）。
 *
 * 断言口径：用 `updateTaskStatus` spy 证明「第二次调用没有触发任何状态转移」，
 * 并用 `Logger.prototype` spy 按结构化 `event` 字段验证 P2 / 可观测事件。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '@markus/shared';
import { TaskService } from '../src/task-service.js';

const AGENT_A = 'agent-a';
const AGENT_B = 'agent-b';
const REVIEWER = 'reviewer-1';
const ORG = 'org-1';

function createDefaults(overrides: Record<string, unknown> = {}) {
  return {
    orgId: ORG,
    title: 'Task',
    description: 'Do something',
    assignedAgentId: AGENT_A,
    reviewerId: REVIEWER,
    ...overrides,
  };
}

type ExecutionLogEntry = {
  type: string;
  content: string;
  persist?: boolean;
  metadata?: Record<string, unknown>;
};

function createMockAgentManager() {
  const agents = new Set([AGENT_A, AGENT_B, REVIEWER]);
  const makeAgent = (id: string) => ({
    config: { name: id, orgId: ORG, agentRole: id === REVIEWER ? 'manager' : 'worker' },
    enqueueToMailbox: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    injectUserMessage: vi.fn(),
    sendSessionReply: vi.fn().mockResolvedValue('ok'),
    dropStaleStatusUpdates: vi.fn(),
    getState: vi.fn(() => ({ status: 'busy', activeTaskCount: 1 })),
    sendTaskExecution: vi.fn(async (
      _taskId: string,
      _desc: string,
      logFn: (entry: ExecutionLogEntry) => Promise<void>,
    ) => {
      await logFn({ type: 'status', content: 'started', persist: true });
      await logFn({ type: 'status', content: 'execution_finished', persist: true });
    }),
  });
  const agentMap = new Map([
    [AGENT_A, makeAgent(AGENT_A)],
    [AGENT_B, makeAgent(AGENT_B)],
    [REVIEWER, makeAgent(REVIEWER)],
  ]);
  return {
    hasAgent: vi.fn((id: string) => agents.has(id)),
    getAgent: vi.fn((id: string) => {
      const agent = agentMap.get(id);
      if (!agent) throw new Error(`Agent not found: ${id}`);
      return agent;
    }),
    listAgents: vi.fn(() => [{ id: AGENT_A }, { id: AGENT_B }]),
  };
}

function createService() {
  const agentManager = createMockAgentManager();
  const svc = new TaskService();
  svc.setGovernancePolicy({
    enabled: false,
    defaultTier: 'auto',
    maxPendingTasksPerAgent: 100,
    maxTotalActiveTasks: 100,
    requireApprovalForPriority: [],
    requireRequirement: false,
    rules: [],
  });
  svc.setAgentManager(agentManager as never);
  svc.setWSBroadcaster({ broadcast: vi.fn(), broadcastTaskCreate: vi.fn(), broadcastTaskUpdate: vi.fn() } as never);
  return { svc, agentManager };
}

/** pending → in_progress → review（round 1）。 */
async function createTaskInReview(ts: TaskService) {
  const task = ts.createTask(createDefaults({ creatorRole: 'human' }) as never);
  ts.approveTask(task.id, 'user-1');
  await ts.submitForReview(task.id, [{ type: 'file', reference: '/tmp/out.txt', summary: 'Output' }]);
  return ts.getTask(task.id)!;
}

/** 按结构化事件名过滤 logger 调用（P2 可度量口径）。 */
function eventsOf(spy: { mock: { calls: unknown[][] } }, event: string): unknown[][] {
  return spy.mock.calls.filter(
    c => (c[1] as Record<string, unknown> | undefined)?.['event'] === event,
  ) as unknown[][];
}

/** 抓取发给评审人的 review_request 投递调用。 */
function reviewDispatches(agentManager: ReturnType<typeof createMockAgentManager>) {
  const sendMessage = agentManager.getAgent(REVIEWER).sendMessage as unknown as {
    mock: { calls: unknown[][] };
  };
  return sendMessage.mock.calls.filter(
    c => (c[3] as Record<string, unknown> | undefined)?.['sourceType'] === 'review_request',
  );
}

/** 直接调用私有 notifyReviewer（验证「同轮重复投递被抑制」需绕过公开流程）。 */
function callNotifyReviewer(ts: TaskService, taskId: string): void {
  const task = ts.getTask(taskId)!;
  (ts as unknown as { notifyReviewer: (t: unknown, r: string) => void })
    .notifyReviewer(task, REVIEWER);
}

describe('P1 · 评审收口 (task_id, round) 幂等 + review_request 轮次化投递', () => {
  let ts: TaskService;
  let agentManager: ReturnType<typeof createMockAgentManager>;

  beforeEach(() => {
    ({ svc: ts, agentManager } = createService());
  });

  afterEach(() => {
    ts.stopTimeoutChecker();
    vi.restoreAllMocks();
  });

  it('重复 approve 幂等：第二次返回当前状态、不触发额外状态转移', async () => {
    const task = await createTaskInReview(ts);
    expect(task.status).toBe('review');

    const first = ts.acceptTask(task.id, REVIEWER);
    expect(first.status).toBe('completed');

    const transitionSpy = vi.spyOn(ts, 'updateTaskStatus');
    const second = ts.acceptTask(task.id, REVIEWER);

    expect(second.status).toBe('completed');
    expect(transitionSpy).not.toHaveBeenCalled(); // 无第二次状态转移
  });

  it('重复 requestRevision 幂等：不再次自增 executionRound、不产生转移', async () => {
    const task = await createTaskInReview(ts);
    const r1 = await ts.requestRevision(task.id, 'fix A', REVIEWER);
    expect(r1.status).toBe('in_progress');
    expect(r1.executionRound).toBe(2);

    const transitionSpy = vi.spyOn(ts, 'updateTaskStatus');
    const r2 = await ts.requestRevision(task.id, 'fix A', REVIEWER);

    expect(r2.status).toBe('in_progress');
    expect(r2.executionRound).toBe(2); // 关键：未再自增（否则凭空多开一轮执行）
    expect(transitionSpy).not.toHaveBeenCalled();
  });

  it('迟到 approve（该轮已被 revision 收口）返回当前状态、不产生第二次转移', async () => {
    const task = await createTaskInReview(ts);
    await ts.requestRevision(task.id, 'needs rework', REVIEWER);
    expect(ts.getTask(task.id)!.status).toBe('in_progress');

    const transitionSpy = vi.spyOn(ts, 'updateTaskStatus');
    const late = ts.acceptTask(task.id, REVIEWER);

    expect(late.status).toBe('in_progress'); // 不被错误地标 completed
    expect(transitionSpy).not.toHaveBeenCalled();
  });

  it('不过度抑制：新一轮（round 2）提交后仍可正常 approve', async () => {
    const task = await createTaskInReview(ts);
    await ts.requestRevision(task.id, 'redo', REVIEWER);
    await ts.submitForReview(task.id, [{ type: 'file', reference: '/tmp/v2.txt', summary: 'v2' }]);
    expect(ts.getTask(task.id)!.status).toBe('review');

    const done = ts.acceptTask(task.id, REVIEWER);
    expect(done.status).toBe('completed');
  });

  it('授权先于幂等短路：非评审人面对已收口任务仍被拒', async () => {
    // 授权判定需要 orgService：未注入时 isReviewerAllowedForTask 会 fail-open 返回 true
    ts.setOrgService({
      listTeams: vi.fn(() => [
        { id: 'team-1', name: 'Team 1', managerId: 'manager-x', managerType: 'agent', memberAgentIds: [AGENT_A], humanMemberIds: [] },
      ]),
    } as never);

    const task = await createTaskInReview(ts);
    ts.acceptTask(task.id, REVIEWER);

    expect(() => ts.acceptTask(task.id, AGENT_B)).toThrow(/not allowed to review/);
    await expect(ts.requestRevision(task.id, 'nope', AGENT_B))
      .rejects.toThrow(/not allowed to review/);
  });

  it('幂等短路产生可度量的结构化日志（event = review_settlement_idempotent）', async () => {
    const infoSpy = vi.spyOn(Logger.prototype, 'info');
    const task = await createTaskInReview(ts);
    ts.acceptTask(task.id, REVIEWER);
    ts.acceptTask(task.id, REVIEWER); // 重复收口

    const logs = eventsOf(infoSpy, 'review_settlement_idempotent');
    expect(logs).toHaveLength(1);
    expect(logs[0]![1]).toMatchObject({
      round: 1, settledVerdict: 'approved', currentStatus: 'completed', count: 1,
    });
  });

  it('首轮评审投递携带 round（→ mailbox 跨进程幂等键 + 单播路由）', async () => {
    const task = await createTaskInReview(ts);

    const dispatches = reviewDispatches(agentManager);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]![3]).toMatchObject({
      sourceType: 'review_request', taskId: task.id, round: 1,
    });
  });

  it('同轮重复通知被抑制（轮次键）；下一轮放行且 round 递进', async () => {
    const task = await createTaskInReview(ts);
    const sendMessage = agentManager.getAgent(REVIEWER).sendMessage as unknown as {
      mock: { calls: unknown[][]; clear: () => void };
    };

    sendMessage.mockClear();
    callNotifyReviewer(ts, task.id); // 同一轮（round 1）再通知 → 抑制
    expect(reviewDispatches(agentManager)).toHaveLength(0);

    await ts.requestRevision(task.id, 'redo', REVIEWER);
    await ts.submitForReview(task.id, [{ type: 'file', reference: '/tmp/v2.txt', summary: 'v2' }]);

    const next = reviewDispatches(agentManager);
    expect(next).toHaveLength(1);
    expect(next[0]![3]).toMatchObject({ round: 2 }); // 轮次化后新一轮放行
  });

  it('投递/抑制事件可度量（review_request_dispatched / review_request_suppressed）', async () => {
    const infoSpy = vi.spyOn(Logger.prototype, 'info');
    const task = await createTaskInReview(ts);
    callNotifyReviewer(ts, task.id); // 触发同轮抑制

    const dispatched = eventsOf(infoSpy, 'review_request_dispatched');
    const suppressed = eventsOf(infoSpy, 'review_request_suppressed');

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]![1]).toMatchObject({ round: 1, channel: 'mailbox-unicast' });
    expect((dispatched[0]![1] as Record<string, unknown>)['dedupKey'])
      .toBe(`review_request:${task.id}:1`);

    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]![1]).toMatchObject({ round: 1, count: 1 });
  });
});
