import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TaskService } from '../src/task-service.js';

/**
 * 重启恢复：一个任务只能有一个执行者。
 *
 * 事故（2026-11-05 实测）：重启后库里仍有 11 条 `processing` + 45 条 `queued` 的
 * mailbox 条目，而 `resumeInProgressTasks()` **无条件**对每个 `in_progress` 任务调用
 * `runTask(..., 'resume')` —— 于是同一步可能既被在途条目执行，又被 resume 拉起，
 * 相当于两个执行者同时拥有同一个任务。
 *
 * 同一份代码还有第二个缺陷：resume 抛错就把任务判 `failed`，等于把一次重启抖动
 * 变成永久死刑（重启期失败不是「不可恢复」的证据）。
 *
 * 这里钉住三条：
 *   1. 已有在途条目 → 跳过 resume（执行权归条目）；
 *   2. 无人拥执行 → 正常 resume；
 *   3. resume 抛错 → 状态保持 in_progress，不得判 failed。
 */

function agentManagerWith(live: (taskId: string) => boolean) {
  return {
    hasAgent: () => true,
    getAgent: () => ({ hasLiveItemsForTask: (taskId: string) => live(taskId) }),
  };
}

/** Let pending setImmediate callbacks (auto-start) drain before asserting. */
const drain = () => new Promise(resolve => setImmediate(resolve));

describe('restart resume — one execution owner per task', () => {
  let ts: TaskService;

  beforeEach(() => {
    ts = new TaskService();
    ts.setGovernancePolicy({
      enabled: false,
      defaultTier: 'auto',
      maxPendingTasksPerAgent: 100,
      maxTotalActiveTasks: 100,
      requireApprovalForPriority: [],
      requireRequirement: false,
      rules: [],
    });
  });

  afterEach(() => {
    ts.stopTimeoutChecker();
  });

  async function inProgressTask() {
    const created = ts.createTask({
      orgId: 'org-1',
      title: 'Work',
      description: '',
      assignedAgentId: 'agent-a',
      reviewerId: 'reviewer-1',
      creatorRole: 'agent',
    } as never);
    // governance 关闭时 agent 创建的任务会直接进入 in_progress；只有仍停在
    // pending 时才需要 approve（否则 approveTask 会以「已 in_progress」拒绝）。
    const task = ts.getTask(created.id)!.status === 'pending'
      ? ts.approveTask(created.id, 'user-1')
      : ts.getTask(created.id)!;
    await drain(); // approve 的 auto-start 走 setImmediate，先放它跑完再计数
    return task;
  }

  it('skips a task whose execution is already owned by a live mailbox item', async () => {
    ts.setAgentManager(agentManagerWith(() => true) as never);
    const spy = vi.spyOn(ts, 'runTask').mockResolvedValue(undefined as never);
    const task = await inProgressTask();
    spy.mockClear();

    await ts.resumeInProgressTasks();

    expect(spy).not.toHaveBeenCalled();
    expect(ts.getTask(task.id)!.status).toBe('in_progress');
  });

  it('resumes when nothing owns the execution', async () => {
    ts.setAgentManager(agentManagerWith(() => false) as never);
    const spy = vi.spyOn(ts, 'runTask').mockResolvedValue(undefined as never);
    const task = await inProgressTask();
    spy.mockClear();

    await ts.resumeInProgressTasks();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe(task.id);
    expect(spy.mock.calls[0][3]).toBe('resume');
  });

  it('keeps the task in_progress when resume throws (no permanent failed judgement)', async () => {
    ts.setAgentManager(agentManagerWith(() => false) as never);
    const spy = vi.spyOn(ts, 'runTask').mockResolvedValue(undefined as never);
    const task = await inProgressTask();
    spy.mockRejectedValue(new Error('startup race'));

    await ts.resumeInProgressTasks();

    expect(ts.getTask(task.id)!.status).toBe('in_progress');
    expect(ts.getTask(task.id)!.status).not.toBe('failed');
  });
});
