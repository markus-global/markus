/**
 * 需求级批量批准：**逐条走唯一写者 `approveTask`**，不做第二条审批路径。
 *
 * 这组用例钉住四件事（对应 Owner 2026-10-28 的需求）：
 *   1. 预检（dryRun）只报告、零副作用 —— 弹窗里的数字必须是真的；
 *   2. 真实调用把待批任务逐条批掉（批准即开始执行）；
 *   3. 重复调用幂等：全走"跳过 + 原因"，不报错、不重复批；
 *   4. 不满足条件的（不存在 / 非 pending）**跳过并给原因**，绝不 force。
 */
import { describe, it, expect, vi } from 'vitest';
import { TaskService } from '../src/task-service.js';

function makeService(extraTaskIds: string[] = []) {
  const ts = new TaskService();
  ts.setAgentManager({ hasAgent: () => true } as never);
  ts.setWSBroadcaster({
    broadcast: vi.fn(),
    broadcastTaskCreate: vi.fn(),
    broadcastTaskUpdate: vi.fn(),
  } as never);
  ts.setGovernancePolicy({ requireRequirement: false } as never);
  // 设了 HITL + creatorRole='worker' 才会走"建卡待批"闸门 → 任务落 pending。
  // 不设的话任务出生即自动执行，批量批准就无从测试（这也是真实链路的行为）。
  ts.setHITLService({
    listApprovals: () => [],
    notify: vi.fn(),
    respondToApproval: vi.fn(),
    requestApproval: vi.fn(() => ({ id: 'apr-1' })),
    // 建卡闸会调用它把任务挂起（返回即视为"已发起审批"）
    requestApprovalAndWait: vi.fn(async () => ({ id: 'apr-1', status: 'pending' })),
  } as never);

  const tasks = [1, 2, 3].map((n) =>
    ts.createTask({
      orgId: 'default',
      title: `Task ${n}`,
      description: `d${n}`,
      assignedAgentId: 'agent-a',
      reviewerId: 'agent-b',
      requirementId: 'req-1',
      creatorRole: 'worker',
    }),
  );

  const taskIds = [...tasks.map((t) => t.id), ...extraTaskIds];
  ts.setRequirementService({
    getRequirement: (id: string) =>
      id === 'req-1'
        ? { id, orgId: 'default', title: 'R', description: '', status: 'in_progress', taskIds }
        : null,
    linkTask: vi.fn(),
  } as never);

  return { ts, tasks, taskIds };
}

describe('approveRequirementTasks', () => {
  it('dryRun reports what would happen and changes nothing', () => {
    const { ts, tasks } = makeService();

    const preview = ts.approveRequirementTasks('req-1', { dryRun: true });

    expect(preview.approved.map((a) => a.id).sort()).toEqual(tasks.map((t) => t.id).sort());
    expect(preview.skipped).toEqual([]);
    expect(preview.failed).toEqual([]);
    // 零副作用
    for (const task of tasks) {
      expect(ts.getTask(task.id)?.status).toBe('pending');
    }
  });

  it('approves every pending task (approval starts execution)', () => {
    const { ts, tasks } = makeService();

    const result = ts.approveRequirementTasks('req-1', { runNow: true });

    expect(result.approved).toHaveLength(3);
    expect(result.failed).toEqual([]);
    for (const task of tasks) {
      expect(ts.getTask(task.id)?.status).toBe('in_progress');
      expect(ts.getTask(task.id)?.approvedVia).toBe('human');
    }
  });

  it('is idempotent: a second call skips everything, with reasons', () => {
    const { ts } = makeService();
    ts.approveRequirementTasks('req-1', { runNow: true });

    const second = ts.approveRequirementTasks('req-1', { runNow: true });

    expect(second.approved).toEqual([]);
    expect(second.failed).toEqual([]);
    expect(second.skipped).toHaveLength(3);
    for (const skipped of second.skipped) {
      expect(skipped.reason).toMatch(/status is/);
    }
  });

  it('skips ids that no longer exist instead of failing the batch', () => {
    const { ts } = makeService(['tsk_missing']);

    const result = ts.approveRequirementTasks('req-1', { runNow: true });

    expect(result.approved).toHaveLength(3);
    expect(result.skipped).toEqual([
      expect.objectContaining({ id: 'tsk_missing', reason: 'task not found' }),
    ]);
  });

  it('throws for an unknown requirement (no silent no-op)', () => {
    const { ts } = makeService();
    expect(() => ts.approveRequirementTasks('req-nope')).toThrow(/Requirement not found/);
  });
});
