/**
 * 评论→轮次归属的回归守卫（2026-11-15 Owner 报障）。
 *
 * 事故形态：r2 执行期间投的人类评论，前端显示在 r1 名下。
 * 后端注入是对的（日志证明进了 `task_<id>_r2`），错在展示层把窗口算成
 * `[本轮 firstAt, 下轮 firstAt)`，使两轮之间的**间隙**归属上一轮。
 *
 * 下面用的是真机发生过的时刻：
 *   r1: 07:35:34 开始 → 07:35:49 settled
 *   r2: 07:36:14 启动，但**第一条日志**到 07:36:20 才产生
 *   人类评论: 07:36:17 投递（落在 (07:35:49, 07:36:20) 的间隙里）
 *
 * 旧口径把它判给 r1（= 用户看到的现象）；正确口径判给 r2。
 */
import { describe, it, expect } from 'vitest';
import {
  commentsBeforeFirstRound,
  commentsForRound,
  roundWindow,
  type RoundWindow,
} from './roundAttribution.ts';

const R1_START = '2026-11-15T07:35:34.000Z';
const R1_END = '2026-11-15T07:35:49.000Z';
const R2_START = '2026-11-15T07:36:20.000Z';
const R2_END = '2026-11-15T07:39:12.000Z';
/** 真机那条评论：r2 已启动、但 r2 还没产出第一条日志。 */
const IN_THE_GAP = '2026-11-15T07:36:17.000Z';

const rounds: RoundWindow[] = [
  { round: 1, firstAt: R1_START, lastAt: R1_END },
  { round: 2, firstAt: R2_START, lastAt: R2_END },
];

describe('评论归属轮次', () => {
  it('两轮之间的间隙归下一轮，不归上一轮（真机回归）', () => {
    const comments = [{ id: 'c1', createdAt: IN_THE_GAP }];

    // 这就是事故本身：旧口径会把它算进 r1。
    expect(commentsForRound(comments, rounds, 1)).toHaveLength(0);
    expect(commentsForRound(comments, rounds, 2).map(c => c.id)).toEqual(['c1']);
  });

  it('本轮执行期间的评论归本轮', () => {
    const comments = [
      { id: 'r1c', createdAt: '2026-11-15T07:35:40.000Z' },
      { id: 'r2c', createdAt: '2026-11-15T07:37:00.000Z' },
    ];
    expect(commentsForRound(comments, rounds, 1).map(c => c.id)).toEqual(['r1c']);
    expect(commentsForRound(comments, rounds, 2).map(c => c.id)).toEqual(['r2c']);
  });

  it('间隙之前的评论仍归上一轮（不把 r1 自己的评论也推走）', () => {
    const comments = [{ id: 'mid', createdAt: '2026-11-15T07:35:45.000Z' }];
    expect(commentsForRound(comments, rounds, 1).map(c => c.id)).toEqual(['mid']);
    expect(commentsForRound(comments, rounds, 2)).toHaveLength(0);
  });

  it('最后一轮无上界（可能仍在执行），之后投的评论仍归它', () => {
    const comments = [{ id: 'late', createdAt: '2026-11-15T07:50:00.000Z' }];
    expect(commentsForRound(comments, rounds, 2).map(c => c.id)).toEqual(['late']);
  });

  it('第 0 轮窗口从自己的首条日志开始；更早的评论单独渲染', () => {
    const { start } = roundWindow(rounds, 1);
    expect(start).toBe(new Date(R1_START).getTime());

    const comments = [{ id: 'before', createdAt: '2026-11-15T07:30:00.000Z' }];
    expect(commentsBeforeFirstRound(comments, rounds).map(c => c.id)).toEqual(['before']);
    expect(commentsForRound(comments, rounds, 1)).toHaveLength(0);
  });

  it('时间戳无法解析的评论不落进任何一轮（不猜）', () => {
    const comments = [{ id: 'bad', createdAt: 'not-a-date' }];
    expect(commentsForRound(comments, rounds, 1)).toHaveLength(0);
    expect(commentsForRound(comments, rounds, 2)).toHaveLength(0);
  });
});
