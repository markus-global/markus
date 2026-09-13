import { describe, it, expect, vi } from 'vitest';
import { TaskService } from '../src/task-service.js';

/**
 * T2 · 派发侧实体独占（task 级单飞 · 修订轮 settle 语义）回归测试
 *
 * 验收口径来源：T1 §8.6 三条**观测层**定义（卡面【验收标准】）。核心差异：观测对象是
 * **重叠 / 峰值并发**，不是「累计会话创建数」（合法 cancel-then-start 顺序重派发天然
 * 创建 2 个会话，累计计数必然误杀断言 1）。
 *
 * 断言 1：per `task_id` **峰值并发活跃执行会话数 == 1** 且**总执行数 == 1**（N 并发重复派发）。
 * 断言 2：**峰值并发 == 1（含旧执行 drain 期，无重叠窗口）** + 挂起重派发在旧执行
 *         **实际 settle 后**被 re-arm 触发并最终完成。
 * coalesce：N 笔 pending → 执行数**有界且 ≥1**（不得 N 笔变 N 次串行执行）。
 *
 * 观测源：
 * - 并发窗口 = 执行会话 enter/exit 的实际时点（`sendTaskExecution` 调用边界，测试侧独立计数）；
 * - settle = **`task-service.ts` 内 settle CAS 事件**（WS `task:execution:settled`），
 *   每个执行纪元**恰一次**；**不取自** `attention.ts`，**不以「token 被删」当 settle**。
 *
 * 未修复基线（`6b5e32c0`）上，重复/重派发会再次调用 `sendTaskExecution` →
 * 同一 task 被两个会话并发执行 → 本文件按「并发执行计数 > 1」正确原因失败。
 */

const AGENT_A = 'agent-a';
const REVIEWER = 'reviewer-1';
const ORG = 'org-1';

type LogEntry = { type: string; content: string; persist?: boolean; metadata?: Record<string, unknown> };

/** 执行会话并发窗口观测器（独立计数器①：per task 峰值并发 + 总执行数）。 */
function makeSessionTracker() {
  return {
    seq: 0,
    activeByTask: new Map<string, number>(),
    peakByTask: new Map<string, number>(),
    totalByTask: new Map<string, number>(),
    /** 重叠窗口证据：同一 task 在上一会话未退出前进入了新会话 */
    overlaps: [] as string[],
    windows: [] as { taskId: string; startSeq: number; endSeq: number }[],
  };
}
type SessionTracker = ReturnType<typeof makeSessionTracker>;

function beginSession(t: SessionTracker, taskId: string) {
  const active = (t.activeByTask.get(taskId) ?? 0) + 1;
  if (active > 1) t.overlaps.push(`${taskId}#${active}`);
  t.activeByTask.set(taskId, active);
  t.peakByTask.set(taskId, Math.max(t.peakByTask.get(taskId) ?? 0, active));
  t.totalByTask.set(taskId, (t.totalByTask.get(taskId) ?? 0) + 1);
  t.seq += 1;
  const window = { taskId, startSeq: t.seq, endSeq: -1 };
  t.windows.push(window);
  return window;
}

function endSession(t: SessionTracker, w: { taskId: string; startSeq: number; endSeq: number }) {
  t.activeByTask.set(w.taskId, Math.max(0, (t.activeByTask.get(w.taskId) ?? 1) - 1));
  t.seq += 1;
  w.endSeq = t.seq;
}

