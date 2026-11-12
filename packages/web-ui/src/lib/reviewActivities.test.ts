import { describe, it, expect } from 'vitest';
import { matchReviewActivities } from './reviewActivities.ts';

function act(id: string, startedAt: string, extra: { taskId?: string | null; endedAt?: string | null } = {}) {
  return { id, startedAt, taskId: extra.taskId ?? null, endedAt: extra.endedAt ?? null };
}

const SESSION = { taskId: 'tsk_1', queuedAt: '2026-01-01T10:00:00Z', completedAt: '2026-01-01T10:30:00Z' };

describe('matchReviewActivities — 把评审活动归到哪一轮', () => {
  it('已记录 taskId 且一致 → 计入（不看时间）', () => {
    const a = act('a1', '2026-01-01T03:00:00Z', { taskId: 'tsk_1' });
    expect(matchReviewActivities([a], SESSION).map(x => x.id)).toEqual(['a1']);
  });

  it('已记录 taskId 但不一致 → 排除，即使时间窗重叠', () => {
    const a = act('a2', '2026-01-01T10:05:00Z', { taskId: 'tsk_OTHER' });
    expect(matchReviewActivities([a], SESSION)).toEqual([]);
  });

  it('历史行无 taskId 且窗口内 → 计入（兜底路径）', () => {
    const a = act('a3', '2026-01-01T10:10:00Z');
    expect(matchReviewActivities([a], SESSION).map(x => x.id)).toEqual(['a3']);
  });

  it('历史行无 taskId 且窗口外 → 排除', () => {
    const a = act('a4', '2026-01-01T08:00:00Z', { endedAt: '2026-01-01T08:10:00Z' });
    expect(matchReviewActivities([a], SESSION)).toEqual([]);
  });

  it('仍在评审（completedAt=null）→ 之后开始的活动也算', () => {
    const open = { ...SESSION, completedAt: null };
    const a = act('a5', '2026-01-01T23:00:00Z');
    expect(matchReviewActivities([a], open).map(x => x.id)).toEqual(['a5']);
  });

  it('按 startedAt 升序返回（时间线顺序）', () => {
    const list = [
      act('late', '2026-01-01T10:20:00Z'),
      act('early', '2026-01-01T10:02:00Z'),
    ];
    expect(matchReviewActivities(list, SESSION).map(x => x.id)).toEqual(['early', 'late']);
  });

  it('时间戳非法 → 丢弃，不抛异常', () => {
    const bad = act('bad', 'not-a-date');
    expect(matchReviewActivities([bad], SESSION)).toEqual([]);
  });
});
