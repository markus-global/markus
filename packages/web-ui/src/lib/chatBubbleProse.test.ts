import { describe, expect, it } from 'vitest';
import { bubbleHasProse, shouldPaintStreamingRing } from './chatBubbleProse.ts';

describe('bubbleHasProse', () => {
  // ── 回归：只有工具调用的长回合不该给气泡画光环（2026-10-18 老板截图报的 bug）──
  // 旧行为不看正文，只要这轮在流式就给整列宽的气泡套一圈光环 →
  // 一轮「102 步工具调用、零正文」在界面上是一个几乎空的大方框。
  it('is false while a turn has only tool/thinking segments', () => {
    expect(bubbleHasProse({
      segments: [
        { type: 'tool', content: 'shell_execute' },
        { type: 'thinking', content: '查一下 CI 日志' },
      ],
    })).toBe(false);
  });

  it('is false for a tool segment that carries a result but no prose', () => {
    // 工具结果很长的回合最容易骗过「非空即正文」这种判据。
    expect(bubbleHasProse({
      segments: [{ type: 'tool', content: 'x'.repeat(5000) }],
    })).toBe(false);
  });

  it('is true as soon as a text segment has content', () => {
    expect(bubbleHasProse({
      segments: [
        { type: 'tool', content: 'shell_execute' },
        { type: 'text', content: 'CI 绿了。' },
      ],
    })).toBe(true);
  });

  it('ignores whitespace-only text segments', () => {
    expect(bubbleHasProse({ segments: [{ type: 'text', content: '  \n\t ' }] })).toBe(false);
  });

  it('reads committedSegments (snapshot/history path)', () => {
    expect(bubbleHasProse({
      committedSegments: [{ type: 'text', content: '已完成的部分' }],
    })).toBe(true);
  });

  it('reads legacy `text` for messages that have no segments at all', () => {
    expect(bubbleHasProse({ text: '老消息正文' })).toBe(true);
    expect(bubbleHasProse({ text: '   ' })).toBe(false);
    expect(bubbleHasProse({})).toBe(false);
  });
});

describe('shouldPaintStreamingRing', () => {
  // 这是「空方框」bug 的唯一开关：旧实现是 `live` 一个条件就画，于是零正文的长回合
  // 在整列宽的容器上画出一圈光环 = 一个几乎空的大方框。
  it('does NOT paint the ring for a live tool-only agent bubble', () => {
    expect(shouldPaintStreamingRing({ live: true, sender: 'agent', hasProse: false })).toBe(false);
  });

  it('paints the ring once the turn has prose', () => {
    expect(shouldPaintStreamingRing({ live: true, sender: 'agent', hasProse: true })).toBe(true);
  });

  it('never paints the ring on a user bubble or a finished turn', () => {
    expect(shouldPaintStreamingRing({ live: true, sender: 'user', hasProse: true })).toBe(false);
    expect(shouldPaintStreamingRing({ live: false, sender: 'agent', hasProse: true })).toBe(false);
  });
});
