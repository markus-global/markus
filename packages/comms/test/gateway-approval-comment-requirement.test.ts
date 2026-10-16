/**
 * 「要求修改」不可以是一个**无法填写意见**的按钮。
 *
 * 打回不是一个状态，而是「评论 + 重提」的回路：没有理由的打回，等于把工作原样
 * 退回去、却什么都没告诉执行人 —— 比没有这个按钮更糟。而平台卡片的入站路径
 * （`start.ts` 的 setActionHandler）调用 `respondToApproval` 时 **comment 恒为
 * undefined**：卡片根本收不到自由文本。
 *
 * 所以规则是两半，各归其主：
 *   · 闸口声明这个选择 **requiresComment**（意思 / 结构）；
 *   · 渲染层根据目标通道 **approvalComment** 能力决定是否提供它，并提供替代文案
 *     （措辞由 dispatcher 按 locale 给，因为只有它知道收件人的语言）。
 *
 * 今天没有任何平台声明 approvalComment —— 所以外部 IM 卡片上不该出现「要求修改」，
 * 转而提示去 Markus 操作（应用内通知铃可以填意见，因此不受影响）。
 */
import { describe, it, expect } from 'vitest';
import { renderOutbound, renderCapabilitiesOf } from '../src/gateway/render.js';
import { notificationToOutbound } from '../src/gateway/dispatcher.js';
import { PLATFORM_MANIFESTS } from '../src/platforms/registry.js';

const reviewOptions = [
  { id: 'approve', label: 'Approve', direction: 'approve' },
  { id: 'reject', label: 'Request Changes', direction: 'request_changes', requiresComment: true },
];

function reviewMessage(locale: string) {
  return notificationToOutbound(
    { title: '待审核', body: 'b', metadata: { approvalId: 'apr_1', options: reviewOptions } },
    undefined,
    locale,
  );
}

describe('a choice that needs a written reason says so', () => {
  it('carries requiresComment and a localized note', () => {
    const msg = reviewMessage('zh-CN');
    expect(msg.actions!.find((a) => a.id === 'reject')!.requiresComment).toBe(true);
    expect(msg.commentRequiredNote).toContain('要求修改');
    expect(msg.commentRequiredNote).toContain('Markus');
    // …and the approve button never demands one.
    expect(msg.actions!.find((a) => a.id === 'approve')!.requiresComment).toBeUndefined();
  });

  it('leaves an approval with no such choice without a note', () => {
    const msg = notificationToOutbound(
      { title: 't', body: 'b', metadata: { approvalId: 'apr_1', options: [{ id: 'approve', label: 'Approve', direction: 'approve' }] } },
      undefined,
      'zh-CN',
    );
    expect(msg.commentRequiredNote).toBeUndefined();
  });
});

describe('a channel that cannot collect free text does not offer the choice', () => {
  it('withholds it on a card platform without approvalComment (today: every one)', () => {
    const rendered = renderOutbound(reviewMessage('zh-CN'), renderCapabilitiesOf({ cards: true }));
    expect(rendered.actions.map((a) => a.id)).toEqual(['approve']);
    // The message points at the surface that *can* take the reason…
    expect(rendered.body).toContain('Markus');
    // …and the button text is gone from the projection too, not just from the UI.
    expect(rendered.text).not.toContain('[要求修改]');
  });

  it('offers it when the channel declares it can collect the reason', () => {
    const rendered = renderOutbound(reviewMessage('zh-CN'), {
      ...renderCapabilitiesOf({ cards: true }),
      approvalComment: true,
    });
    expect(rendered.actions.map((a) => a.id)).toEqual(['approve', 'reject']);
    expect(rendered.body).toBe('b');
  });

  it('carries the note in the plain-text projection, for a text-only platform', () => {
    const rendered = renderOutbound(reviewMessage('en'), {});
    expect(rendered.format).toBe('text');
    expect(rendered.text).toContain('open Markus');
    expect(rendered.text).not.toContain('Request Changes');
  });

  it('maps the manifest capability through', () => {
    expect(renderCapabilitiesOf({ cards: true, approvalComment: true }).approvalComment).toBe(true);
    expect(renderCapabilitiesOf({ cards: true }).approvalComment).toBeUndefined();
    expect(renderCapabilitiesOf(undefined)).toEqual({});
  });
});

describe('no shipped platform claims it can collect an approval reason', () => {
  /**
   * A guard on the *claim*, not on the code: the day a platform starts declaring
   * `approvalComment`, this test goes red and whoever did it has to show that the
   * card really can capture free text — because a false claim here is exactly how a
   * reason-less 打回 gets back onto a card.
   */
  it('so the button is withheld everywhere until a card input is actually built', () => {
    const claiming = PLATFORM_MANIFESTS.filter((m) => m.capabilities.approvalComment).map((m) => m.id);
    expect(claiming).toEqual([]);
  });
});
