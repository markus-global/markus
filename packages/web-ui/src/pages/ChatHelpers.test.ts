import { describe, expect, it } from 'vitest';
import {
  dedupeAdjacentUserMessages,
  dbMsgToChat,
  insertChatMsgByCreatedAt,
  isRememberActionVisible,
  pickStreamReattachTarget,
  stripEmbeddedReplyQuote,
  stripNotifyContext,
  type ChatMsg,
} from './ChatHelpers.ts';
import type { ChatMessageInfo } from '../api.ts';

describe('stripNotifyContext', () => {
  it('strips notify_context comment and extracts priority', () => {
    const raw = '雷达发现：AREX\n\n<!-- notify_context: priority=low -->';
    const { cleaned, priority } = stripNotifyContext(raw);
    expect(cleaned).toBe('雷达发现：AREX');
    expect(cleaned).not.toContain('notify_context');
    expect(priority).toBe('low');
  });

  it('dbMsgToChat strips notify_context from text segments (not only msg.text)', () => {
    const m = {
      id: 'msg_1',
      sessionId: 'sess_1',
      agentId: 'agt_1',
      role: 'assistant',
      content: 'Summary\n\n<!-- notify_context: priority=low -->',
      tokensUsed: 0,
      createdAt: '2026-08-02T07:04:00.000Z',
      metadata: {
        notifyUser: true,
        priority: 'low',
        segments: [
          { type: 'text', content: 'Summary\n\n<!-- notify_context: priority=low -->' },
        ],
      },
    } as ChatMessageInfo;
    const chat = dbMsgToChat(m);
    expect(chat.text).not.toContain('notify_context');
    expect(chat.isNotification).toBe(true);
    expect(chat.notifyPriority).toBe('low');
    const textSeg = chat.segments?.find(s => s.type === 'text');
    expect(textSeg && textSeg.type === 'text' ? textSeg.content : '').not.toContain('notify_context');
  });
});

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

describe('insertChatMsgByCreatedAt', () => {
  it('inserts an older notify before a newer in-flight bubble', () => {
    const newer: ChatMsg = {
      id: 'stream_1',
      sender: 'agent',
      text: 'thinking…',
      time: '15:35',
      rawCreatedAt: '2026-08-02T07:35:00.000Z',
    };
    const older: ChatMsg = {
      id: 'notify_1',
      sender: 'agent',
      text: '通知系统测试',
      time: '15:34',
      rawCreatedAt: '2026-08-02T07:34:00.000Z',
      isNotification: true,
    };
    const result = insertChatMsgByCreatedAt([newer], older);
    expect(result.map((m) => m.id)).toEqual(['notify_1', 'stream_1']);
  });

  it('appends when message is newest', () => {
    const a: ChatMsg = {
      id: 'a', sender: 'user', text: 'hi', time: '15:33', rawCreatedAt: '2026-08-02T07:33:00.000Z',
    };
    const b: ChatMsg = {
      id: 'b', sender: 'agent', text: 'ok', time: '15:34', rawCreatedAt: '2026-08-02T07:34:00.000Z',
    };
    expect(insertChatMsgByCreatedAt([a], b).map((m) => m.id)).toEqual(['a', 'b']);
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

describe('pickStreamReattachTarget', () => {
  const mk = (id: string, sender: 'user' | 'agent', text: string, extra: Partial<ChatMsg> = {}): ChatMsg =>
    ({ id, sender, text, time: '12:00', ...extra });

  it('returns the streaming agent bubble', () => {
    const msgs = [
      mk('u1', 'user', 'A'),
      mk('a1', 'agent', 'B'),
      mk('u2', 'user', 'C'),
      mk('a2', 'agent', 'partial D', { isStreaming: true }),
    ];
    expect(pickStreamReattachTarget(msgs)?.id).toBe('a2');
  });

  it('returns an empty in-flight placeholder bubble', () => {
    const msgs = [
      mk('u1', 'user', 'A'),
      mk('a1', 'agent', 'B'),
      mk('u2', 'user', 'C'),
      mk('a2', 'agent', '', { isStreaming: true }),
    ];
    expect(pickStreamReattachTarget(msgs)?.id).toBe('a2');
  });

  it('NEVER reuses a previous turn completed reply when the in-flight bubble is gone', () => {
    // Regression: after user clicked stop on turn D (empty bubble removed),
    // reattach used to pick the LAST agent message = previous reply B and
    // streamed D into it — history became [A, D-streaming, C].
    const msgs = [
      mk('u1', 'user', 'A'),
      mk('a1', 'agent', 'B (completed previous reply)'),
      mk('u2', 'user', 'C'),
    ];
    expect(pickStreamReattachTarget(msgs)).toBeUndefined();
  });

  it('returns undefined when last agent message is a completed reply even if older agents are streaming', () => {
    const msgs = [
      mk('u1', 'user', 'A'),
      mk('a0', 'agent', 'older still streaming?', { isStreaming: true }),
      mk('a1', 'agent', 'B completed'),
    ];
    expect(pickStreamReattachTarget(msgs)).toBeUndefined();
  });

  it('treats error replies as completed (never reused as reattach target)', () => {
    const msgs = [
      mk('u1', 'user', 'A'),
      mk('a1', 'agent', '⚠ error', { isError: true }),
    ];
    expect(pickStreamReattachTarget(msgs)).toBeUndefined();
  });
});
