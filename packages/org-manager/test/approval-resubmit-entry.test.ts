/**
 * T2 · 建卡闸「重新发起审批」入口 —— 打回回路第③段
 *
 * 打回 = ①保持 pending ②评论 ③负责人更新后**重新发起审批**，三段缺一不可。
 * 缺第③段 → 「无活跃审批的孤儿任务」：respondToApproval 已把该 approval 由
 * pending 改写为非 pending ⇒ 不再出现在 listApprovals('pending')；全仓无 task 级
 * resubmit ⇒ 唯一放行口只剩管理员端点 POST /api/tasks/:id/approve（绕过审批闸）。
 *
 * 本文件锁死：
 *   1. 打回后任务仍 pending 且**无活跃审批**（孤儿态的前提成立）。
 *   2. requestTaskApproval 能重新打开闸门 → 出现**新的** pending 审批（details.taskId）。
 *   3. 幂等/守卫：非 pending、已有活跃审批 ⇒ 抛可行动错误，不静默。
 *   4. SSOT：重提与首次建卡共用同一发起实现 ⇒ 决策仍由**同一**单一执行点落地
 *      （再打回仍 pending；再通过则正常启动）。
 */
import { describe, it, expect, vi } from 'vitest';
import { TaskService } from '../src/task-service.js';
import { HITLService } from '../src/hitl-service.js';
import { ApprovalApplier } from '../src/approval-apply.js';

const AGENT_A = 'agent-a';
const AGENT_B = 'agent-b';
const REVIEWER = 'reviewer-1';
const ORG = 'org-1';

function createMockAgentManager() {
  const agents = new Set([AGENT_A, AGENT_B, REVIEWER]);
  return {
    hasAgent: vi.fn((id: string) => agents.has(id)),
    getAgent: vi.fn((id: string) => ({ config: { name: id, orgId: ORG } })),
    listAgents: vi.fn(() => [{ id: AGENT_A }, { id: AGENT_B }]),
  };
}

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

function createHarness() {
  const agentManager = createMockAgentManager();
  const hitlService = new HITLService();
  const comments: Array<Record<string, unknown>> = [];

  const ts = new TaskService();
  ts.setAgentManager(agentManager as never);
  ts.setWSBroadcaster({ broadcast: vi.fn(), broadcastTaskCreate: vi.fn(), broadcastTaskUpdate: vi.fn() } as never);
  ts.setGovernancePolicy({
    enabled: false, defaultTier: 'auto', maxPendingTasksPerAgent: 100, maxTotalActiveTasks: 100,
    requireApprovalForPriority: [], requireRequirement: false, rules: [],
  });
  ts.setTaskCommentRepo({
    add: vi.fn(async (row: Record<string, unknown>) => {
      const stored = { id: `c-${comments.length + 1}`, createdAt: new Date(), ...row };
      comments.push(stored);
      return stored;
    }),
    getByTask: vi.fn(async (taskId: string) => comments.filter(c => c['taskId'] === taskId)),
  } as never);
  ts.setHITLService(hitlService);

  const applier = new ApprovalApplier(hitlService);
  applier.registerPort(ts);
  ts.setApprovalApplier(applier);

  vi.spyOn(hitlService, 'notify').mockReturnValue(undefined as never);

  return { ts, hitlService, applier, comments };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise<void>(resolve => setImmediate(resolve));
}

function gateApprovals(hitlService: HITLService, taskId: string) {
  return hitlService.listApprovals().filter(
    a => (a.details as Record<string, unknown> | undefined)?.['taskId'] === taskId,
  );
}

