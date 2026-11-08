/**
 * 守卫：「为什么这张卡是 blocked」只有一套判定。
 *
 * 三个必须咬住的点：
 *  ① 服务端记下的 `blockedReason` 是事实，压过任何推断（哪怕 blockedBy 看起来矛盾）；
 *  ② 旧数据（`blockedReason` 为 null）回退到引入该字段之前的口径，**行为不变**；
 *  ③ `deps` 永远不需要人动手 —— 概览据此把它挡在「等你处理」之外。
 *
 * 负向对照：把 `blockedReasonOf` 改成「有依赖就是 hold」，第 ③ 组会红。
 */
import { describe, it, expect } from 'vitest';
import { blockedReasonOf, needsHumanDecision } from './blockedReason.ts';

const dep = (status: string) => () => ({ status });

describe('blockedReasonOf — 服务端记录优先', () => {
  it('hold 就是 hold，即使它看起来像等依赖', () => {
    const task = { blockedReason: 'hold' as const, blockedBy: ['t1'] };
    expect(blockedReasonOf(task, dep('in_progress'))).toBe('hold');
  });

  it('deps 就是 deps，即使依赖其实已经完成', () => {
    const task = { blockedReason: 'deps' as const, blockedBy: ['t1'] };
    expect(blockedReasonOf(task, dep('completed'))).toBe('deps');
  });
});

describe('blockedReasonOf — 旧数据（blockedReason 缺失）回退推断', () => {
  it('没有依赖却 blocked → hold（引擎本该恢复却没恢复，需要人看）', () => {
    expect(blockedReasonOf({ blockedReason: null, blockedBy: [] })).toBe('hold');
    expect(blockedReasonOf({ blockedBy: undefined })).toBe('hold');
  });

  it('依赖未完成 → deps（引擎会自己恢复，不该打扰人）', () => {
    const task = { blockedReason: null, blockedBy: ['t1', 't2'] };
    const lookup = (id: string) => ({ status: id === 't1' ? 'completed' : 'in_progress' });
    expect(blockedReasonOf(task, lookup)).toBe('deps');
  });

  it('依赖全部已完成却仍 blocked → hold', () => {
    const task = { blockedReason: null, blockedBy: ['t1'] };
    expect(blockedReasonOf(task, dep('completed'))).toBe('hold');
  });

  it('查不到依赖状态时不替用户判断「需要你」→ deps', () => {
    const task = { blockedReason: null, blockedBy: ['missing'] };
    expect(blockedReasonOf(task, () => undefined)).toBe('deps');
    // 连查找函数都没给：更不该声称需要人。
    expect(blockedReasonOf(task)).toBe('deps');
  });
});

describe('needsHumanDecision — 概览「等你处理」的准入判据', () => {
  it('只有 hold 需要人', () => {
    expect(needsHumanDecision({ blockedReason: 'hold', blockedBy: [] })).toBe(true);
    expect(needsHumanDecision({ blockedReason: 'deps', blockedBy: ['t1'] })).toBe(false);
  });

  it('等依赖的卡不进「等你处理」（用户对它无从下手）', () => {
    const waitingOnDeps = { blockedReason: null, blockedBy: ['t1'] };
    expect(needsHumanDecision(waitingOnDeps, () => ({ status: 'in_progress' }))).toBe(false);
  });
});
