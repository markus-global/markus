import { describe, it, expect } from 'vitest';
import { matchReviewActivities } from './reviewActivities.ts';

function act(id: string, startedAt: string, extra: { taskId?: string | null; endedAt?: string | null; label?: string } = {}) {
  return { id, startedAt, taskId: extra.taskId ?? null, endedAt: extra.endedAt ?? null, label: extra.label ?? 'Reviewing task from CTO' };
}

const SESSION = { taskId: 'tsk_1', queuedAt: '2026-01-01T10:00:00Z', completedAt: '2026-01-01T10:30:00Z' };

describe('matchReviewActivities — 把评审活动归到哪一轮', () => {
  it('已记录 taskId 且落在本轮窗口内 → 计入', () => {
    const a = act('a1', '2026-01-01T10:05:00Z', { taskId: 'tsk_1' });
    expect(matchReviewActivities([a], SESSION).map(x => x.id)).toEqual(['a1']);
  });

  // 关键回归（2026-11-12 tsk_1fa331f0）：同一张卡的**另一个**评审回合带同一个 taskId，
  // 但时间上属于上一轮 → 绝不能出现在这一轮里（用户看到的就是「旧内容」）。
  it('同一 taskId 但属于其它轮次（窗口外）→ 排除', () => {
    const previousRound = act('older', '2026-01-01T03:00:00Z', { taskId: 'tsk_1', endedAt: '2026-01-01T03:02:00Z' });
    const thisRound = act('now', '2026-01-01T10:10:00Z', { taskId: 'tsk_1' });
    expect(matchReviewActivities([previousRound, thisRound], SESSION).map(x => x.id)).toEqual(['now']);
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

  // ── 回归：回复评论 / 其它会话绝不能被当成评审轮次 ──────────────────────
  it('时间窗内的「回复评论」回合 → 排除（它不是评审）', () => {
    const a = act('comment', '2026-01-01T10:10:00Z', { label: 'Comment reply to CTO' });
    expect(matchReviewActivities([a], SESSION)).toEqual([]);
  });

  it('时间窗内的需求动作 / a2a 聊天 / 心跳 → 排除', () => {
    const list = [
      act('req', '2026-01-01T10:05:00Z', { label: 'Requirement action from System' }),
      act('a2a', '2026-01-01T10:06:00Z', { label: 'Chat from Secretary' }),
      act('hb', '2026-01-01T10:07:00Z', { label: 'Internal Operation' }),
    ];
    expect(matchReviewActivities(list, SESSION)).toEqual([]);
  });

  it('label 为 Task Review 也认（无 peer 名时的形态）', () => {
    const a = act('t', '2026-01-01T10:10:00Z', { label: 'Task Review' });
    expect(matchReviewActivities([a], SESSION).map(x => x.id)).toEqual(['t']);
  });

  it('即使 taskId 匹配，非评审回合也不进评审块', () => {
    const a = act('c', '2026-01-01T10:10:00Z', { taskId: 'tsk_1', label: 'Comment reply to CTO' });
    expect(matchReviewActivities([a], SESSION)).toEqual([]);
  });
});
