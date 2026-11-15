/**
 * C9-B — 「在跑」只有一个权威来源：`work_units`。
 *
 * 这个文件存在的理由是一个被打回过一次的缺陷（C8-E）：页面用
 * 「activity 没有 `ended_at`」推断「还在跑」。worker 被杀后那条 activity 永远不会补
 * `ended_at`，于是僵尸行在 UI 上一直显示「在跑」。
 *
 * 因此这里断言的不是「函数返回 true/false」这种细节，而是**判据本身**：
 *   · 未结束的 activity 若没有 WorkUnit 身份 → 不是在跑（僵尸场景）；
 *   · activity 的 WorkUnit 不在 running 集合里 → 不是在跑（已收口）；
 *   · 只有「该行带着 workUnitRef，且该 ref 出现在 work_units 的 running 集合里」→ 在跑。
 *
 * 关键设计：`isActivityLive` **根本不接受 `endedAt`**。让它读不到这个字段，
 * 就没有人能再把它当状态用——这比写一条注释要求大家别用更可靠。
 */
import { describe, it, expect } from 'vitest';
import { isActivityLive, liveRefSet, taskIsLive } from './workUnitLiveness.ts';

describe('C9-B 僵尸 activity 不得算在跑（行为判据）', () => {
  it('worker 被杀后 activity 没有 ended_at、也没有 WorkUnit 身份 → 不显示在跑', () => {
    // 真实形态：insertActivity 成功，回合收口前进程被杀 → ended_at 永远为 NULL。
    const zombie = { id: 'act-zombie', workUnitRef: null };
    expect(isActivityLive(zombie, liveRefSet([]))).toBe(false);
    // 即使同期有别的工作单元在跑，也不许把它算进去（身份不同）。
    expect(isActivityLive(zombie, liveRefSet([{ ref: 'session:sess_1:r1' }]))).toBe(false);
  });

  it('activity 的 WorkUnit 已不在 running 集合 → 不显示在跑（收口后立即消失）', () => {
    const finished = { id: 'act-1', workUnitRef: 'task_tsk_abc_r2' };
    expect(isActivityLive(finished, liveRefSet([]))).toBe(false);
  });

  it('activity 的 WorkUnit 在 running 集合 → 在跑（与是否写过 ended_at 无关）', () => {
    const running = { id: 'act-2', workUnitRef: 'task_tsk_abc_r2' };
    const live = liveRefSet([{ ref: 'task_tsk_abc_r2' }]);
    expect(isActivityLive(running, live)).toBe(true);
  });
});

describe('C9-B 任务级「在跑」也只认 work_units', () => {
  const units = [
    { ref: 'task_tsk_abc_r2', taskId: 'tsk_abc' },
    { ref: 'session:sess_1:r1', taskId: undefined },
  ];

  it('该任务自己的 WorkUnit 在 running → 在跑', () => {
    expect(taskIsLive(units, 'tsk_abc')).toBe(true);
  });

  it('别的任务 / 聊天回合在跑，不能把这张卡算成在跑', () => {
    expect(taskIsLive(units, 'tsk_other')).toBe(false);
  });

  it('没有任何 running 单元 → 不在跑', () => {
    expect(taskIsLive([], 'tsk_abc')).toBe(false);
  });
});
