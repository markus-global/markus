import { describe, expect, it } from 'vitest';
import {
  appendTextToSegments,
  appendThinkingToSegments,
  dedupeAdjacentUserMessages,
  dbMsgToChat,
  finalizeAgentMessage,
  finalizeLastInterruptedAgent,
  finalizeStreamEnd,
  finalizeLastStreamingBubble,
  formatSmartTime,
  hasStreamingTail,
  insertChatMsgByCreatedAt,
  isRememberActionVisible,
  msgHasContent,
  pickStreamReattachTarget,
  stopRunningTools,
  stripEmbeddedReplyQuote,
  stripNotifyContext,
  stripThinkingBlocks,
  resolveTeamChatShortcut,
  cycleSessionTabId,
  COMPOSER_MAX_LINES,
  composerMaxHeightPx,
  composerStacked,
  composerToolbarAlign,
  resolveMobileTeamLayerState,
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

describe('message finalization helpers', () => {
  const agentMsg = (id: string, text = '', opts: Partial<ChatMsg> = {}) =>
    ({ id, sender: 'agent', text, time: '12:00', ...opts }) as ChatMsg;

  it('msgHasContent detects text / text segments / tool segments / thinking', () => {
    expect(msgHasContent(agentMsg('a', 'hi'))).toBe(true);
    expect(msgHasContent(agentMsg('a', '  '))).toBe(false);
    expect(msgHasContent(agentMsg('a', '', { segments: [{ type: 'tool', key: 'k', tool: 't', status: 'done' }] }))).toBe(true);
    expect(msgHasContent(agentMsg('a', '', { segments: [{ type: 'text', content: 'x', thinking: '' }] }))).toBe(true);
    expect(msgHasContent(agentMsg('a', '', { segments: [{ type: 'text', content: '', thinking: 'deep think' }] }))).toBe(true);
  });

  it('finalizeAgentMessage("stopped") drops an empty bubble (empty-reply rule)', () => {
    expect(finalizeAgentMessage(agentMsg('a'), 'stopped')).toBeNull();
  });

  it('finalizeAgentMessage("stopped") keeps content and marks stopped + tools stopped', () => {
    const msg = agentMsg('a', 'partial', {
      isStreaming: true,
      segments: [{ type: 'tool', key: 'k', tool: 'shell', status: 'running' }],
    });
    const out = finalizeAgentMessage(msg, 'stopped')!;
    expect(out.isStopped).toBe(true);
    expect(out.isStreaming).toBe(false);
    expect(out.isError).toBeFalsy();
    expect(out.segments![0]).toMatchObject({ status: 'stopped' });
  });

  it('finalizeAgentMessage("error") marks isError', () => {
    const out = finalizeAgentMessage(agentMsg('a', 'boom'), 'error')!;
    expect(out.isError).toBe(true);
    expect(out.isStopped).toBe(true);
  });

  it('finalizeAgentMessage("done") clears stopped/error flags', () => {
    const out = finalizeAgentMessage(agentMsg('a', 'ok', { isStopped: true, isError: true, isStreaming: true }), 'done')!;
    expect(out.isStopped).toBe(false);
    expect(out.isError).toBe(false);
    expect(out.isStreaming).toBe(false);
  });

  it('finalizeLastInterruptedAgent marks the LAST in-flight agent, splicing empty ones', () => {
    const msgs = [
      agentMsg('a0', 'completed'),
      agentMsg('a1', 'older empty'),
      agentMsg('a2', 'partial', { isStreaming: true }),
    ];
    const out = finalizeLastInterruptedAgent(msgs);
    expect(out.map(m => m.id)).toEqual(['a0', 'a1', 'a2']);
    expect(out[2]!.isStopped).toBe(true);
    // a0 (completed) untouched
    expect(out[0]!.isStopped).toBeFalsy();
  });

  it('finalizeLastInterruptedAgent splices an EMPTY in-flight bubble', () => {
    const msgs = [
      agentMsg('a0', 'completed'),
      agentMsg('a2', '', { isStreaming: true }),
    ];
    const out = finalizeLastInterruptedAgent(msgs);
    expect(out.map(m => m.id)).toEqual(['a0']);
  });

  it('finalizeLastInterruptedAgent does not touch a stopped/error bubble', () => {
    const msgs = [
      agentMsg('a0', 'already stopped', { isStopped: true }),
      agentMsg('a1', 'error', { isError: true }),
    ];
    expect(finalizeLastInterruptedAgent(msgs)).toEqual(msgs);
  });

  it('stopRunningTools returns same ref when nothing is running', () => {
    const segs = [{ type: 'tool' as const, key: 'k', tool: 't', status: 'done' as const }];
    expect(stopRunningTools(segs)).toBe(segs);
  });

  it('finalizeStreamEnd lands isStreaming:false + stops running tools (terminal convergence)', () => {
    // Regression: the direct-send() completion paths used to leave the
    // placeholder (isStreaming: true) untouched → perpetual "thinking…" bubble.
    const msgs = [agentMsg('a0', 'ok', {
      isStreaming: true,
      segments: [{ type: 'tool', key: 'k', tool: 'shell', status: 'running' }],
    })];
    const out = finalizeStreamEnd(msgs, 'a0');
    expect(out[0]!.isStreaming).toBe(false);
    expect(out[0]!.segments![0]).toMatchObject({ status: 'stopped' });
  });

  it('finalizeStreamEnd is idempotent — no-op when already finalized', () => {
    const msgs = [agentMsg('a0', 'done', { isStreaming: false })];
    expect(finalizeStreamEnd(msgs, 'a0')).toBe(msgs);
  });

  it('finalizeLastStreamingBubble finalizes the in-flight bubble, never a completed reply', () => {
    const msgs = [
      agentMsg('a0', 'completed', { isStopped: false }),
      agentMsg('a1', 'partial', { isStreaming: true }),
    ];
    const out = finalizeLastStreamingBubble(msgs);
    expect(out[1]!.isStopped).toBe(true);
    expect(out[1]!.isStreaming).toBe(false);
    // completed reply untouched
    expect(out[0]!.isStopped).toBeFalsy();
  });

  it('finalizeLastStreamingBubble splices an empty in-flight bubble', () => {
    const msgs = [
      agentMsg('a0', 'completed'),
      agentMsg('a1', '', { isStreaming: true }),
    ];
    expect(finalizeLastStreamingBubble(msgs).map(m => m.id)).toEqual(['a0']);
  });

  it('finalizeLastStreamingBubble returns same ref when nothing is in flight', () => {
    const msgs = [agentMsg('a0', 'done'), agentMsg('a1', 'err', { isError: true })];
    expect(finalizeLastStreamingBubble(msgs)).toBe(msgs);
  });

  it('hasStreamingTail detects a live streaming bubble in the tail', () => {
    const msgs = [
      agentMsg('a0', 'done'),
      agentMsg('a1', 'streaming…', { isStreaming: true }),
    ];
    expect(hasStreamingTail(msgs)).toBe(true);
  });

  it('hasStreamingTail ignores stopped / error bubbles', () => {
    const msgs = [
      agentMsg('a0', 'stopped', { isStreaming: true, isStopped: true }),
      agentMsg('a1', 'err', { isError: true }),
    ];
    expect(hasStreamingTail(msgs)).toBe(false);
  });

  it('hasStreamingTail respects lookback window', () => {
    const old = agentMsg('a_old', 'still streaming far up', { isStreaming: true });
    const tail = [agentMsg('a1', 'done'), agentMsg('a2', 'done')];
    // old is beyond the default 8-window from the end
    const msgs = [old, ...tail];
    expect(hasStreamingTail(msgs)).toBe(true); // within 8
    expect(hasStreamingTail(msgs, 2)).toBe(false); // only last 2 scanned
  });

  describe('stripThinkingBlocks', () => {
    it('keeps plain English prose containing the word "thinking" intact (regression)', () => {
      // Regression: the old regex / thinking[\s\S]*?(<\/think>|$)/ matched the bare
      // word "thinking" in ordinary text and deleted everything to the end of the
      // string — making complete replies look truncated.
      const text = "I was thinking about the design, and the final answer is yes.";
      expect(stripThinkingBlocks(text)).toBe(text);
    });

    it('strips complete <thinking>…</thinking> blocks (new stream format)', () => {
      const text = "前言\n<thinking>deep reasoning part</thinking>\n正文内容";
      expect(stripThinkingBlocks(text)).toBe("前言\n\n正文内容");
    });

    it('strips legacy chunk-split " thinking"…"</thinking>" blocks with no angle brackets', () => {
      const text = "答 thinking internal reasoning </thinking> 结果";
      expect(stripThinkingBlocks(text).replace(/\s+/g, ' ').trim()).toBe("答 结果");
    });

    it('strips legacy blocks closed with </think> (single t)', () => {
      const text = "开始\n<thinking>old format</think>\n结尾";
      expect(stripThinkingBlocks(text)).toContain("开始");
      expect(stripThinkingBlocks(text)).toContain("结尾");
      expect(stripThinkingBlocks(text)).not.toContain("old format");
    });

    it('leaves an unclosed <thinking> block as-is (does not swallow the rest)', () => {
      // No closing tag → must NOT truncate the remainder of the reply.
      const text = "思考中<thinking>仍 在输出";
      expect(stripThinkingBlocks(text)).toBe(text);
    });
  });
});

// ─── Structured stream segment appenders ──────────────────────────────────────
// Thinking and answer prose are separate fields on the text segment. These
// appenders are the only writers during streaming, so a regression here shows up
// as reasoning leaking into the answer (or vanishing) in the live bubble.

describe('appendThinkingToSegments / appendTextToSegments', () => {
  it('merges reasoning into the trailing text segment without touching content', () => {
    const segs = appendThinkingToSegments([{ type: 'text', content: '', createdAt: 't0' }], '先想一下');
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ type: 'text', content: '', thinking: '先想一下' });
    // createdAt of the in-flight segment must be preserved (ordering authority).
    expect(segs[0]!.createdAt).toBe('t0');
  });

  it('concatenates consecutive reasoning chunks into one thinking block', () => {
    let segs = appendThinkingToSegments([], '第一段');
    segs = appendThinkingToSegments(segs, '第二段');
    expect(segs).toHaveLength(1);
    expect((segs[0] as { thinking?: string }).thinking).toBe('第一段第二段');
  });

  it('merges answer prose into the trailing text segment without touching thinking', () => {
    let segs = appendThinkingToSegments([], '推理');
    segs = appendTextToSegments(segs, '答');
    segs = appendTextToSegments(segs, '案');
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ content: '答案', thinking: '推理' });
  });

  it('starts a new text segment after a tool row (text/tool interleaving)', () => {
    const withTool = [
      { type: 'text' as const, content: '前' },
      { type: 'tool' as const, key: 't1', tool: 'shell_execute', status: 'done' as const },
    ];
    const segs = appendTextToSegments(withTool, '后');
    expect(segs).toHaveLength(3);
    expect(segs[2]).toMatchObject({ type: 'text', content: '后' });
    expect((segs[2] as { thinking?: string }).thinking).toBeUndefined();
  });

  it('is a no-op for empty chunks (keeps the array ref for React)', () => {
    const segs = [{ type: 'text' as const, content: 'x' }];
    expect(appendThinkingToSegments(segs, '')).toBe(segs);
    expect(appendTextToSegments(segs, '')).toBe(segs);
  });

  it('never writes reasoning into the answer content (no inline markup)', () => {
    const segs = appendThinkingToSegments([], '内心独白');
    const only = segs[0] as { content: string };
    expect(only.content).toBe('');
    expect(only.content).not.toContain('内心独白');
  });
});

