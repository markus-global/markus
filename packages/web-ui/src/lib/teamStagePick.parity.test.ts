/**
 * Team 页「agent 角标取哪一条流」——**必须与唯一排序器同序**。
 *
 * 为什么单独钉这一处：它是本轮最后被发现的第二写者，形态最隐蔽 —— 不是 `.sort()`，
 * 而是 `for` 循环里手写的偏序（「stageRank 更小者胜，相等则 lastActivity 更大者胜」，
 * 逐字形态见 `scripts/architecture-guard.mjs` 的 `Team.tsx` 违规样本）。
 * 它既不会被「禁止定义排序函数」的规则命中，也与契约**方向相反**：
 *
 *   契约第 3 段键（`orderTodos`）＝ 同 stage 同优先级内**等得久的在前**；
 *   角标旧实现             ＝ 同 stage 内**最新的在前**。
 *
 * 两句话都自称「挑最该处理的一条」，在两条同 stage 的流之间给出**相反**的答案。
 * 这不是口味问题：用户在 Team 页看到角标指向 A，在概览首屏看到 B 排第一。
 *
 * 判据（本文件）：角标选中的 id === `orderTodos(mine)[0].id`。
 * **这条断言在旧实现下是红的**（旧实现选新的），这就是它该咬的地方。
 */
import { describe, it, expect } from 'vitest';
import { pickAgentStageThread } from './actionItems.ts';
import { orderTodos } from './todoOrder.ts';
import type { ThreadAPI } from '../api.ts';

const T = 1_700_000_000_000;
const MIN = 60_000;

function thread(
  id: string,
  ownerAgent: string | null,
  stage: string,
  lastActivity: number,
  priority: string | null = null,
): ThreadAPI {
  return {
    id,
    ref: id,
    ownerAgent,
    ownerSession: null,
    lastActivity,
    stage,
    stageRank: 0,
    stageBasis: 'partial',
    missingFacts: [],
    taskStatus: null,
    title: id,
    detail: null,
    priority,
  };
}

describe('Team 页角标「取最佳一条」与 orderTodos 同序', () => {
  it('两条同 stage：等得久的胜出（契约第 3 段键），且等于 orderTodos(mine)[0].id', () => {
    const older = thread('tsk_older', 'agt_a', 'person:blocked', T - 300 * MIN);
    const newer = thread('tsk_newer', 'agt_a', 'person:blocked', T - 1 * MIN);
    const mine = [newer, older]; // 故意把「新的」放在前面：旧实现顺抹就选中它

    const picked = pickAgentStageThread(mine, 'agt_a');
    expect(picked?.id).toBe(orderTodos(mine)[0]!.id);
    expect(picked?.id).toBe('tsk_older');
  });

  it('stage 序压过等待时长：老的审批压过新的阻塞', () => {
    const oldApproval = thread('tsk_approval', 'agt_a', 'person:approval', T - 900 * MIN);
    const newBlocked = thread('tsk_blocked', 'agt_a', 'person:blocked', T - 1 * MIN);
    const mine = [newBlocked, oldApproval];
    expect(pickAgentStageThread(mine, 'agt_a')?.id).toBe('tsk_approval');
    expect(pickAgentStageThread(mine, 'agt_a')?.id).toBe(orderTodos(mine)[0]!.id);
  });

  it('同 stage 内优先级生效：urgent 压过 high（第 2 段键）', () => {
    const high = thread('tsk_high', 'agt_a', 'person:review', T - 500 * MIN, 'high');
    const urgent = thread('tsk_urgent', 'agt_a', 'person:review', T - 1 * MIN, 'urgent');
    const mine = [high, urgent];
    expect(pickAgentStageThread(mine, 'agt_a')?.id).toBe('tsk_urgent');
    expect(pickAgentStageThread(mine, 'agt_a')?.id).toBe(orderTodos(mine)[0]!.id);
  });

  it('只看该 agent 名下的流；没有则 null（不只按顺序取第一条）', () => {
    const other = thread('tsk_other', 'agt_b', 'person:approval', T - 900 * MIN);
    const mineOne = thread('tsk_mine', 'agt_a', 'none:idle', T - 1 * MIN);
    expect(pickAgentStageThread([other, mineOne], 'agt_a')?.id).toBe('tsk_mine');
    expect(pickAgentStageThread([other], 'agt_a')).toBeNull();
    expect(pickAgentStageThread([], 'agt_a')).toBeNull();
  });

  it('确定性：输入顺序不同，选中的是同一条', () => {
    const a = thread('tsk_a', 'agt_a', 'person:blocked', T - 10 * MIN);
    const b = thread('tsk_b', 'agt_a', 'person:blocked', T - 10 * MIN);
    expect(pickAgentStageThread([a, b], 'agt_a')?.id).toBe(pickAgentStageThread([b, a], 'agt_a')?.id);
  });
});