function makeAgentManager(tracker: SessionTracker, onSession?: (taskId: string) => Promise<void>) {
  const makeAgent = (id: string) => ({
    config: { name: id, orgId: ORG, agentRole: id === REVIEWER ? 'manager' : 'worker' },
    enqueueToMailbox: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    injectUserMessage: vi.fn(),
    sendSessionReply: vi.fn().mockResolvedValue('ok'),
    dropStaleStatusUpdates: vi.fn(),
    getState: vi.fn(() => ({ status: 'busy', activeTaskCount: 1 })),
    sendTaskExecution: vi.fn(async (taskId: string, _desc: string, logFn: (e: LogEntry) => Promise<void>) => {
      const window = beginSession(tracker, taskId);
      try {
        await logFn({ type: 'status', content: 'started', persist: true });
        if (onSession) await onSession(taskId);
      } finally {
        endSession(tracker, window);
      }
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

function makeService(tracker: SessionTracker, onSession?: (taskId: string) => Promise<void>) {
  const agentManager = makeAgentManager(tracker, onSession);
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

/** 取 WS 广播中指定类型事件的 payload 列表（settle / deferred / rearmed 观测源）。 */
function events(ws: { broadcast: ReturnType<typeof vi.fn> }, type: string): Record<string, unknown>[] {
  return ws.broadcast.mock.calls
    .map(call => call[0] as { type?: string; payload?: Record<string, unknown> })
    .filter(e => e?.type === type)
    .map(e => e.payload as Record<string, unknown>);
}

function createStartedTask(svc: TaskService) {
  return svc.createTask({
    orgId: ORG,
    title: 'Task',
    description: 'Do something',
    assignedAgentId: AGENT_A,
    reviewerId: REVIEWER,
    creatorRole: 'human',
  } as never);
}

describe('TaskService T2 · 派发侧实体独占（task 级单飞 · 修订轮 settle 语义）', () => {
  it('断言1｜N 并发重复派发同一 task：per task_id 峰值并发 == 1 且 总执行数 == 1', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tracker = makeSessionTracker();
    const { svc, agentManager, ws } = makeService(tracker, async () => { await gate; });

    const task = createStartedTask(svc);
    svc.approveTask(task.id, 'user-1'); // auto-start（setImmediate → runTask intent=auto-start）
    await flush(10);

    // 独立计数器①：首个执行会话已进入且仍在飞
    expect(tracker.totalByTask.get(task.id)).toBe(1);
    expect(tracker.activeByTask.get(task.id)).toBe(1);

    // N 并发分身 / 重复派发（非调度意图 dispatch）
    await Promise.all([
      svc.runTask(task.id),
      svc.runTask(task.id),
      svc.runTask(task.id),
      svc.runTask(task.id),
    ]);

    // 峰值并发 == 1、总执行数 == 1、无重叠窗口
    expect(tracker.peakByTask.get(task.id)).toBe(1);
    expect(tracker.totalByTask.get(task.id)).toBe(1);
    expect(tracker.overlaps).toEqual([]);
    expect(agentManager.getAgent(AGENT_A).sendTaskExecution).toHaveBeenCalledTimes(1);

    // 可观测留痕：4 次均被拒绝（谁/何时/原会话）
    const rejected = events(ws, 'task:dispatch:duplicate-rejected');
    expect(rejected).toHaveLength(4);
    expect(rejected[0]).toMatchObject({
      taskId: task.id,
      agentId: AGENT_A,
      existingSessionId: `task_${task.id}_r1`,
    });
    // 非调度意图**不得**进入 deferred queue（拒绝而非挂起）
    expect(events(ws, 'task:dispatch:deferred')).toHaveLength(0);

    release();
    await flush(30);
  });

  it('断言2｜合法重派发在旧执行在飞/收口期被延后重放：峰值并发 == 1（无重叠窗口）+ 实际 settle 后 re-arm 完成', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tracker = makeSessionTracker();
    let session = 0;
    const { svc, agentManager, ws } = makeService(tracker, async () => {
      session += 1;
      if (session === 1) await gate; // 首个执行保持在飞（制造「旧执行未收口」窗口）
    });

    const task = createStartedTask(svc);
    svc.approveTask(task.id, 'user-1');
    await flush(10);
    expect(tracker.totalByTask.get(task.id)).toBe(1);

    // 旧执行**在飞期间**发起合法调度意图重派发（§8.4 #4 抢占重排语义）
    await svc.runTask(task.id, 0, undefined, 'preempted');

    // 延后重放：既不并发启动（峰值并发仍为 1），也不被拒绝丢弃（无工作丢失）
    expect(tracker.peakByTask.get(task.id)).toBe(1);
    expect(tracker.totalByTask.get(task.id)).toBe(1);
    expect(tracker.overlaps).toEqual([]);
    expect(events(ws, 'task:dispatch:deferred')).toHaveLength(1);
    expect(events(ws, 'task:dispatch:duplicate-rejected')).toHaveLength(0);
    // 旧执行尚未 settle → 不得 re-arm（re-arm 早于 settle = 「旧未停先起新」= 复刻本卡缺陷）
    expect(events(ws, 'task:dispatch:rearmed')).toHaveLength(0);
    expect(events(ws, 'task:execution:settled')).toHaveLength(0);

    // 旧执行**实际收口** → settle CAS → re-arm → 重派发最终完成
    release();
    await flush(50);

    // 独立计数器②：settle CAS 事件（观测源唯一 = task-service.ts），每执行纪元恰一次
    const settled = events(ws, 'task:execution:settled');
    expect(settled).toHaveLength(2);
    expect(settled.every(p => p.source === 'finally')).toBe(true);
    expect(events(ws, 'task:dispatch:rearmed')).toHaveLength(1);

    expect(tracker.totalByTask.get(task.id)).toBe(2); // 总执行数 == 2（顺序重派发，非并发）
    expect(tracker.peakByTask.get(task.id)).toBe(1); // 峰值并发 == 1（含旧执行 drain 期）
    expect(tracker.overlaps).toEqual([]);
    // 无重叠窗口的直接证据：第 2 个会话在**第 1 个会话退出之后**才进入
    expect(tracker.windows).toHaveLength(2);
    expect(tracker.windows[1].startSeq).toBeGreaterThan(tracker.windows[0].endSeq);
    expect(agentManager.getAgent(AGENT_A).sendTaskExecution).toHaveBeenCalledTimes(2);
  });

  it('coalesce｜N 笔 pending 合并为 1 次执行（有界且 ≥1，独立计数器③）', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tracker = makeSessionTracker();
    let session = 0;
    const { svc, ws } = makeService(tracker, async () => {
      session += 1;
      if (session === 1) await gate;
    });

    const task = createStartedTask(svc);
    svc.approveTask(task.id, 'user-1');
    await flush(10);

    // 旧执行在飞期间连发 3 笔**不同**的调度意图重派发
    await svc.runTask(task.id, 0, undefined, 'preempted');
    await svc.runTask(task.id, 0, undefined, 'retry');
    await svc.runTask(task.id, 1, 'no_submit', 'no_submit');

    // N→1（run-once，latest-wins）：仅 1 条 pending，其余 2 笔被合并
    expect(events(ws, 'task:dispatch:deferred')).toHaveLength(1);
    const coalesced = events(ws, 'task:dispatch:deferred-coalesced');
    expect(coalesced).toHaveLength(2);
    expect(coalesced[coalesced.length - 1].coalescedCount).toBe(3);

    release();
    await flush(50);

    // 执行数**有界且 ≥1**：首执行 + 1 次合并重派发 = 2（不得 3 笔 pending 变 3 次串行执行）
    expect(events(ws, 'task:dispatch:rearmed')).toHaveLength(1);
    expect(tracker.totalByTask.get(task.id)).toBe(2);
    expect(tracker.peakByTask.get(task.id)).toBe(1);
    expect(tracker.overlaps).toEqual([]);
  });

  it('retryTaskFresh｜terminate-then-start：不旁路单飞闸，旧执行 settle 后才起新会话（执行身份轮次化）', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tracker = makeSessionTracker();
    let session = 0;
    const { svc, ws } = makeService(tracker, async () => {
      session += 1;
      if (session === 1) await gate;
    });

    const task = createStartedTask(svc);
    svc.approveTask(task.id, 'user-1');
    await flush(10);
    expect(tracker.totalByTask.get(task.id)).toBe(1);

    // 旧执行在飞 → fresh 重试必须 terminate-then-start（旧实现此处旁路闸、立即起第二会话）
    await svc.retryTaskFresh(task.id);
    await flush(15);
    expect(tracker.totalByTask.get(task.id)).toBe(1);
    expect(tracker.peakByTask.get(task.id)).toBe(1);
    expect(events(ws, 'task:dispatch:deferred')).toHaveLength(1);

    release();
    await flush(50);

    expect(tracker.totalByTask.get(task.id)).toBe(2);
    expect(tracker.peakByTask.get(task.id)).toBe(1);
    expect(tracker.overlaps).toEqual([]);
    expect(tracker.windows[1].startSeq).toBeGreaterThan(tracker.windows[0].endSeq);

    // 执行身份按 round 递增 → 两个纪元的 settle 事件身份互异、各恰一次
    const settled = events(ws, 'task:execution:settled');
    expect(settled).toHaveLength(2);
    expect(new Set(settled.map(p => p.sessionId)).size).toBe(2);
    expect(settled.map(p => p.sessionId)).toContain(`task_${task.id}_r1`);
    expect(settled.map(p => p.sessionId)).toContain(`task_${task.id}_r2`);
  });

  it('不同 task 各自单飞、互不影响', async () => {
    const tracker = makeSessionTracker();
    const { svc, agentManager } = makeService(tracker);

    const t1 = createStartedTask(svc);
    const t2 = createStartedTask(svc);
    svc.approveTask(t1.id, 'user-1');
    svc.approveTask(t2.id, 'user-1');
    await flush(20);

    const agent = agentManager.getAgent(AGENT_A);
    expect(agent.sendTaskExecution).toHaveBeenCalledTimes(2);
    expect(tracker.totalByTask.get(t1.id)).toBe(1);
    expect(tracker.totalByTask.get(t2.id)).toBe(1);
    expect(tracker.peakByTask.get(t1.id)).toBe(1);
    expect(tracker.peakByTask.get(t2.id)).toBe(1);
  });

  it('不误伤：执行进入终态（已 settle）后，合法重派必须放行', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tracker = makeSessionTracker();
    let session = 0;
    const { svc, agentManager, ws } = makeService(tracker, async () => {
      session += 1;
      if (session === 1) await gate;
    });

    const task = createStartedTask(svc);
    svc.approveTask(task.id, 'user-1');
    await flush(10);
    expect(agentManager.getAgent(AGENT_A).sendTaskExecution).toHaveBeenCalledTimes(1);

    // 终态前：非调度意图重复派发被拒绝
    await svc.runTask(task.id);
    expect(events(ws, 'task:dispatch:duplicate-rejected')).toHaveLength(1);

    // 实际收口（settle）后：合法重派放行（不误伤抢占/重试/定时重跑）
    release();
    await flush(30);
    expect(events(ws, 'task:execution:settled')).toHaveLength(1);

    await svc.runTask(task.id);
    await flush(20);
    expect(agentManager.getAgent(AGENT_A).sendTaskExecution).toHaveBeenCalledTimes(2);
    expect(tracker.peakByTask.get(task.id)).toBe(1);
    expect(tracker.overlaps).toEqual([]);
  });
});