describe('formatSmartTime', () => {
  // Agent 推送多条消息时常落在同一分钟内；只有到秒的显示才能明确先后顺序。
  const noonOn = (daysAgo: number) => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysAgo, 12, 0, 0).toISOString();
  };

  it('shows seconds for today so same-minute messages stay distinguishable', () => {
    const res = formatSmartTime('', new Date().toISOString(), { yesterday: 'Yesterday' });
    expect(res).toMatch(/^\d{1,2}:\d{2}:\d{2}$/);
  });

  it('keeps seconds for yesterday, prefixed with the label', () => {
    const res = formatSmartTime('', noonOn(1), { yesterday: 'Yesterday' });
    expect(res).toMatch(/^Yesterday \d{1,2}:\d{2}:\d{2}$/);
  });

  it('keeps seconds for older messages, prefixed with the date', () => {
    const res = formatSmartTime('', noonOn(3), { yesterday: 'Yesterday' });
    expect(res).toMatch(/\d{1,2}:\d{2}:\d{2}$/);
  });
});

// ─── Team-chat keyboard shortcuts (需求 4+5) ───────────────────────────────────

describe('resolveTeamChatShortcut', () => {
  const ev = (partial: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>) => ({
    key: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false,
    ...partial,
  });

  it('Mac: Cmd+N → new-conversation; Ctrl+N alone → null', () => {
    expect(resolveTeamChatShortcut(ev({ key: 'n', metaKey: true }), true)).toBe('new-conversation');
    expect(resolveTeamChatShortcut(ev({ key: 'N', metaKey: true }), true)).toBe('new-conversation');
    expect(resolveTeamChatShortcut(ev({ key: 'n', ctrlKey: true }), true)).toBeNull();
  });

  it('non-Mac: Ctrl+N → new-conversation; Meta+N alone → null', () => {
    expect(resolveTeamChatShortcut(ev({ key: 'n', ctrlKey: true }), false)).toBe('new-conversation');
    expect(resolveTeamChatShortcut(ev({ key: 'n', metaKey: true }), false)).toBeNull();
  });

  it('alt / shift modifiers suppress new-conversation', () => {
    expect(resolveTeamChatShortcut(ev({ key: 'n', ctrlKey: true, altKey: true }), false)).toBeNull();
    expect(resolveTeamChatShortcut(ev({ key: 'n', ctrlKey: true, shiftKey: true }), false)).toBeNull();
  });

  it('Ctrl+Tab → cycle forward; Ctrl+Shift+Tab → cycle backward (Ctrl on all platforms)', () => {
    expect(resolveTeamChatShortcut(ev({ key: 'Tab', ctrlKey: true }), false)).toBe('cycle-session-next');
    expect(resolveTeamChatShortcut(ev({ key: 'Tab', ctrlKey: true }), true)).toBe('cycle-session-next');
    expect(resolveTeamChatShortcut(ev({ key: 'Tab', ctrlKey: true, shiftKey: true }), false)).toBe('cycle-session-prev');
  });

  it('plain Tab / other keys → null', () => {
    expect(resolveTeamChatShortcut(ev({ key: 'Tab' }), false)).toBeNull();
    expect(resolveTeamChatShortcut(ev({ key: 't', ctrlKey: true }), false)).toBeNull();
    expect(resolveTeamChatShortcut(ev({ key: '' }), true)).toBeNull();
  });
});

