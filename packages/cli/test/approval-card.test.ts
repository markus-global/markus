/**
 * Approval-card rewrite scheduling — regression for the "card flashed resolved,
 * then snapped back to buttons" defect (2026-10-13, runtime log + Feishu API
 * probe: the server kept the resolved card while the tapper's client re-rendered
 * the clicked-time card from the callback response).
 *
 * Contract under test:
 * 1. the CardResolution is built from the approval record (never re-parsed out
 *    of card text), with the tapped option / actor as display fallbacks;
 * 2. terminal statuses map onto the four renderable states;
 * 3. the rewrite runs *after* the callback ack (delayed), so the PATCH is the
 *    last write the tapper's client applies — and a rejected/crashing rewrite
 *    must never propagate (best-effort by contract).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildApprovalCardResolution, scheduleCardRewrite, CARD_REWRITE_DELAY_MS } from '../src/commands/approval-card.ts';

const APPROVAL = {
  status: 'approved',
  title: '【测试】审批卡片点击回写验证',
  description: '这是一条真实审批（走飞书通知群）。',
  respondedBy: 'ou_3e00417535c7ff3aef0603ee94897c4e',
  selectedOption: 'approve',
  respondedAt: '2026-10-13T11:53:56.886Z',
};

describe('buildApprovalCardResolution — resolution from the approval record', () => {
  it('re-uses title/body verbatim; the recorded decision-maker wins over the tap', () => {
    const r = buildApprovalCardResolution(APPROVAL, {
      actorId: 'ou_tapper',
      tappedOption: 'approve',
    });
    expect(r).toMatchObject({
      status: 'approved',
      title: APPROVAL.title,
      body: APPROVAL.description,
      actorId: APPROVAL.respondedBy, // a re-tap must not rewrite history
      selectedOption: 'approve',
      at: APPROVAL.respondedAt,
    });
  });

  it('lets the tap fill display fields the record lacks', () => {
    const bare = { ...APPROVAL, respondedBy: undefined, selectedOption: undefined };
    const r = buildApprovalCardResolution(bare, { actorId: 'ou_tapper', tappedOption: 'reject' });
    expect(r.actorId).toBe('ou_tapper');
    expect(r.selectedOption).toBe('reject');
  });

  it('falls back to the stored responder / selected option when the tap carries none', () => {
    const r = buildApprovalCardResolution(APPROVAL, {});
    expect(r.actorId).toBe(APPROVAL.respondedBy);
    expect(r.selectedOption).toBe('approve');
  });

  it('maps every terminal status onto the renderable set (still pending → pending, never expired)', () => {
    for (const [status, expected] of [
      ['approved', 'approved'],
      ['rejected', 'rejected'],
      ['cancelled', 'cancelled'],
      ['expired', 'expired'],
      // 待定不能被画成“已超时”：那是另一种谎（人会以为单子死了，再发一份）。
      // 2026-10-28 实测：飞书上点对了选项、服务端拒收（表单需到应用内回答），
      // 卡片却显示“已超时”。
      ['pending', 'pending'],
    ] as const) {
      expect(buildApprovalCardResolution({ ...APPROVAL, status }, {}).status).toBe(expected);
    }
  });
});

describe('scheduleCardRewrite — after-ack, best-effort execution', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it(`runs after ${CARD_REWRITE_DELAY_MS}ms (post-ack), not synchronously`, async () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    scheduleCardRewrite(fn);
    expect(fn).not.toHaveBeenCalled(); // the callback ack must go out first
    await vi.advanceTimersByTimeAsync(CARD_REWRITE_DELAY_MS);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('never propagates a rejection from the rewrite (best-effort)', async () => {
    vi.useFakeTimers();
    const boom = vi.fn().mockRejectedValue(new Error('PATCH failed'));
    expect(() => scheduleCardRewrite(boom)).not.toThrow();
    await vi.advanceTimersByTimeAsync(CARD_REWRITE_DELAY_MS);
    expect(boom).toHaveBeenCalledTimes(1);
  });

  it('hands the failure to onError instead of rejecting', async () => {
    vi.useFakeTimers();
    const failure = new Error('PATCH failed');
    const onError = vi.fn();
    scheduleCardRewrite(vi.fn().mockRejectedValue(failure), onError);
    await vi.advanceTimersByTimeAsync(CARD_REWRITE_DELAY_MS);
    expect(onError).toHaveBeenCalledWith(failure);
  });
});