function pendingGateApproval(hitlService: HITLService, taskId: string) {
  const approval = gateApprovals(hitlService, taskId).find(a => a.status === 'pending');
  if (!approval) throw new Error(`No pending gate approval for task ${taskId}`);
  return approval;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 打回后确实是「孤儿态」——这正是本卡要补的缺口
// ─────────────────────────────────────────────────────────────────────────────
describe('打回后的孤儿态（缺口前提）', () => {
  it('打回 ⇒ 任务仍 pending，且**没有任何活跃审批**（无活跃审批 = 孤儿）', async () => {
    const { ts, hitlService } = createHarness();
    const task = ts.createTask(createDefaults({ creatorRole: 'worker', createdBy: AGENT_B }) as never);
    const approval = pendingGateApproval(hitlService, task.id);

    hitlService.respondToApproval(approval.id, false, 'user-1', '拆细一点', 'request_changes');
    await flush();

    expect(ts.getTask(task.id)!.status).toBe('pending');
    expect(hitlService.getApproval(approval.id)!.status).toBe('changes_requested');
    // 关键：原审批已不是 pending，任务却没有活跃审批 → 必须有第③段入口才不至于卡死
    expect(hitlService.listApprovals('pending').some(
      a => (a.details as Record<string, unknown> | undefined)?.['taskId'] === task.id,
    )).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. 重提入口：重新打开闸门
// ─────────────────────────────────────────────────────────────────────────────
describe('requestTaskApproval · 重开闸门', () => {
  it('打回后可重新发起审批 ⇒ 出现新的 pending 审批，且是 details.taskId 定向的', async () => {
    const { ts, hitlService } = createHarness();
    const task = ts.createTask(createDefaults({ creatorRole: 'worker', createdBy: AGENT_B }) as never);
    const first = pendingGateApproval(hitlService, task.id);
    hitlService.respondToApproval(first.id, false, 'user-1', '拆细一点', 'request_changes');
    await flush();

    const beforeIds = new Set(gateApprovals(hitlService, task.id).map(a => a.id));
    const result = ts.requestTaskApproval(task.id, AGENT_B);

    expect(result.taskId).toBe(task.id);
    expect(result.approvalId).toBeTruthy();
    expect(beforeIds.has(result.approvalId)).toBe(false);

    const reopened = pendingGateApproval(hitlService, task.id);
    expect(reopened.id).toBe(result.approvalId);
    expect((reopened.details as Record<string, unknown>)['subType']).toBe('task');
    // 任务本身零转移
    expect(ts.getTask(task.id)!.status).toBe('pending');
    expect(ts.getTask(task.id)!.approvedVia).toBeUndefined();
  });

  it('再打回 ⇒ 仍 pending（零状态转移）；再通过 ⇒ 正常启动（同一执行点）', async () => {
    const { ts, hitlService } = createHarness();
    const task = ts.createTask(createDefaults({ creatorRole: 'worker', createdBy: AGENT_B }) as never);
    hitlService.respondToApproval(pendingGateApproval(hitlService, task.id).id, false, 'u', '再改', 'request_changes');
    await flush();

    const reopenedId = ts.requestTaskApproval(task.id, AGENT_B).approvalId;
    hitlService.respondToApproval(reopenedId, false, 'u', '还不够细', 'needs_adjustment');
    await flush();
    expect(ts.getTask(task.id)!.status).toBe('pending');

    // 第三次重提 + 通过
    const thirdId = ts.requestTaskApproval(task.id, AGENT_B).approvalId;
    hitlService.respondToApproval(thirdId, true, 'u', undefined, 'approve');
    await flush();
    expect(ts.getTask(task.id)!.status).toBe('in_progress');
    expect(ts.getTask(task.id)!.approvedVia).toBe('human');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. 幂等 / 守卫：拒绝 + 可行动提示，不静默
// ─────────────────────────────────────────────────────────────────────────────
describe('requestTaskApproval · 守卫', () => {
  it('首次建卡闸仍活跃时重提 ⇒ 抛「已有活跃审批」，且不新增审批', () => {
    const { ts, hitlService } = createHarness();
    const task = ts.createTask(createDefaults({ creatorRole: 'worker', createdBy: AGENT_B }) as never);
    const count = gateApprovals(hitlService, task.id).length;

    expect(() => ts.requestTaskApproval(task.id)).toThrow(/active approval/i);
    expect(gateApprovals(hitlService, task.id).length).toBe(count);
  });

  it('非 pending 任务 ⇒ 抛「非 pending」（不静默）', async () => {
    const { ts, hitlService } = createHarness();
    const task = ts.createTask(createDefaults({ creatorRole: 'worker', createdBy: AGENT_B }) as never);
    hitlService.respondToApproval(pendingGateApproval(hitlService, task.id).id, true, 'u', undefined, 'approve');
    await flush();

    expect(ts.getTask(task.id)!.status).toBe('in_progress');
    expect(() => ts.requestTaskApproval(task.id)).toThrow(/pending/i);
  });

  it('不存在的任务 ⇒ 抛 not found', () => {
    const { ts } = createHarness();
    expect(() => ts.requestTaskApproval('tsk_missing')).toThrow(/not found/i);
  });

  it('连调两次：第二次被活跃审批挡下（幂等的正例是「第一次成功、第二次拒绝」）', () => {
    const { ts, hitlService } = createHarness();
    const task = ts.createTask(createDefaults({ creatorRole: 'worker', createdBy: AGENT_B }) as never);
    hitlService.respondToApproval(pendingGateApproval(hitlService, task.id).id, false, 'u', 'x', 'request_changes');

    const first = ts.requestTaskApproval(task.id, AGENT_B);
    expect(first.approvalId).toBeTruthy();
    expect(() => ts.requestTaskApproval(task.id, AGENT_B)).toThrow(/active approval/i);
  });
});
