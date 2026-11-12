/**
 * 评审回合结果判定 —— 纯函数契约测试
 *
 * 事故（2026-11-11，tsk_594b439a4362be43984bc86b）：评审人跑了 6 个回合、20 个工具、
 * 618,091 tokens，卡片一次都没改；`reply=''` 让注意力层判为「未完成」→ 无限重投 →
 * 最终被陈旧 processing 清理静默标 dropped。卡片永久停在 review。
 *
 * 判据要修的不是「重投」本身，而是**一个信号回答了两个问题**：
 *   `reply=''` 既表示「LLM 抖动，值得重试」，又表示「评审人没做决定」。
 * 前者重试有意义，后者重试一万次也不会变好 —— 它需要人。
 *
 * 所以这里把它拆成一个显式判定：settled / retry / escalate。
 */
import { describe, it, expect } from 'vitest';
import {
  resolveReviewTurnOutcome,
  REVIEW_TURN_MAX_RETRIES,
} from '../src/review-turn-outcome.js';

describe('resolveReviewTurnOutcome', () => {
  it('卡片被改过 → settled，且清零重试计数', () => {
    const r = resolveReviewTurnOutcome({ cardMutated: true, priorUndecidedTurns: 0 });
    expect(r.action).toBe('settled');
    expect(r.attempts).toBe(0);
  });

  it('卡片被改过时，即使之前失败过也判定 settled（不看历史惩罚）', () => {
    const r = resolveReviewTurnOutcome({ cardMutated: true, priorUndecidedTurns: 5 });
    expect(r.action).toBe('settled');
    expect(r.attempts).toBe(0);
  });

  it('首次未决策 → retry，计数递增到 1', () => {
    const r = resolveReviewTurnOutcome({ cardMutated: false, priorUndecidedTurns: 0 });
    expect(r.action).toBe('retry');
    expect(r.attempts).toBe(1);
  });

  it(`未决策次数不超过 ${REVIEW_TURN_MAX_RETRIES} 时仍 retry`, () => {
    for (let prior = 0; prior < REVIEW_TURN_MAX_RETRIES; prior++) {
      const r = resolveReviewTurnOutcome({ cardMutated: false, priorUndecidedTurns: prior });
      expect(r.action).toBe('retry');
      expect(r.attempts).toBe(prior + 1);
    }
  });

  it('达到上限后仍无决策 → escalate（不再无限重投）', () => {
    const r = resolveReviewTurnOutcome({
      cardMutated: false,
      priorUndecidedTurns: REVIEW_TURN_MAX_RETRIES,
    });
    expect(r.action).toBe('escalate');
    expect(r.attempts).toBe(REVIEW_TURN_MAX_RETRIES + 1);
  });

  it('超过上限后继续 → 仍然 escalate，永不回到 retry', () => {
    const r = resolveReviewTurnOutcome({
      cardMutated: false,
      priorUndecidedTurns: REVIEW_TURN_MAX_RETRIES + 7,
    });
    expect(r.action).toBe('escalate');
  });

  it('纯函数：同一输入反复求值结果恒等（可安全用于热路径）', () => {
    const input = { cardMutated: false, priorUndecidedTurns: 1 };
    const a = resolveReviewTurnOutcome(input);
    const b = resolveReviewTurnOutcome(input);
    expect(a).toEqual(b);
  });

  it('上限是一个正数常量——它必须有限，否则本 bug 会原样复现', () => {
    expect(Number.isFinite(REVIEW_TURN_MAX_RETRIES)).toBe(true);
    expect(REVIEW_TURN_MAX_RETRIES).toBeGreaterThan(0);
    expect(REVIEW_TURN_MAX_RETRIES).toBeLessThan(10);
  });
});