describe('cycleSessionTabId', () => {
  const ids = ['a', 'b', 'c'];

  it('moves forward and backward from the active tab', () => {
    expect(cycleSessionTabId(ids, 'b', 1)).toBe('c');
    expect(cycleSessionTabId(ids, 'b', -1)).toBe('a');
  });

  it('wraps around at both ends', () => {
    expect(cycleSessionTabId(ids, 'c', 1)).toBe('a');
    expect(cycleSessionTabId(ids, 'a', -1)).toBe('c');
  });

  it('falls back to first/last when the active id is unknown', () => {
    expect(cycleSessionTabId(ids, null, 1)).toBe('a');
    expect(cycleSessionTabId(ids, null, -1)).toBe('c');
    expect(cycleSessionTabId(ids, 'zzz', 1)).toBe('a');
    expect(cycleSessionTabId(ids, 'zzz', -1)).toBe('c');
  });

  it('returns null when there are fewer than two tabs', () => {
    expect(cycleSessionTabId(['only'], 'only', 1)).toBeNull();
    expect(cycleSessionTabId([], null, 1)).toBeNull();
  });
});

// ─── Composer sizing & layout (需求 6+7) ──────────────────────────────────────

describe('composerMaxHeightPx', () => {
  it('budgets ~10 lines of input (max >= 10 × line-height + padding)', () => {
    expect(COMPOSER_MAX_LINES).toBe(10);
    // 23px/line × 10 + 24px expanded vertical padding = 254px
    expect(composerMaxHeightPx(false)).toBe(254);
    // compact variant uses tighter 12px padding → 242px
    expect(composerMaxHeightPx(true)).toBe(242);
  });

  it('never returns a value below 10 full lines of readable text', () => {
    const lineHeight = 23; // text-sm leading-relaxed ≈ 22.75
    expect(composerMaxHeightPx(false) - 24).toBeGreaterThanOrEqual(10 * lineHeight);
    expect(composerMaxHeightPx(true) - 12).toBeGreaterThanOrEqual(10 * lineHeight);
  });

  it('expanded allows strictly more height than compact', () => {
    expect(composerMaxHeightPx(false)).toBeGreaterThan(composerMaxHeightPx(true));
  });
});

