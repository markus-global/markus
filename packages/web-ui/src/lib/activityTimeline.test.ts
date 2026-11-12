import { describe, it, expect } from 'vitest';
import { buildActivityTimeline } from './activityTimeline.ts';
import type { RoundSummary } from '../api.ts';
import type { ReviewSession } from './taskReview.ts';

function round(n: number, firstAt: string, lastAt = firstAt): RoundSummary {
  return { round: n, logCount: 10, toolCount: 3, firstAt, lastAt, status: 'completed' };
}

function session(id: string, roundNo: number, queuedAt: string, completedAt: string | null = null): ReviewSession {
  return {
    id, reviewerId: 'agt_rev', reviewerName: 'Secretary', status: completedAt ? 'completed' : 'reviewing',
    queuedAt, completedAt, round: roundNo, outcome: completedAt ? 'approved' : null,
    decidedByName: completedAt ? 'Secretary' : null, note: null,
  };
}

describe('buildActivityTimeline — 执行与评审合成一条时间线', () => {
  it('按开始时间排序（执行轮次与评审轮次交错）', () => {
    const items = buildActivityTimeline(
      [round(1, '2026-01-01T00:00:00Z'), round(2, '2026-01-01T02:00:00Z')],
      [session('review:1', 1, '2026-01-01T01:00:00Z', '2026-01-01T01:30:00Z')],
    );
    expect(items.map(i => `${i.kind}:${i.round}`)).toEqual(['execution:1', 'review:1', 'execution:2']);
  });

  it('轮次号各算各的：执行第 2 轮和评审第 2 轮可以同时存在', () => {
    const items = buildActivityTimeline(
      [round(2, '2026-01-01T02:00:00Z')],
      [session('review:2', 2, '2026-01-01T03:00:00Z')],
    );
    expect(items).toHaveLength(2);
    expect(items[0]!.kind).toBe('execution');
    expect(items[1]!.kind).toBe('review');
  });

  it('同开始时刻：执行排在评审前', () => {
    const t = '2026-01-01T05:00:00Z';
    const items = buildActivityTimeline([round(1, t)], [session('review:1', 1, t)]);
    expect(items.map(i => i.kind)).toEqual(['execution', 'review']);
  });

  it("filter='review' 只留评审", () => {
    const items = buildActivityTimeline([round(1, '2026-01-01T00:00:00Z')], [session('review:1', 1, '2026-01-01T01:00:00Z')], 'review');
    expect(items.every(i => i.kind === 'review')).toBe(true);
    expect(items).toHaveLength(1);
  });

  it("filter='execution' 只留执行", () => {
    const items = buildActivityTimeline([round(1, '2026-01-01T00:00:00Z')], [session('review:1', 1, '2026-01-01T01:00:00Z')], 'execution');
    expect(items.every(i => i.kind === 'execution')).toBe(true);
    expect(items).toHaveLength(1);
  });

  it('非法时间戳的条目被丢弃，不抛异常', () => {
    const items = buildActivityTimeline([round(1, 'nonsense')], [session('review:1', 1, '2026-01-01T01:00:00Z')]);
    expect(items.map(i => i.key)).toEqual(['review:1']);
  });

  it('两者皆空 → 空数组', () => {
    expect(buildActivityTimeline([], [])).toEqual([]);
  });
});
