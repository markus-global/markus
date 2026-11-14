/**
 * C8-B 判据②（真机可达性）—— 「矛盾事实当轮 cancel」的**生产者**必须存在。
 *
 * 背景（2026-11-14 实测）：消费端 `turn-delta.ts#classifyTurnDelta` 早就把
 * `invalidatesPremise === true` 判为 `contradiction` → `decision: 'cancel'`，
 * 但全仓 `invalidatesPremise` 的写者**只有测试**——生产里没有任何一处会置 true。
 * 也就是说那条「回合被取消时不再烧 token」的路径，在真实系统里结构上不可达。
 *
 * 本测试钉住唯一的自然生产者：任务进入终态/被取消时，投给执行方的
 * `task_status_update` 必须带 `invalidatesPremise: true`；而「打回重做」
 * （rejected）与「已提交待审」（review）**不得**带——前提仍然成立。
 *
 * 断言写在**行为**上（投递选项），不是源码文本：把 task-service 里那行
 * `...(PREMISE_INVALIDATING.has(to) ? { invalidatesPremise: true } : {})` 删掉，
 * 本文件立即变红。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskService } from '../src/task-service.js';
import type { Task, TaskStatus } from '../src/types.js';

interface Captured {
  sourceType: string;
  payload: { taskId?: string };
  options: { metadata?: { taskId?: string }; invalidatesPremise?: boolean } | undefined;
}

function makeService(): { svc: TaskService; calls: Captured[] } {
  const calls: Captured[] = [];
  const svc = new TaskService();
  // 只替换「与本次判定无关的外围依赖」：一个记录投递的信箱端口。
  (svc as unknown as { setAgentManager: (am: unknown) => void }).setAgentManager({
    getAgent: (id: string) =>
      id === 'agt_worker'
        ? {
            enqueueToMailbox: (sourceType: string, payload: never, options: never) => {
              calls.push({ sourceType, payload, options } as Captured);
              return { id: 'mbx_test' };
            },
          }
        : undefined,
  } as never);
  return { svc, calls };
}

function task(status: TaskStatus = 'in_progress'): Task {
  return {
    id: 'tsk_premise',
    title: '探针任务',
    description: '',
    status,
    priority: 'medium',
    orgId: 'org_1',
    assignedAgentId: 'agt_worker',
    createdBy: 'agt_boss',
    createdAt: '2026-11-14T00:00:00.000Z',
    updatedAt: '2026-11-14T00:00:00.000Z',
  } as unknown as Task;
}

/** 驱动生产代码里那个唯一投递点（私有方法即单一执行点）。 */
function notify(svc: TaskService, from: TaskStatus, to: TaskStatus): void {
  (svc as unknown as {
    maybeNotifyAssignee: (t: Task, f: TaskStatus, to: TaskStatus, exec: boolean, by?: string) => void;
  }).maybeNotifyAssignee(task(from), from, to, false, 'agt_boss');
}

describe('C8-B ②：任务被终止时，在跑的回合必须收到「前提已失效」', () => {
  let svc: TaskService;
  let calls: Captured[];

  beforeEach(() => {
    const made = makeService();
    svc = made.svc;
    calls = made.calls;
  });

  it.each<TaskStatus>(['cancelled', 'failed', 'completed', 'archived'])(
    '%s → 投递带 invalidatesPremise（消费端才会 cancel）',
    to => {
      notify(svc, 'in_progress', to);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.sourceType).toBe('task_status_update');
      expect(calls[0]!.options?.invalidatesPremise).toBe(true);
      expect(calls[0]!.options?.metadata?.taskId).toBe('tsk_premise');
    },
  );

  it('rejected（打回重做）→ 不带：前提仍然成立', () => {
    notify(svc, 'review', 'rejected');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options?.invalidatesPremise).toBeUndefined();
  });

  it('blocked（等待依赖）→ 不带：只是暂时停摆，不是前提没了', () => {
    notify(svc, 'pending', 'blocked');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options?.invalidatesPremise).toBeUndefined();
  });

  it('暂停后恢复 → 不带', () => {
    notify(svc, 'review', 'in_progress');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options?.invalidatesPremise).toBeUndefined();
  });

  it('自己提交评审 → 根本不投递（assignee 自己知道）', () => {
    notify(svc, 'in_progress', 'review');
    expect(calls).toHaveLength(0);
  });

  it('不因为「顺带修」把空投递也带上标志：无投递 = 无标志', () => {
    // executionTriggered=true 时 runTask 自己发执行项，本方法必须静默
    (svc as unknown as {
      maybeNotifyAssignee: (t: Task, f: TaskStatus, to: TaskStatus, exec: boolean) => void;
    }).maybeNotifyAssignee(task('in_progress'), 'in_progress', 'cancelled', true);
    expect(calls).toHaveLength(0);
  });
});
