/**
 * 评审简报契约 —— 「评审是决策，不是执行」的行为守卫
 *
 * 事故（2026-11-11，tsk_594b439a4362be43984bc86b）：评审人在 6 个回合、20 个工具、
 * 618,091 tokens 之后**一次都没改卡片**，卡片永久停在 `review`。
 *
 * 根因之一是评审简报自相矛盾：`367d898fd`（2026-04-09）把「批准」绑定成
 * 「先 `git merge` / `gh pr merge` 再改状态」。对零代码卡（证据归档 / 门禁裁决）
 * 这条路径根本不存在，尽责的评审人只能原地核验 —— 看起来像「在干活」。
 *
 * 修法**不是**在提示词里硬写「不许合并/发版」：任务本身是抽象的，很多任务与代码
 * 无关，Markus 也服务许多需求各异的用户。平台只守授权边界——按任务上下文判断，
 * 不清楚就问上级/人，没许可就别动手；宁可不做，只评审。
 *
 * 本文件锚定三条不可退让的事实：
 *  1. 简报不得要求评审人合并分支 / 发版（那是 Owner 的决定）。
 *  2. 简报必须给出两条**可执行**的决策路径（approve / revision）。
 *  3. 简报的稳定前缀与任务内容无关（缓存友好：变量只在尾部）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TaskService } from '../src/task-service.js';

const AGENT_A = 'agent-a';
const REVIEWER = 'reviewer-1';
const ORG = 'org-1';

type ExecutionLogEntry = {
  type: string;
  content: string;
  persist?: boolean;
  metadata?: Record<string, unknown>;
};

function createMockAgentManager() {
  const agents = new Set([AGENT_A, REVIEWER]);
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
      await logFn({ type: 'status', content: 'execution_finished', persist: true });
    }),
  });
  const agentMap = new Map([[AGENT_A, makeAgent(AGENT_A)], [REVIEWER, makeAgent(REVIEWER)]]);
  return {
    hasAgent: vi.fn((id: string) => agents.has(id)),
    getAgent: vi.fn((id: string) => {
      const agent = agentMap.get(id);
      if (!agent) throw new Error(`Agent not found: ${id}`);
      return agent;
    }),
    listAgents: vi.fn(() => [{ id: AGENT_A }]),
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
  svc.setWSBroadcaster({
    broadcast: vi.fn(),
    broadcastTaskCreate: vi.fn(),
    broadcastTaskUpdate: vi.fn(),
  } as never);
  return { svc, agentManager };
}

/** 造一张处于 review 的卡，并返回投递给评审人的简报正文。 */
async function dispatchBrief(
  svc: TaskService,
  agentManager: ReturnType<typeof createMockAgentManager>,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const task = svc.createTask({
    orgId: ORG,
    title: 'Task',
    description: 'DESCRIPTION-SENTINEL should not be inlined',
    assignedAgentId: AGENT_A,
    reviewerId: REVIEWER,
    creatorRole: 'human',
    ...overrides,
  } as never);
  svc.approveTask(task.id, 'user-1');
  await svc.submitForReview(task.id, [
    { type: 'file', reference: '/tmp/out.txt', summary: 'Output' },
  ]);

  const sendMessage = agentManager.getAgent(REVIEWER).sendMessage as unknown as {
    mock: { calls: unknown[][] };
  };
  const dispatch = sendMessage.mock.calls.filter(
    c => (c[3] as Record<string, unknown> | undefined)?.['sourceType'] === 'review_request',
  );
  expect(dispatch.length).toBeGreaterThan(0);
  // Take the LAST dispatch, not the first: the mock's call list is cumulative when a
  // test dispatches twice (different tasks) to compare their stable prefixes.
  return dispatch[dispatch.length - 1]![0] as string;
}

describe('评审简报契约：决策，不是执行', () => {
  let svc: TaskService;
  let agentManager: ReturnType<typeof createMockAgentManager>;

  beforeEach(() => {
    const made = createService();
    svc = made.svc;
    agentManager = made.agentManager;
  });

  it('不硬编码任何动作禁令，只给授权边界（任务上下文说了算）', async () => {
    const brief = await dispatchBrief(svc, agentManager);

    expect(brief).not.toMatch(/merge the branch/i);
    expect(brief).not.toMatch(/gh pr merge/i);
    expect(brief).not.toMatch(/git merge/i);

    // 反向确认：约束是「按卡片授权 + 不清楚就问 + 没许可不动手」，
    // 而不是「禁止合并/发版」这种只对代码任务成立的硬编码规则。
    expect(brief).toMatch(/never act without permission/i);
    expect(brief).toMatch(/ask the assignee|your supervisor|a human/i);
    expect(brief).not.toMatch(/do not merge/i);
    expect(brief).not.toMatch(/do not publish/i);
  });

  it('给出两条可执行的决策路径（approve / revision），都落在 task_update 上', async () => {
    const brief = await dispatchBrief(svc, agentManager);

    expect(brief).toMatch(/Approve/i);
    expect(brief).toMatch(/Request revision/i);
    expect(brief).toMatch(/task_update/);
    expect(brief).toMatch(/completed/);
    expect(brief).toMatch(/in_progress/);
  });

  it('明确告知「不做决定 = 未解决，会上报」，而不是让人以为可以空转', async () => {
    const brief = await dispatchBrief(svc, agentManager);

    expect(brief).toMatch(/exactly ONE call/i);
    expect(brief).toMatch(/it is escalated/i);
  });

  it('不再内联完整任务描述（7143 字符的根因），改为让人按需 task_get', async () => {
    const brief = await dispatchBrief(svc, agentManager, {
      description: 'DESCRIPTION-SENTINEL must stay on the card, not in the brief',
    });

    expect(brief).not.toContain('DESCRIPTION-SENTINEL');
    expect(brief).toMatch(/task_get/);
  });

  it('稳定前缀与任务内容无关（缓存友好：变量只在尾部）', async () => {
    const briefA = await dispatchBrief(svc, agentManager, {
      title: 'Alpha 任务',
      description: 'alpha body',
    });
    const briefB = await dispatchBrief(svc, agentManager, {
      title: '完全不同的 Beta 任务',
      description: 'beta body entirely different shape',
    });

    // 前 8 行是稳定指令前缀：两个不同任务必须逐字相同。
    const prefix = (s: string) => s.split('\n').slice(0, 8).join('\n');
    expect(prefix(briefA)).toBe(prefix(briefB));

    // 变量确实在尾部，且各自出现。
    expect(briefA).toContain('Alpha 任务');
    expect(briefB).toContain('完全不同的 Beta 任务');
  });

  it('包含任务 ID 与轮次，评审人不必猜对象', async () => {
    const brief = await dispatchBrief(svc, agentManager);

    expect(brief).toMatch(/Task ID: tsk_/);
    expect(brief).toMatch(/Review round: \d+/);
  });
});
