import { describe, it, expect } from 'vitest';
import { deriveReviewSessions, activeReviewSession, hasLiveReview } from './taskReview.ts';
import type { StatusTransitionInfo } from '../api.ts';

function tr(id: number, fromStatus: string, toStatus: string, createdAt: string, extra: Partial<StatusTransitionInfo> = {}): StatusTransitionInfo {
  return { id, fromStatus, toStatus, changedById: 'agt_r', changedByType: 'agent', changedByName: 'Reviewer', reason: null, createdAt, ...extra };
}

describe('deriveReviewSessions — from authoritative status history', () => {
  it('a → review with no later transition is an OPEN (reviewing) session', () => {
    const s = deriveReviewSessions([tr(1, 'in_progress', 'review', '2026-01-01T00:00:00Z')]);
    expect(s).toHaveLength(1);
    expect(s[0]!.status).toBe('reviewing');
    expect(s[0]!.reviewerName).toBe('Reviewer');
    expect(s[0]!.completedAt).toBeNull();
  });

  it('a later transition CLOSES the session (completed)', () => {
    const s = deriveReviewSessions([
      tr(1, 'in_progress', 'review', '2026-01-01T00:00:00Z'),
      tr(2, 'review', 'in_progress', '2026-01-01T01:00:00Z'),
    ]);
    expect(s).toHaveLength(1);
    expect(s[0]!.status).toBe('completed');
    expect(s[0]!.completedAt).toBe('2026-01-01T01:00:00Z');
  });

  it('counts each review round (review → revision → review)', () => {
    const s = deriveReviewSessions([
      tr(1, 'in_progress', 'review', '2026-01-01T00:00:00Z'),
      tr(2, 'review', 'in_progress', '2026-01-01T01:00:00Z'),
      tr(3, 'in_progress', 'review', '2026-01-02T00:00:00Z'),
    ]);
    expect(s).toHaveLength(2);
    expect(s[0]!.status).toBe('completed');
    expect(s[1]!.status).toBe('reviewing');
    expect(activeReviewSession(s)?.id).toBe(s[1]!.id);
    expect(hasLiveReview(s)).toBe(true);
  });

  it('no review transitions ⇒ no sessions, nothing live', () => {
    const s = deriveReviewSessions([tr(1, 'pending', 'in_progress', '2026-01-01T00:00:00Z')]);
    expect(s).toEqual([]);
    expect(activeReviewSession(s)).toBeNull();
    expect(hasLiveReview(s)).toBe(false);
  });

  it('falls back to the task reviewer when the transition has no name', () => {
    const s = deriveReviewSessions(
      [tr(1, 'in_progress', 'review', '2026-01-01T00:00:00Z', { changedById: null, changedByName: null })],
      { reviewerId: 'agt_fallback' },
    );
    expect(s[0]!.reviewerId).toBe('agt_fallback');
  });
});