describe('composerStacked', () => {
  it('mobile narrow screens always stack controls under the input (模型选择器让位)', () => {
    expect(composerStacked(true, false)).toBe(true);
    expect(composerStacked(true, true)).toBe(true);
  });

  it('desktop keeps a single row while the composer is empty', () => {
    expect(composerStacked(false, false)).toBe(false);
  });

  it('desktop stacks once the user starts composing (attach/text expands)', () => {
    expect(composerStacked(false, true)).toBe(true);
  });
});

describe('composerToolbarAlign (model selector + send row)', () => {
  it('right-aligns the control row whenever it is a full-width stacked row', () => {
    expect(composerToolbarAlign(true)).toBe('justify-end');
  });

  it('adds no alignment when the row is content-sized inside a single flex row', () => {
    // Un-stacked, the control row is the last child of a shared flex row, so it
    // already rests at the right edge; adding justify-end there would be a no-op
    // anyway, but keeping it empty documents that the layout does not depend on it.
    expect(composerToolbarAlign(false)).toBe('');
  });

  it('right-aligns an EMPTY mobile composer (regression: buttons drifted bottom-left)', () => {
    // The bug: alignment was keyed on `composerExpanded` (has content), but on
    // mobile the composer is ALWAYS stacked. So an empty input produced a
    // full-width row with no justify-end, and the model picker + send button
    // hugged the left edge instead of the bottom-right corner.
    const isMobile = true;
    const isEmpty = false; // composerExpanded === false when the input is empty
    expect(composerToolbarAlign(composerStacked(isMobile, isEmpty))).toBe('justify-end');
  });

  it('right-aligns on desktop too once the user starts typing', () => {
    expect(composerToolbarAlign(composerStacked(false, true))).toBe('justify-end');
  });
});

