/**
 * 服务端侧的「同一判据、同一答案」契约测试。
 *
 * 审计 `docs/architecture/hardcoded-string-audit.md` §2 查出 ≥8 份终态定义。
 * 本文件把**每个调用方**都拉回同一个谓词上比对：不是看它写得好不好，而是问
 * 「对同一个输入，它给出的答案是否与唯一事实源一致」。表驱动 —— 新增状态时
 * 忘改任何一处，这里就红。
 */
import { describe, it, expect } from 'vitest';
import {
  TERMINAL_STATUSES,
  TASK_TRANSITIONS,
  isTerminal,
  type ItemStatus,
} from '@markus/shared';
import { isTerminalTaskStatus } from '../src/task-attention.js';
import { DEAD_DEP_STATUSES } from '../src/agent-conservator.js';

const ALL_STATUSES: ItemStatus[] = [
  'pending',
  'in_progress',
  'blocked',
  'review',
  'completed',
  'failed',
  'rejected',
  'cancelled',
  'archived',
];

describe('one terminal answer per call site', () => {
  it('task-attention agrees with the shared predicate for every status (table-driven)', () => {
    const drift = ALL_STATUSES.filter((s) => isTerminalTaskStatus(s) !== isTerminal(s));
    expect(drift).toEqual([]);
  });

  it('does not resurrect the legacy "accepted" literal', () => {
    // `'accepted'` 不属于 FSM 的任何状态（见 TASK_TRANSITIONS）。
    // 它曾是 task-attention 里的一份私有字面量，任何真实状态都不可能等于它，
    // 于是那一份定义既不咬人、又让人以为「这里已经判过终态了」。
    expect(TASK_TRANSITIONS['accepted' as ItemStatus]).toBeUndefined();
    expect(isTerminalTaskStatus('accepted')).toBe(false);
  });
});

describe('incident regressions', () => {
  it('① a blocked(deps) card is not terminal — the dependency engine can still release it', () => {
    // 依据 FSM 的可达集，不凭直觉：blocked → in_progress 是合法迁移。
    // 若把 blocked 判成终态，注释注入会走「任务已结束」分支，正在等依赖的卡
    // 再也收不到人的补充说明。
    expect(TASK_TRANSITIONS.blocked.has('in_progress')).toBe(true);
    expect(isTerminalTaskStatus('blocked')).toBe(false);
  });

  it('② review is not terminal — a human decision is still pending', () => {
    expect(TASK_TRANSITIONS.review.has('completed')).toBe(true);
    expect(TASK_TRANSITIONS.review.has('in_progress')).toBe(true);
    expect(isTerminalTaskStatus('review')).toBe(false);
  });

  it('③ "dependency is dead" is a strict subset of terminal, and never includes live or successful states', () => {
    // 语义不同，所以两个集合不同：completed 的依赖是「做完了」，不是「死了」。
    // 若有人图省事把 DEAD_DEP_STATUSES 换成 isTerminal，依赖里只要有一个已完成
    // 的任务，下游就会被判「已死」而直接失败。
    for (const s of DEAD_DEP_STATUSES) {
      expect(isTerminal(s)).toBe(true);
    }
    for (const live of ['pending', 'in_progress', 'blocked', 'review', 'completed'] as const) {
      expect(DEAD_DEP_STATUSES.has(live)).toBe(false);
    }
  });
});
