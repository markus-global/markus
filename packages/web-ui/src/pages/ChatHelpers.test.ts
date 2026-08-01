import { describe, expect, it } from 'vitest';
import {
  dedupeAdjacentUserMessages,
  isRememberActionVisible,
  stripEmbeddedReplyQuote,
  type ChatMsg,
} from './ChatHelpers.ts';

describe('stripEmbeddedReplyQuote', () => {
  it('strips legacy quote prefix when metadata matches', () => {
    const quoted = '生成成功！\n\n![x](/tmp/a.webp)\n\n看看效果';
    const content = `> **智能体**: ${quoted}\n\n将这个图片发到我的飞书。`;
    expect(stripEmbeddedReplyQuote(content, '智能体', quoted)).toBe('将这个图片发到我的飞书。');
  });

  it('leaves content unchanged when there is no matching prefix', () => {
    expect(stripEmbeddedReplyQuote('将这个图片发到我的飞书。', '智能体', 'hello')).toBe(
      '将这个图片发到我的飞书。',
    );
  });
});

describe('Remember action visibility (LEARNING-LOOP §9.1)', () => {
  it('B-ui-remember-action-on-dm-agent-bubble', () => {
    expect(isRememberActionVisible(true, 'agent')).toBe(true);
  });

  it('B-ui-remember-hidden-in-group-and-a2a', () => {
    expect(isRememberActionVisible(false, 'agent')).toBe(false);
    expect(isRememberActionVisible(undefined, 'agent')).toBe(false);
    expect(isRememberActionVisible(true, 'user')).toBe(false);
  });
});

describe('dedupeAdjacentUserMessages', () => {
  it('removes adjacent identical user bubbles', () => {
    const msgs: ChatMsg[] = [
      { id: '1', sender: 'user', text: '继续', time: '16:29', rawCreatedAt: '2026-07-27T08:29:30.000Z' },
      { id: '2', sender: 'user', text: '继续', time: '16:29', rawCreatedAt: '2026-07-27T08:29:31.000Z' },
      { id: '3', sender: 'agent', text: 'ok', time: '16:30', rawCreatedAt: '2026-07-27T08:30:00.000Z' },
    ];
    expect(dedupeAdjacentUserMessages(msgs).map(m => m.id)).toEqual(['1', '3']);
  });

  it('keeps identical user texts when an assistant turn is between them', () => {
    const msgs: ChatMsg[] = [
      { id: '1', sender: 'user', text: '继续', time: '16:29', rawCreatedAt: '2026-07-27T08:29:30.000Z' },
      { id: '2', sender: 'agent', text: 'done', time: '16:30', rawCreatedAt: '2026-07-27T08:30:00.000Z' },
      { id: '3', sender: 'user', text: '继续', time: '16:30', rawCreatedAt: '2026-07-27T08:30:55.000Z' },
    ];
    expect(dedupeAdjacentUserMessages(msgs).map(m => m.id)).toEqual(['1', '2', '3']);
  });
});