describe('resolveMobileTeamLayerState (mobile L2 blank-page guard)', () => {
  const teams = ['team_a', 'team_b'];

  it('renders the detail when the team resolves', () => {
    expect(resolveMobileTeamLayerState('team_a', teams, true)).toBe('detail');
  });

  it('reports loading - NOT missing - while the team list has not loaded', () => {
    // The distinction is the whole point: `teams` starts as [] on a cold mount,
    // so absent-while-unloaded must NOT be read as "this team is gone".
    expect(resolveMobileTeamLayerState('team_a', [], false)).toBe('loading');
  });

  it('renders the detail whenever the team is present, even if the flag is unset', () => {
    // Presence wins over the loaded flag: a team we can actually find is
    // resolvable, so there is nothing to recover from.
    expect(resolveMobileTeamLayerState('team_a', teams, false)).toBe('detail');
  });

  it('reports missing only after a successful load proves the id is unknown', () => {
    expect(resolveMobileTeamLayerState('team_gone', teams, true)).toBe('missing');
    // An empty but successful response is still a definitive answer.
    expect(resolveMobileTeamLayerState('team_a', [], true)).toBe('missing');
  });

  it('treats a null/undefined id as missing rather than crashing the layer', () => {
    expect(resolveMobileTeamLayerState(null, teams, true)).toBe('missing');
    expect(resolveMobileTeamLayerState(undefined, teams, true)).toBe('missing');
    expect(resolveMobileTeamLayerState('', teams, true)).toBe('missing');
  });

  it('never returns a state that leaves the page with nothing to render', () => {
    // Regression: the L2 block used to `return null` when the team was absent.
    // Because that layer also hides the roster and skips the chat area, the page
    // body went completely blank AND the back button went with it - the user saw
    // an empty Team page and could not get out. Every input must now map to a
    // state the UI can draw.
    const inputs: Array<[string | null | undefined, string[], boolean]> = [
      ['team_a', teams, true],
      ['team_x', teams, true],
      ['team_x', [], false],
      [null, [], false],
      [undefined, teams, false],
    ];
    for (const [id, ids, loaded] of inputs) {
      const state = resolveMobileTeamLayerState(id, ids, loaded);
      expect(['detail', 'loading', 'missing']).toContain(state);
    }
  });
});
