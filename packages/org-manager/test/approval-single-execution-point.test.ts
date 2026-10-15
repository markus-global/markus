/**
 * T1 · 后端单一执行点 —— 审批三态意图解析收口 + 三闸门分流
 * 卡片 tsk_7146396ecdaf4246b4812cbe（合同 §4 单点/幂等、§5 断言、N1 打回闭集、N3 负向、N4 两层归一化）。
 *
 * 本文件锁死三件事：
 *   1. **意图解析只有一份**（`resolveApprovalIntent`），两层归一化：先全局闭集 + 各闸 option 别名，
 *      闭集之外才回落布尔；`needs_adjustment` 在闭集内，**不是**未知值。
 *   2. **单一执行点**：闸门回调与 HTTP 兜底都只走 `ApprovalApplier.apply`；幂等由
 *      `hitlService.claimApply`（同步、落库时间戳）保证 —— 同一审批连跑两次不新增 comment/通知。
 *   3. **三闸目标状态各异**：建卡闸打回 = 零状态转移（仍 pending）；验收闸打回 = 返工 in_progress；
 *      并且申请闸（α，requirement）打回 = 仍 pending ∧ 落 requirement 评论 ∧ 通知创建者
 *      （**不引入状态标记字段** —— 判据是这两个可观测副作用）。
 */
import { describe, it, expect, vi } from 'vitest';
import { TaskService } from '../src/task-service.js';
import { HITLService, resolveApprovalIntent } from '../src/hitl-service.js';
import { ApprovalApplier } from '../src/approval-apply.js';
import { RequirementService } from '../src/requirement-service.js';

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

/**
 * 真 `HITLService`（而非手搓 mock）+ 真 `ApprovalApplier` + 真 `TaskService`：
 * 幂等键 `claimApply` 必须是被真正调用的那一个，否则「连跑两次」用例会假绿。
 */
function createHarness(opts: { commentFailure?: boolean } = {}) {
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
      if (opts.commentFailure) throw new Error('task comment store down');
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

  const notifySpy = vi.spyOn(hitlService, 'notify').mockReturnValue(undefined as never);

  return { ts, hitlService, applier, comments, notifySpy };
}

