/**
 * 「这个选项还需要文字」必须一路传达到渠道（2026-10-28 事故回归）。
 *
 * 链路：agent 的 `questions[].options[].requires_freeform`
 *      → ApprovalOption.requiresFreeform
 *      → OutboundAction.requiresFreeform（dispatcher）
 *      → 收不到文字的渠道**不提供这个按钮**，并换一句话告诉人去应用里回答（renderer）。
 *
 * 事故现场：飞书只能点、不能填，卡片却把「直接给你数字」当成了同意/拒绝之一，
 * 点下去就成了「批准」，数字永远没到 agent 手上。
 */

import { describe, it, expect } from 'vitest';
import { notificationToOutbound } from '../src/gateway/dispatcher.js';
import { renderOutbound } from '../src/gateway/render.js';

const notification = {
  type: 'approval_request' as const,
  title: 'Free 层数量上限：给我数字，或回「不公示」',
  body: '公开源查不到，需要你拍一个口径。',
  metadata: {
    approvalId: 'apr_free_quota',
    options: [
      { id: 'give_numbers', label: '直接给你数字', requiresFreeform: true },
      { id: 'no_publish', label: '不公示' },
    ],
  },
};

describe('dispatcher：requiresFreeform 随选项一起出站', () => {
  it('选项上的 requiresFreeform 不被丢掉，并附带「请到应用内回答」的说明', () => {
    const msg = notificationToOutbound(notification as never, 'secret', 'zh-CN');
    const byId = Object.fromEntries((msg.actions ?? []).map(a => [a.id, a]));
    expect(byId['give_numbers']?.requiresFreeform).toBe(true);
    expect(byId['no_publish']?.requiresFreeform).toBeUndefined();
    expect(msg.freeformRequiredNote, '缺了这句，人类只会看到按钮消失').toBeTruthy();
  });
});

describe('renderer：收不到文字的渠道不提供该按钮', () => {
  const msg = notificationToOutbound(notification as never, 'secret', 'zh-CN');

  it('纯点击渠道（无 approvalComment）→ 收起该选项，正文说明去哪回答', () => {
    const rendered = renderOutbound(msg, { cards: true, buttons: true, approvalComment: false });
    const ids = (rendered.actions ?? []).map(a => a.id);
    expect(ids).not.toContain('give_numbers');
    expect(ids).toContain('no_publish');
    expect(rendered.body).toContain('Markus 应用');
  });

  it('能收集文字的渠道 → 两个选项都在', () => {
    const rendered = renderOutbound(msg, { cards: true, buttons: true, approvalComment: true });
    const ids = (rendered.actions ?? []).map(a => a.id);
    expect(ids).toContain('give_numbers');
    expect(ids).toContain('no_publish');
  });
});

describe('一次点击答不完的请求（多问题 / 多选 / 文本题）→ 不发「同意/拒绝」', () => {
  const formNotification = {
    type: 'approval_request' as const,
    title: 'Free 层三个上限',
    body: '需要 Agent / Team / Project 三个数字。',
    metadata: {
      approvalId: 'apr_form',
      formOnly: true,
      // 多问题请求没有顶层 options —— 旧实现会在这里发明 同意/拒绝。
      questions: [
        { id: 'q1', prompt: 'Agent 上限？', inputType: 'text' },
        { id: 'q2', prompt: 'Team 上限？', inputType: 'text' },
      ],
    },
  };

  it('不给任何按钮，并说明去应用内回答', () => {
    const outbound = notificationToOutbound(formNotification as never, 'secret', 'zh-CN');
    expect(outbound.actions, '一张表单不能被一个按钮“批准”').toBeUndefined();
    expect(outbound.body).toContain('Markus 应用');
  });

  it('渲染后同样没有动作行（纯文本卡片也不撒谎）', () => {
    const outbound = notificationToOutbound(formNotification as never, 'secret', 'zh-CN');
    const rendered = renderOutbound(outbound, { cards: true, buttons: true, approvalComment: false });
    expect(rendered.actions ?? []).toHaveLength(0);
    expect(rendered.body).toContain('Markus 应用');
  });

  it('普通审批（无 questions）仍然有同意/拒绝', () => {
    const binary = notificationToOutbound({
      type: 'approval_request' as const,
      title: '批准这个需求？',
      body: 'b',
      metadata: { approvalId: 'apr_binary' },
    } as never, 'secret', 'zh-CN');
    const ids = (binary.actions ?? []).map(a => a.id);
    expect(ids).toContain('approve');
    expect(ids).toContain('reject');
  });
});
