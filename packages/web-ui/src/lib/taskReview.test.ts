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

  it('attributes the session to the assigned reviewer, not the submitter', () => {
    const s = deriveReviewSessions(
      [tr(1, 'in_progress', 'review', '2026-01-01T00:00:00Z', { changedByName: 'Submitter' })],
      { reviewerId: 'agt_rev', reviewerName: 'Real Reviewer' },
    );
    expect(s[0]!.reviewerName).toBe('Real Reviewer');
  });

  it('falls back to the task reviewer when the transition has no name', () => {
    const s = deriveReviewSessions(
      [tr(1, 'in_progress', 'review', '2026-01-01T00:00:00Z', { changedById: null, changedByName: null })],
      { reviewerId: 'agt_fallback' },
    );
    expect(s[0]!.reviewerId).toBe('agt_fallback');
  });
});

/**
 * 「评审进展」tab 要展示的是**这次评审的结论**，不是执行者的回合日志。
 * 事故：该 tab 曾经直接复用执行日志组件，两个 tab 内容一模一样，毫无信息。
 *
 * 结论的唯一来源是**关闭该会话的那条迁移**（FSM 真实可达集：
 * review → { completed, in_progress, cancelled }），不猜文案、不看正文。
 */
describe('deriveReviewSessions — outcome of each review round', () => {
  it('review → completed ⇒ approved，并带上决定人与评审说明', () => {
    const s = deriveReviewSessions([
      tr(1, 'in_progress', 'review', '2026-01-01T00:00:00Z'),
      tr(2, 'review', 'completed', '2026-01-01T02:00:00Z', {
        changedByName: 'Secretary', reason: '证据齐全，通过',
      }),
    ]);
    expect(s[0]!.status).toBe('completed');
    expect(s[0]!.outcome).toBe('approved');
    expect(s[0]!.decidedByName).toBe('Secretary');
    expect(s[0]!.note).toBe('证据齐全，通过');
    expect(s[0]!.round).toBe(1);
  });

  it('review → in_progress ⇒ revision_requested（打回返工），原因保留', () => {
    const s = deriveReviewSessions([
      tr(1, 'in_progress', 'review', '2026-01-01T00:00:00Z'),
      tr(2, 'review', 'in_progress', '2026-01-01T01:00:00Z', { reason: '缺第 3 项证据' }),
    ]);
    expect(s[0]!.outcome).toBe('revision_requested');
    expect(s[0]!.note).toBe('缺第 3 项证据');
  });

  it('review → cancelled ⇒ closed（未通过关闭），不伪装成 approved', () => {
    const s = deriveReviewSessions([
      tr(1, 'in_progress', 'review', '2026-01-01T00:00:00Z'),
      tr(2, 'review', 'cancelled', '2026-01-01T01:00:00Z'),
    ]);
    expect(s[0]!.outcome).toBe('closed');
  });

  it('仍在评审 ⇒ outcome / decidedByName / note 全为 null（不能编造结论）', () => {
    const s = deriveReviewSessions([tr(1, 'in_progress', 'review', '2026-01-01T00:00:00Z')]);
    expect(s[0]!.outcome).toBeNull();
    expect(s[0]!.decidedByName).toBeNull();
    expect(s[0]!.note).toBeNull();
  });

  it('多轮评审各自带自己的结论与轮次（打回后重提）', () => {
    const s = deriveReviewSessions([
      tr(1, 'in_progress', 'review', '2026-01-01T00:00:00Z'),
      tr(2, 'review', 'in_progress', '2026-01-01T01:00:00Z', { reason: '补证据' }),
      tr(3, 'in_progress', 'review', '2026-01-02T00:00:00Z'),
      tr(4, 'review', 'completed', '2026-01-02T03:00:00Z', { reason: '通过' }),
    ]);
    expect(s).toHaveLength(2);
    expect(s[0]!.round).toBe(1);
    expect(s[0]!.outcome).toBe('revision_requested');
    expect(s[0]!.note).toBe('补证据');
    expect(s[1]!.round).toBe(2);
    expect(s[1]!.outcome).toBe('approved');
    expect(s[1]!.note).toBe('通过');
  });
});