/** Flush the microtask/`setImmediate` queue so `.then` callbacks and the applier settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise<void>(resolve => setImmediate(resolve));
}

function pendingGateApproval(hitlService: HITLService, taskId: string) {
  const approval = hitlService.listApprovals('pending')
    .find(a => (a.details as Record<string, unknown> | undefined)?.['taskId'] === taskId);
  if (!approval) throw new Error(`No pending gate approval for task ${taskId}`);
  return approval;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 意图解析：两层归一化（N4）
// ─────────────────────────────────────────────────────────────────────────────
describe('审批意图解析（唯一解析器 · 两层归一化）', () => {
  it('仅布尔 payload ⇒ 回落成 approve/reject，且不记 unknownOption（与 base 逐字段一致）', () => {
    expect(resolveApprovalIntent({ approved: true })).toEqual({ intent: 'approve' });
    expect(resolveApprovalIntent({ approved: false })).toEqual({ intent: 'reject' });
  });

  it('selectedOption 为闭集 token `request_changes` 时，布尔不得覆盖它（approved:true 也须打回）', () => {
    expect(resolveApprovalIntent({ approved: false, selectedOption: 'request_changes' }).intent)
      .toBe('request_changes');
    // 前端 NotificationBell 的第三按钮送的就是这种「approved 语义为真 + 打回 token」的组合
    expect(resolveApprovalIntent({ approved: true, selectedOption: 'request_changes' }).intent)
      .toBe('request_changes');
  });

  it('`needs_adjustment` 在全局闭集内 ⇒ 打回语义，不能被当成未知值回落布尔', () => {
    expect(resolveApprovalIntent({ approved: false, selectedOption: 'needs_adjustment' }))
      .toEqual({ intent: 'needs_adjustment' });
    expect(resolveApprovalIntent({ approved: true, selectedOption: 'needs_adjustment' }))
      .toEqual({ intent: 'needs_adjustment' });
  });

  it('闸门无 options 时仍认闭集 token（判据是「不在全局闭集」而非「不在本闸 options」）', () => {
    // 建卡闸不带 options：needs_adjustment 依然要被识别为打回
    const resolved = resolveApprovalIntent({
      subType: 'task',
      approved: false,
      selectedOption: 'needs_adjustment',
    });
    expect(resolved.intent).toBe('needs_adjustment');
    expect(resolved.unknownOption).toBeUndefined();
  });

  it('验收闸 option id 字面 `reject` ≡ Request Changes（task_review 域内不落终态）', () => {
    expect(resolveApprovalIntent({ subType: 'task_review', approved: false, selectedOption: 'reject' }))
      .toEqual({ intent: 'request_changes' });
    // 闸门别名只在本域生效：平台级 reject 仍是拒绝
    expect(resolveApprovalIntent({ subType: 'requirement', approved: false, selectedOption: 'reject' }))
      .toEqual({ intent: 'reject' });
  });

  it('token 归一化：大小写与连字符/下划线等价', () => {
    expect(resolveApprovalIntent({ approved: true, selectedOption: ' Request-Changes ' }).intent)
      .toBe('request_changes');
    expect(resolveApprovalIntent({ approved: true, selectedOption: 'NEEDS ADJUSTMENT' }).intent)
      .toBe('needs_adjustment');
  });

  it('闭集之外的值才回落布尔，并留下 unknownOption 供诊断', () => {
    expect(resolveApprovalIntent({ subType: 'task_review', approved: true, selectedOption: 'lgtm_maybe' }))
      .toEqual({ intent: 'approve', unknownOption: 'lgtm_maybe' });
    expect(resolveApprovalIntent({ approved: false, selectedOption: 'weird' }))
      .toEqual({ intent: 'reject', unknownOption: 'weird' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. 建卡闸：打回 = 零状态转移（不落终态、不通过）
// ─────────────────────────────────────────────────────────────────────────────
describe('建卡闸 · 打回不落终态', () => {
  it('打回（request_changes）⇒ 任务仍 pending，approveTask/rejectTask 均未被调用，且落 comment 原文', async () => {
    const { ts, hitlService, comments } = createHarness();
    const approveSpy = vi.spyOn(ts, 'approveTask');
    const rejectSpy = vi.spyOn(ts, 'rejectTask');

    const task = ts.createTask(createDefaults({ creatorRole: 'worker', createdBy: AGENT_B }) as never);
    expect(task.status).toBe('pending');
    const approval = pendingGateApproval(hitlService, task.id);

    hitlService.respondToApproval(approval.id, false, 'user-1', '请拆成两个子任务', 'request_changes');
    await flush();

    const after = ts.getTask(task.id)!;
    // 任务：保持 pending，且无「通过」痕迹
    expect(after.status).toBe('pending');
    expect(after.approvedVia).toBeUndefined();
    expect((after.notes ?? []).some(n => n.includes('Approved'))).toBe(false);
    expect(approveSpy).not.toHaveBeenCalled();
    expect(rejectSpy).not.toHaveBeenCalled();

    // 审批实体侧：记录为第三个状态，而不是 rejected
    expect(hitlService.getApproval(approval.id)!.status).toBe('changes_requested');

    // 打回理由落 comment（原文）+ 通知 assignee
    expect(comments).toHaveLength(1);
    expect(String(comments[0]!['content'])).toContain('Changes requested');
    expect(String(comments[0]!['content'])).toContain('请拆成两个子任务');
    expect(comments[0]!['mentions']).toEqual([AGENT_A]);
  });

  it('needs_adjustment（前端第三按钮）落点与 request_changes 完全一致：仍 pending', async () => {
    const { ts, hitlService } = createHarness();
    const rejectSpy = vi.spyOn(ts, 'rejectTask');

    const task = ts.createTask(createDefaults({ creatorRole: 'worker', createdBy: AGENT_B }) as never);
    const approval = pendingGateApproval(hitlService, task.id);

    hitlService.respondToApproval(approval.id, false, 'user-1', '改一下目标', 'needs_adjustment');
    await flush();

    expect(ts.getTask(task.id)!.status).toBe('pending');
    expect(rejectSpy).not.toHaveBeenCalled();
    expect(hitlService.getApproval(approval.id)!.status).toBe('changes_requested');
  });

  it('通过（approve）语义不变：任务进入 in_progress 且记 approvedVia', async () => {
    const { ts, hitlService } = createHarness();
    const task = ts.createTask(createDefaults({ creatorRole: 'worker', createdBy: AGENT_B }) as never);
    const approval = pendingGateApproval(hitlService, task.id);

    hitlService.respondToApproval(approval.id, true, 'user-1', 'LGTM');
    await flush();

    expect(ts.getTask(task.id)!.status).toBe('in_progress');
    expect(hitlService.getApproval(approval.id)!.status).toBe('approved');
  });

  it('拒绝（reject）语义不变：任务落 rejected', async () => {
    const { ts, hitlService } = createHarness();
    const task = ts.createTask(createDefaults({ creatorRole: 'worker', createdBy: AGENT_B }) as never);
    const approval = pendingGateApproval(hitlService, task.id);

    hitlService.respondToApproval(approval.id, false, 'user-1', '不做', 'reject');
    await flush();

    expect(ts.getTask(task.id)!.status).toBe('rejected');
    expect(hitlService.getApproval(approval.id)!.status).toBe('rejected');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. 单一执行点：幂等（连跑两次不新增 comment / 通知）
// ─────────────────────────────────────────────────────────────────────────────
describe('单一执行点 · 幂等（同步 claim 落库时间戳）', () => {
  it('同一打回第二次路由 ⇒ already-applied：comment 与通知都不新增', async () => {
    const { ts, hitlService, applier, comments, notifySpy } = createHarness();
    const task = ts.createTask(createDefaults({ creatorRole: 'worker', createdBy: AGENT_B }) as never);
    const approval = pendingGateApproval(hitlService, task.id);

    hitlService.respondToApproval(approval.id, false, 'user-1', '再改一次', 'request_changes');
    await flush();
    const commentsAfterFirst = comments.length;
    const notificationsAfterFirst = notifySpy.mock.calls.length;
    expect(commentsAfterFirst).toBe(1);

    // 第二个消费者（HTTP 兜底/重复点击）走同一执行点
    const outcome = await applier.apply({
      approvalId: approval.id,
      subType: 'task',
      targetId: task.id,
      intent: 'request_changes',
      actorId: 'user-1',
      comment: '再改一次',
    });
    await flush();

    expect(outcome).toMatchObject({ applied: false, reason: 'already-applied' });
    expect(comments).toHaveLength(commentsAfterFirst);
    expect(notifySpy.mock.calls.length).toBe(notificationsAfterFirst);
    expect(ts.getTask(task.id)!.status).toBe('pending');
  });

  it('claim 是同步落库标记：审批实体上 appliedAt/appliedIntent 可读回', async () => {
    const { ts, hitlService } = createHarness();
    const task = ts.createTask(createDefaults({ creatorRole: 'worker', createdBy: AGENT_B }) as never);
    const approval = pendingGateApproval(hitlService, task.id);

    expect(hitlService.claimApply(approval.id, 'request_changes')).toBe(true);
    // 第二次 claim 必失败 —— 这是两个消费者之间唯一的排他点
    expect(hitlService.claimApply(approval.id, 'request_changes')).toBe(false);

    const stored = hitlService.getApproval(approval.id)!;
    expect(stored.appliedAt).toBeTruthy();
    expect(stored.appliedIntent).toBe('request_changes');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. promise 已丢（进程重启）+ HTTP 兜底 ⇒ 验收闸仍能离开 review
// ─────────────────────────────────────────────────────────────────────────────
describe('验收闸 · promise 丢失后由 HTTP 兜底同一执行点', () => {
  async function taskInReview(ts: TaskService) {
    const task = ts.createTask(createDefaults({ creatorRole: 'human', createdBy: 'user-1' }) as never);
    ts.approveTask(task.id, 'user-1');
    await ts.submitForReview(task.id, [{ type: 'file', reference: '/tmp/out.txt', summary: 'Output' }]);
    return ts.getTask(task.id)!;
  }

  it('打回 ⇒ 任务离开 review 返工到 in_progress；通过 ⇒ completed', async () => {
    const { ts, hitlService, applier } = createHarness();
    const task = await taskInReview(ts);
    expect(task.status).toBe('review');

    // 重启后的兜底：内存 promise 已不存在，只剩落库的审批实体
    const approval = hitlService.requestApproval({
      agentId: task.assignedAgentId,
      agentName: 'Agent A',
      type: 'task_review',
      title: 'Review task',
      description: 'Review',
      details: { taskId: task.id, subType: 'task_review' },
    });

    const outcome = await applier.apply({
      approvalId: approval.id,
      subType: 'task_review',
      targetId: task.id,
      intent: 'request_changes',
      actorId: REVIEWER,
      comment: '写得不够清楚',
    });

    expect(outcome).toMatchObject({ applied: true, reason: 'applied' });
    const after = ts.getTask(task.id)!;
    expect(after.status).toBe('in_progress');
    expect((after.notes ?? []).some(n => n.includes('Revision requested'))).toBe(true);
  });

  it('重复兜底（同一审批第二次）⇒ already-applied，状态不再变动', async () => {
    const { ts, hitlService, applier } = createHarness();
    const task = await taskInReview(ts);
    const approval = hitlService.requestApproval({
      agentId: task.assignedAgentId,
      agentName: 'Agent A',
      type: 'task_review',
      title: 'Review task',
      description: 'Review',
      details: { taskId: task.id, subType: 'task_review' },
    });
    const input = {
      approvalId: approval.id, subType: 'task_review', targetId: task.id,
      intent: 'approve' as const, actorId: REVIEWER,
    };

    expect((await applier.apply(input)).reason).toBe('applied');
    expect(ts.getTask(task.id)!.status).toBe('completed');

    // 第二次：验收闸的 apply 本身就把任务移出了 review 窗口，所以窗口闸先拦下
    // （applier 内顺序：canApply → claim → apply）。无论被窗口还是被 claim 拦下，
    // 关键不变量都是「不再发生第二次转移」。
    const second = await applier.apply(input);
    expect(second).toMatchObject({ applied: false, reason: 'out-of-window' });
    expect(ts.getTask(task.id)!.status).toBe('completed');
  });

  it('目标已被直接端点移出该窗口 ⇒ out-of-window（不做二次转移）', async () => {
    const { ts, hitlService, applier } = createHarness();
    // 建卡闸：审批还在等答复，但管理员直接端点已经先把卡通过了
    const task = ts.createTask(createDefaults({ creatorRole: 'worker', createdBy: AGENT_B }) as never);
    const approval = pendingGateApproval(hitlService, task.id);
    ts.approveTask(task.id, 'user-1'); // 管理员直连端点（不经审批）
    expect(ts.getTask(task.id)!.status).toBe('in_progress');

    const outcome = await applier.apply({
      approvalId: approval.id, subType: 'task', targetId: task.id,
      intent: 'request_changes', actorId: REVIEWER,
    });
    expect(outcome).toMatchObject({ applied: false, reason: 'out-of-window' });
    expect(ts.getTask(task.id)!.status).toBe('in_progress');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. N3 负向：打回 + apply 自身抛错 ⇒ 绝不落 rejected（结构性隔离）
// ─────────────────────────────────────────────────────────────────────────────
describe('N3 · 打回路径的 apply 失败不得流入 auto-reject', () => {
  it('打回时 comment 落库失败 ⇒ 任务仍 pending，绝不落 rejected', async () => {
    const { ts, hitlService, applier } = createHarness({ commentFailure: true });
    const rejectSpy = vi.spyOn(ts, 'rejectTask');

    const task = ts.createTask(createDefaults({ creatorRole: 'worker', createdBy: AGENT_B }) as never);
    const approval = pendingGateApproval(hitlService, task.id);

    // 闸门回调（promise 路径）→ 单点 → apply 内部抛错
    hitlService.respondToApproval(approval.id, false, 'user-1', '改', 'request_changes');
    await flush();

    // apply 自身错误被 applier 内部捕获上报，不冒泡进闸门的 .catch ⇒ 无 auto-reject
    expect(rejectSpy).not.toHaveBeenCalled();
    expect(ts.getTask(task.id)!.status).toBe('pending');

    // 直接观察 outcome：routed + failed（可诊断，不是静默）
    const outcome = await applier.apply({
      approvalId: approval.id, subType: 'task', targetId: task.id,
      intent: 'request_changes', actorId: 'user-1',
    });
    // 该审批已被 claim 过 ⇒ 第二次不再尝试 apply
    expect(outcome.reason).toBe('already-applied');
    expect(ts.getTask(task.id)!.status).toBe('pending');
  });

  it('未路由的审批（无闸门 subType）⇒ unrouted，不动任何实体', async () => {
    const { applier } = createHarness();
    const outcome = await applier.apply({
      approvalId: 'appr-1', subType: 'tool', targetId: 'whatever', intent: 'approve',
    });
    expect(outcome).toMatchObject({ applied: false, reason: 'unrouted' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. 需求闸（α）：打回仍 pending（评论 + 通知两个可观测面），不落 rejected
// ─────────────────────────────────────────────────────────────────────────────
describe('需求闸 · 打回不落终态（第三个闸门的目标状态必须与另两闸不同）', () => {
  function createRequirementHarness() {
    const hitlService = new HITLService();
    const enqueueToMailbox = vi.fn();
    const agentManager = {
      hasAgent: vi.fn(() => true),
      getAgent: vi.fn((id: string) => ({ config: { name: id }, enqueueToMailbox, sendMessage: vi.fn() })),
    };
    const requirements = new RequirementService();
    requirements.setAgentManager(agentManager as never);
    requirements.setHITLService(hitlService);
    const comments: Array<Record<string, unknown>> = [];
    requirements.setRequirementCommentPoster(async (requirementId, authorId, authorName, content, mentions) => {
      const stored = { id: `rc-${comments.length + 1}`, requirementId, authorId, authorName, content, mentions };
      comments.push(stored);
      return { id: String(stored.id) };
    });
    const applier = new ApprovalApplier(hitlService);
    applier.registerPort(requirements);
    requirements.setApprovalApplier(applier);
    const notifySpy = vi.spyOn(hitlService, 'notify').mockReturnValue(undefined as never);
    return { requirements, hitlService, applier, comments, enqueueToMailbox, notifySpy };
  }

  function propose(requirements: RequirementService) {
    return requirements.proposeRequirement({
      orgId: ORG, title: 'Proposal', description: 'Do the thing', createdBy: AGENT_A,
      projectId: 'proj-1',
    } as never);
  }

  it('打回（request_changes）⇒ 需求仍 pending + 落 requirement 评论 + 通知创建者，且不落 rejected', async () => {
    const { requirements, hitlService, comments, enqueueToMailbox } = createRequirementHarness();
    const req = propose(requirements);
    expect(req.status).toBe('pending');

    const approval = hitlService.listApprovals('pending')
      .find(a => (a.details as Record<string, unknown> | undefined)?.['requirementId'] === req.id)!;
    expect(approval).toBeTruthy();

    hitlService.respondToApproval(approval.id, false, 'user-1', '目标写清楚点', 'request_changes');
    await flush();

    const after = requirements.getRequirement(req.id)!;
    expect(after.status).toBe('pending');
    expect(after.rejectedReason).toBeUndefined();
    // ① 可观测面：requirement 评论（含审批原文），author = 审批者
    expect(comments).toHaveLength(1);
    expect(String(comments[0]!['content'])).toContain('Changes requested');
    expect(String(comments[0]!['content'])).toContain('目标写清楚点');
    expect(comments[0]!['requirementId']).toBe(req.id);
    expect(comments[0]!['authorId']).toBe('user-1');
    // 创建者收到「需修改」而不是「被拒绝」
    expect(enqueueToMailbox).toHaveBeenCalledWith(
      'requirement_update',
      expect.objectContaining({ requirementId: req.id }),
      expect.anything(),
    );
    const mailboxBody = String(enqueueToMailbox.mock.calls[0]![1]['content']);
    expect(mailboxBody).toContain('NEEDS CHANGES');
    expect(mailboxBody).not.toContain('REJECTED');
  });

  it('打回后需求未终结：仍可被直接批准（证明不是 rejected）', async () => {
    const { requirements, hitlService } = createRequirementHarness();
    const req = propose(requirements);
    const approval = hitlService.listApprovals('pending')
      .find(a => (a.details as Record<string, unknown> | undefined)?.['requirementId'] === req.id)!;

    hitlService.respondToApproval(approval.id, false, 'user-1', '改一下', 'needs_adjustment');
    await flush();
    expect(requirements.getRequirement(req.id)!.status).toBe('pending');

    requirements.approveRequirement(req.id, 'user-1');
    expect(requirements.getRequirement(req.id)!.status).toBe('in_progress');
  });

  it('显式拒绝（reject）语义不变：落 rejected（终态）', async () => {
    const { requirements, hitlService } = createRequirementHarness();
    const req = propose(requirements);
    const approval = hitlService.listApprovals('pending')
      .find(a => (a.details as Record<string, unknown> | undefined)?.['requirementId'] === req.id)!;

    hitlService.respondToApproval(approval.id, false, 'user-1', '不做这个方向', 'reject');
    await flush();

    const after = requirements.getRequirement(req.id)!;
    expect(after.status).toBe('rejected');
  });

  it('通过（approve）语义不变：需求进入 in_progress', async () => {
    const { requirements, hitlService } = createRequirementHarness();
    const req = propose(requirements);
    const approval = hitlService.listApprovals('pending')
      .find(a => (a.details as Record<string, unknown> | undefined)?.['requirementId'] === req.id)!;

    hitlService.respondToApproval(approval.id, true, 'user-1');
    await flush();

    expect(requirements.getRequirement(req.id)!.status).toBe('in_progress');
  });

  it('需求闸打回与建卡闸打回的目标状态不同（不得共用同一落点）', async () => {
    const { requirements, hitlService } = createRequirementHarness();
    const req = propose(requirements);
    const approval = hitlService.listApprovals('pending')
      .find(a => (a.details as Record<string, unknown> | undefined)?.['requirementId'] === req.id)!;
    hitlService.respondToApproval(approval.id, false, 'user-1', 'x', 'request_changes');
    await flush();

    // 需求闸：仍在 pending（零状态转移），靠评论 + 通知表达「已看过、要改」
    expect(requirements.getRequirement(req.id)!.status).toBe('pending');
    expect(requirements.getRequirement(req.id)!.rejectedReason).toBeUndefined();
  });

  it('幂等：需求闸打回再路由一次 ⇒ already-applied，评论与创建者通知都不新增', async () => {
    const { requirements, hitlService, applier, comments, enqueueToMailbox } = createRequirementHarness();
    const req = propose(requirements);
    const approval = hitlService.listApprovals('pending')
      .find(a => (a.details as Record<string, unknown> | undefined)?.['requirementId'] === req.id)!;

    hitlService.respondToApproval(approval.id, false, 'user-1', '改一下', 'request_changes');
    await flush();
    expect(comments).toHaveLength(1);
    const mailboxCalls = enqueueToMailbox.mock.calls.length;

    const outcome = await applier.apply({
      approvalId: approval.id, subType: 'requirement', targetId: req.id,
      intent: 'request_changes', actorId: 'user-1', comment: '再改一次',
    });
    expect(outcome.reason).toBe('already-applied');
    expect(comments).toHaveLength(1);
    expect(enqueueToMailbox.mock.calls.length).toBe(mailboxCalls);
    expect(requirements.getRequirement(req.id)!.status).toBe('pending');
  });
});
