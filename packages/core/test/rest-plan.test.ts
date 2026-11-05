import { describe, it, expect } from 'vitest';
import {
  REST_DEFAULT_FALLBACK_MS,
  REST_HARD_MAX_MS,
  REST_MAX_STREAK,
  planRest,
} from '../src/rest-plan.js';

/**
 * rest 的边界判定全在这里。为什么要这么细：
 * 这些分支错了不会报错，只会让 agent **静默挂起**——
 * 不响、不报、人看不到。所以每一条边界都得有断言守着。
 */

describe('planRest — 空/非法输入', () => {
  it('wake_on 缺失 → error，且提示改用 schedule_wakeup', () => {
    const r = planRest(undefined, 0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe('error');
    // 提示必须指向正确工具，否则 agent 会反复试同一个错
    expect(r.message).toContain('schedule_wakeup');
  });

  it('空数组 → error（空等待 = 永远不醒）', () => {
    const r = planRest([], 0);
    expect(r.ok).toBe(false);
  });

  it('非数组 → error', () => {
    expect(planRest('trigger', 0).ok).toBe(false);
  });
});

describe('planRest — 条件解析', () => {
  it('trigger 不指定 threadRef 合法（意为任何流）', () => {
    const r = planRest([{ kind: 'trigger' }], 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.conditions).toEqual([{ kind: 'trigger' }]);
  });

  it('trigger 指定 threadRef → 带上', () => {
    const r = planRest([{ kind: 'trigger', thread_ref: 'gh:o/r#1' }], 0);
    if (!r.ok) throw new Error('expected ok');
    expect(r.plan.conditions).toEqual([{ kind: 'trigger', threadRef: 'gh:o/r#1' }]);
  });

  it('stage 缺字段 → 进 ignored 且不产生条件', () => {
    const r = planRest([{ kind: 'stage', thread_ref: 'x' }], 0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.ignored?.join()).toContain('stage');
  });

  it('dependency 缺 task_id → ignored', () => {
    const r = planRest([{ kind: 'dependency' }], 0);
    expect(r.ok).toBe(false);
  });

  it('timeout ms <= 0 → ignored（0 等于立即醒，无意义）', () => {
    const r = planRest([{ kind: 'timeout', ms: 0 }], 0);
    expect(r.ok).toBe(false);
  });

  it('未知 kind → ignored，并说明是哪个', () => {
    const r = planRest([{ kind: 'whatever' }], 0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.ignored?.join()).toContain('whatever');
  });

  it('有效 + 无效混合 → 保留有效的，同时报告被丢的', () => {
    const r = planRest([{ kind: 'bogus' }, { kind: 'trigger' }], 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.conditions).toHaveLength(1);
    // 不能静默吞掉写错的那条——调用方要知道自己写错了
    expect(r.plan.ignored.join()).toContain('bogus');
  });
});

describe('planRest — 有界性（核心）', () => {
  it('没写 timeout → 自动补兜底，并明确标记 fallbackAdded', () => {
    const r = planRest([{ kind: 'trigger' }], 0);
    if (!r.ok) throw new Error('expected ok');
    expect(r.plan.fallbackAdded).toBe(true);
    expect(r.plan.boundedMs).toBe(REST_DEFAULT_FALLBACK_MS);
  });

  it('写了 timeout → 用它，不算兜底', () => {
    const r = planRest([{ kind: 'timeout', ms: 5000 }], 0);
    if (!r.ok) throw new Error('expected ok');
    expect(r.plan.fallbackAdded).toBe(false);
    expect(r.plan.boundedMs).toBe(5000);
  });

  it('多个 timeout → 取最小值（先到的先醒）', () => {
    const r = planRest([{ kind: 'timeout', ms: 5000 }, { kind: 'timeout', ms: 1000 }], 0);
    if (!r.ok) throw new Error('expected ok');
    expect(r.plan.boundedMs).toBe(1000);
  });

  it('timeout 超过硬上限 → 夹到硬上限（一个笔误不该让会话永久静默）', () => {
    const r = planRest([{ kind: 'timeout', ms: REST_HARD_MAX_MS * 100 }], 0);
    if (!r.ok) throw new Error('expected ok');
    expect(r.plan.boundedMs).toBe(REST_HARD_MAX_MS);
  });

  it('无论怎么写，boundedMs 永远 > 0 且 <= 硬上限', () => {
    const inputs = [
      [{ kind: 'trigger' }],
      [{ kind: 'timeout', ms: 1 }],
      [{ kind: 'timeout', ms: REST_HARD_MAX_MS + 1 }],
      [{ kind: 'stage', thread_ref: 'a', stage: 'b' }],
      [{ kind: 'dependency', task_id: 't' }],
    ];
    for (const list of inputs) {
      const r = planRest(list, 0);
      if (!r.ok) throw new Error('expected ok');
      expect(r.plan.boundedMs).toBeGreaterThan(0);
      expect(r.plan.boundedMs).toBeLessThanOrEqual(REST_HARD_MAX_MS);
    }
  });
});

describe('planRest — 连续次数上限', () => {
  it('未达上限 → 允许', () => {
    expect(planRest([{ kind: 'trigger' }], REST_MAX_STREAK - 1).ok).toBe(true);
  });

  it('达到上限 → refused（不是 error：这是策略拒绝，不是写错了）', () => {
    const r = planRest([{ kind: 'trigger' }], REST_MAX_STREAK);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe('refused');
    expect(r.restStreak).toBe(REST_MAX_STREAK);
  });
});
