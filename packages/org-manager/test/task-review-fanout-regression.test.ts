/**
 * 需求验收回归套件 B · 评审收口幂等（req_236bca1ab0ca8ed425537bed）
 *
 * 归属任务：tsk_e991647e313fbe9a3b07a64f（回归测试 + 架构门禁）。
 * 验收锚点 #2：同 `(task_id, round)` 的重复 approve / revision **幂等** ——
 *   第二次调用返回当前状态、**无额外状态转移**；多个分身重复投递同一轮评审请求
 *   时只有一次真正送达（不产生「重复收口 + 空转让位」）。
 *
 * 与 `task-review-settlement-idempotency.test.ts`（P1 单元）的分工：
 *   该文件逐条验证幂等语义；本文件是**需求验收入口的回归锚点** —— 以
 *   「N 个分身同时收口」的事故形态驱动，断言「转移恰好一次 / 投递恰好一次」，
 *   并把两类回归各锚定到一条验收标准，便于后续 CI 一眼定位。
 *
 * 断言口径（F3）：用 `updateTaskStatus` spy 证明「没有第二次状态转移」，
 * 用 `sendMessage` 调用计数证明「同轮评审只投递一次」，不看任何内部状态。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TaskService } from '../src/task-service.js';

const AGENT_A = 'agent-a';
const AGENT_B = 'agent-b';
const REVIEWER = 'reviewer-1';
const ORG = 'org-1';

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
  const task = ts.createTask({
    orgId: ORG, title: 'Task', description: 'Do something',
    assignedAgentId: AGENT_A, reviewerId: REVIEWER, creatorRole: 'human',
  } as never);
  ts.approveTask(task.id, 'user-1');
  await ts.submitForReview(task.id, [{ type: 'file', reference: '/tmp/out.txt', summary: 'Output' }]);
  return ts.getTask(task.id)!;
}

/** 抓取发给评审人的 review_request 投递调用（扇出计数）。 */
function reviewDispatches(agentManager: ReturnType<typeof createMockAgentManager>) {
  const sendMessage = agentManager.getAgent(REVIEWER).sendMessage as unknown as {
    mock: { calls: unknown[][] };
  };
  return sendMessage.mock.calls.filter(
    c => (c[3] as Record<string, unknown> | undefined)?.['sourceType'] === 'review_request',
  );
}

describe('验收 #2 · 同 (task_id, round) 重复收口 / 多分身扇出投递', () => {
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
    expect(transitionSpy, '重复 approve 不得产生第二次状态转移').not.toHaveBeenCalled();
  });

  it('同轮重复 requestRevision 幂等：executionRound 不再自增、无额外转移', async () => {
    const task = await createTaskInReview(ts);
    const r1 = await ts.requestRevision(task.id, 'fix A', REVIEWER);
    expect(r1.status).toBe('in_progress');
    expect(r1.executionRound).toBe(2);

    const transitionSpy = vi.spyOn(ts, 'updateTaskStatus');
    const r2 = await ts.requestRevision(task.id, 'fix A', REVIEWER);

    expect(r2.status).toBe('in_progress');
    expect(r2.executionRound, '重复 revision 不得凭空多开一轮').toBe(2);
    expect(transitionSpy).not.toHaveBeenCalled();
  });

  it('迟到 approve（该轮已被 revision 收口）返回当前状态、不复活为 completed', async () => {
    const task = await createTaskInReview(ts);
    await ts.requestRevision(task.id, 'needs rework', REVIEWER);
    expect(ts.getTask(task.id)!.status).toBe('in_progress');

    const transitionSpy = vi.spyOn(ts, 'updateTaskStatus');
    const late = ts.acceptTask(task.id, REVIEWER);

    expect(late.status).toBe('in_progress');
    expect(transitionSpy).not.toHaveBeenCalled();
  });

  it('多分身扇出：同一轮 review_request 被 3 个分身重复投递 → 仅 1 次真正送达评审人', async () => {
    const task = await createTaskInReview(ts);
    const notify = (ts as unknown as {
      notifyReviewer: (t: unknown, r: string) => void;
    }).notifyReviewer.bind(ts);

    // 3 个并发分身各自触发同一 (task, round=1) 的评审通知
    notify(ts.getTask(task.id), REVIEWER);
    notify(ts.getTask(task.id), REVIEWER);
    notify(ts.getTask(task.id), REVIEWER);

    expect(reviewDispatches(agentManager), '同轮评审只投递一次').toHaveLength(1);
  });

  it('不过度抑制：新一轮（round 2）提交后仍可正常 approve', async () => {
    const task = await createTaskInReview(ts);
    await ts.requestRevision(task.id, 'redo', REVIEWER);
    await ts.submitForReview(task.id, [{ type: 'file', reference: '/tmp/v2.txt', summary: 'v2' }]);
    expect(ts.getTask(task.id)!.status).toBe('review');

    const done = ts.acceptTask(task.id, REVIEWER);
    expect(done.status).toBe('completed');
  });
});
