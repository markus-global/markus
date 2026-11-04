import { describe, it, expect } from 'vitest';
import { activeReviewSession, hasLiveReview, isReviewQueued, isReviewing } from './taskReview.ts';

/**
 * 「有没有审核人正在审」只有一个判据。
 *
 * 这批断言钉住的是**顺序语义**（reviewing 压过 queued）与**状态语义**
 * （completed / dropped 一律不算活跃）。写坏任何一条，UI 就会出现
 * 「横幅说有 agent 在审，但那一轮其实早就结束了」这种自相矛盾。
 */
describe('activeReviewSession', () => {
  it('prefers a session that is actually reviewing over a queued one', () => {
    const picked = activeReviewSession([
      { status: 'queued', id: 'a' },
      { status: 'reviewing', id: 'b' },
    ]);
    expect(picked?.id).toBe('b');
  });

  it('falls back to queued when nobody has started yet', () => {
    const picked = activeReviewSession([{ status: 'completed' }, { status: 'queued', id: 'q' }]);
    expect(picked?.id).toBe('q');
  });

  it('returns null when every session is finished or abandoned', () => {
    expect(activeReviewSession([{ status: 'completed' }, { status: 'dropped' }])).toBeNull();
    expect(activeReviewSession([])).toBeNull();
  });

  it('does not treat "human is reviewing" (no agent session) as active', () => {
    // 待审核状态但没有任何投递 = 人工审核，不该出现「某 agent 正在审」的横幅。
    expect(activeReviewSession([])).toBeNull();
  });
});

describe('hasLiveReview / status predicates', () => {
  it('only counts reviewing as live (queued is not yet running)', () => {
    expect(hasLiveReview([{ status: 'queued' }])).toBe(false);
    expect(hasLiveReview([{ status: 'completed' }, { status: 'reviewing' }])).toBe(true);
    expect(hasLiveReview([])).toBe(false);
  });

  it('predicates are exact — no status falls into two buckets', () => {
    const statuses = ['queued', 'reviewing', 'completed', 'dropped'];
    for (const status of statuses) {
      const q = isReviewQueued({ status });
      const r = isReviewing({ status });
      expect(q && r).toBe(false);
      expect(q || r).toBe(status === 'queued' || status === 'reviewing');
    }
  });
});
