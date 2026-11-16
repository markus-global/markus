import { describe, it, expect } from 'vitest';
import {
  deriveReviewSessions, activeReviewSession, hasLiveReview, reviewerDisplayName, reviewBannerName,
} from './taskReview.ts';
import type { StatusTransitionInfo } from '../api.ts';

function tr(id: number, fromStatus: string, toStatus: string, createdAt: string, extra: Partial<StatusTransitionInfo> = {}): StatusTransitionInfo {
  return { id, fromStatus, toStatus, changedById: 'agt_r', changedByType: 'agent', changedByName: 'Reviewer', reason: null, createdAt, ...extra };
}

describe('deriveReviewSessions — from authoritative status history', () => {
  it('a → review with no later transition is an OPEN (reviewing) session', () => {
    const s = deriveReviewSessions([tr(1, 'in_progress', 'review', '2026-01-01T00:00:00Z')]);
    expect(s).toHaveLength(1);
    expect(s[0]!.status).toBe('reviewing');
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

/**
 * 事故（Owner 2026-11-16 打回）：评审者是**人类**的卡上，横幅显示「{某个 Agent} 正在评审」，
 * 那个 Agent 其实是**提交评审的执行者**。
 *
 * 根因不是「人类名册查不到」这一条，而是「查不到就换个语义不同的人顶替」：
 * 提交者 ≠ 评审者。所以评审人名只有**一个**来源——任务的指定 reviewer；
 * 拿不到就是不显示，绝不回退。
 */
describe('deriveReviewSessions — 评审人名只来自指定 reviewer（不用提交者顶替）', () => {
  it('Agent A 提交 → review、指定评审者是名册里查不到的人类 ⇒ reviewerName 不得是 A', () => {
    // 人类评审者的名字由页面从 users 名册解析；模拟「解析不到」的两种入参形态：
    //   ''    —— 现在的页面（reviewerDisplayName 查不到就返回空串）
    //   undefined —— 旧页面（agents.find(...)?.name 查不到就是 undefined，正是事故现场）
    for (const missing of ['', undefined] as const) {
      const s = deriveReviewSessions(
        [tr(1, 'in_progress', 'review', '2026-01-01T00:00:00Z', {
          changedById: 'agt_submitter', changedByName: 'Submitter Agent',
        })],
        { reviewerId: 'user_human_reviewer', reviewerName: missing },
      );
      expect(s[0]!.reviewerName).not.toBe('Submitter Agent');
      expect(s[0]!.reviewerName).toBe('');
      expect(s[0]!.reviewerId).toBe('user_human_reviewer');
    }
  });

  it('opts.reviewerName 缺省时留空串，不拿历史里的 changedByName 充数', () => {
    const s = deriveReviewSessions([
      tr(1, 'in_progress', 'review', '2026-01-01T00:00:00Z', { changedByName: 'Submitter Agent' }),
    ]);
    expect(s[0]!.reviewerName).toBe('');
  });
});

/** 名册解析：人类查 users、Agent 查 agents；判据是权威字段 reviewerType，不猜 id 前缀。 */
describe('reviewerDisplayName — 按 reviewerType 查对应名册', () => {
  const rosters = {
    agents: [{ id: 'agt_rev', name: 'Secretary' }],
    users: [{ id: 'user_owner', name: 'Jason Carter' }],
  };

  it('人类评审者 ⇒ 从 users 名册取名', () => {
    expect(reviewerDisplayName({ reviewerId: 'user_owner', reviewerType: 'human' }, rosters)).toBe('Jason Carter');
  });

  it('Agent 评审者 ⇒ 从 agents 名册取名（回归：路径不变）', () => {
    expect(reviewerDisplayName({ reviewerId: 'agt_rev', reviewerType: 'agent' }, rosters)).toBe('Secretary');
  });

  it('reviewerType 缺省按 agent 处理（老数据没有该字段）', () => {
    expect(reviewerDisplayName({ reviewerId: 'agt_rev' }, rosters)).toBe('Secretary');
  });

  it('人类评审者即便 agents 名册里有同名 id，也不许从 agents 取名', () => {
    const sameIdEverywhere = { agents: [{ id: 'user_x', name: 'Wrong Roster' }], users: [] as Array<{ id: string; name: string }> };
    expect(reviewerDisplayName({ reviewerId: 'user_x', reviewerType: 'human' }, sameIdEverywhere)).toBe('');
  });

  it('查不到就是空串（不猜、不顶替）', () => {
    expect(reviewerDisplayName({ reviewerId: 'user_ghost', reviewerType: 'human' }, rosters)).toBe('');
    expect(reviewerDisplayName({ reviewerId: 'agt_ghost', reviewerType: 'agent' }, rosters)).toBe('');
  });
});

/** 「{reviewer} 正在评审」横幅要不要显示、显示谁——单一判据，页面不再自己推。 */
describe('reviewBannerName — 评审中横幅的归属', () => {
  const sessionsFor = (reviewerId: string, reviewerName?: string) => deriveReviewSessions(
    [tr(1, 'in_progress', 'review', '2026-01-01T00:00:00Z', {
      changedById: 'agt_submitter', changedByName: 'Submitter Agent',
    })],
    { reviewerId, reviewerName },
  );

  it('人类评审者 + status=review ⇒ 不显示横幅（Owner 裁定）', () => {
    expect(reviewBannerName(sessionsFor('user_owner', 'Jason Carter'), {
      status: 'review', reviewerType: 'human',
    })).toBeNull();
  });

  it('人类评审者即便名字解析不到，也不显示横幅', () => {
    expect(reviewBannerName(sessionsFor('user_owner', ''), { status: 'review', reviewerType: 'human' })).toBeNull();
  });

  it('Agent 评审者 + status=review ⇒ 显示，姓名 = 评审者本人（回归）', () => {
    expect(reviewBannerName(sessionsFor('agt_rev', 'Secretary'), {
      status: 'review', reviewerType: 'agent',
    })).toBe('Secretary');
  });

  it('Agent 评审者名字解析不到 ⇒ 不显示横幅，也不退回提交者', () => {
    const name = reviewBannerName(sessionsFor('agt_rev', ''), { status: 'review', reviewerType: 'agent' });
    expect(name).toBeNull();
    expect(name).not.toBe('Submitter Agent');
  });

  it('任务不在 review 状态 ⇒ 不显示横幅', () => {
    expect(reviewBannerName(sessionsFor('agt_rev', 'Secretary'), {
      status: 'in_progress', reviewerType: 'agent',
    })).toBeNull();
  });

  it('没有未关闭的评审会话 ⇒ 不显示横幅', () => {
    const closed = deriveReviewSessions([
      tr(1, 'in_progress', 'review', '2026-01-01T00:00:00Z'),
      tr(2, 'review', 'completed', '2026-01-01T01:00:00Z'),
    ], { reviewerId: 'agt_rev', reviewerName: 'Secretary' });
    expect(reviewBannerName(closed, { status: 'review', reviewerType: 'agent' })).toBeNull();
  });
});
