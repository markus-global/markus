/**
 * 「终态」只有一个判据 —— 本文件是那一个判据的守卫。
 *
 * 为什么需要单独的测试文件：审计（`docs/architecture/hardcoded-string-audit.md` §2）
 * 查出同一个问题在仓库里有 ≥8 份答案，其中一份把 `blocked`、`review` 当终态，
 * 另一份把早已脱离 FSM 的 `'accepted'` 也当终态。它们各自都能通过自己的测试，
 * 因为没有任何测试问过「这些答案对同一个输入是否给出同一个结果」。
 *
 * 判定谁属于终态，不看直觉，看 FSM：`TASK_TRANSITIONS` 是状态机的权威。
 * 一个状态只要还有通往「活」状态的出边，它就还活着。
 */
import { describe, it, expect } from 'vitest';
import {
  TASK_TRANSITIONS,
  TERMINAL_STATUSES,
  isTerminal,
  type ItemStatus,
} from '../src/types/task.js';

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

describe('isTerminal — the single terminal predicate', () => {
  it('agrees with TERMINAL_STATUSES for every declared status (table-driven)', () => {
    const drift = ALL_STATUSES.filter((s) => isTerminal(s) !== TERMINAL_STATUSES.has(s));
    expect(drift).toEqual([]);
  });

  it('classifies exactly the five finished statuses as terminal', () => {
    expect(ALL_STATUSES.filter(isTerminal).sort()).toEqual([
      'archived',
      'cancelled',
      'completed',
      'failed',
      'rejected',
    ]);
  });

  it('blocked is live: the dependency engine releases it into in_progress', () => {
    // 依据 FSM 的可达集，不凭直觉。
    expect(TASK_TRANSITIONS.blocked.has('in_progress')).toBe(true);
    expect(isTerminal('blocked')).toBe(false);
  });

  it('review is live: it waits for a human decision', () => {
    expect(TASK_TRANSITIONS.review.has('completed')).toBe(true);
    expect(TASK_TRANSITIONS.review.has('in_progress')).toBe(true);
    expect(isTerminal('review')).toBe(false);
  });

  it('archived is the only absorbing terminal status', () => {
    expect(isTerminal('archived')).toBe(true);
    expect(TASK_TRANSITIONS.archived.size).toBe(0);
  });

  it('answers false for unknown / empty / absent statuses — "not recognised" is not "finished"', () => {
    expect(isTerminal('accepted')).toBe(false);
    expect(isTerminal('')).toBe(false);
    expect(isTerminal(undefined)).toBe(false);
    expect(isTerminal(null)).toBe(false);
  });
});
