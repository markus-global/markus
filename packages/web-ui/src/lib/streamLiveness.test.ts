import { describe, expect, it } from 'vitest';
import { sessionHasLiveStream, shouldPaintStreamingBubble } from './streamLiveness.ts';

describe('sessionHasLiveStream — membership 只认确切 session，不认通配', () => {
  const PLACEHOLDER = '__new_chat__';

  it('matches the exact session that is streaming', () => {
    expect(sessionHasLiveStream(new Set(['s1', 's2']), 's2')).toBe(true);
  });

  it('does NOT match a different session of the same agent (no wildcard)', () => {
    // 回归守卫：曾用 `has(PLACEHOLDER) ||` 当通配 —— 一条「新会话」的流会把该 agent
    // 的**每个** tab 都点亮成「输出中」。placeholder 是一个 id，不是一个选择器。
    expect(sessionHasLiveStream(new Set([PLACEHOLDER]), 's_real')).toBe(false);
    expect(sessionHasLiveStream(new Set(['s_other']), 's_real')).toBe(false);
  });

  it('still matches when the view IS the placeholder (a brand-new chat is streaming)', () => {
    expect(sessionHasLiveStream(new Set([PLACEHOLDER]), PLACEHOLDER)).toBe(true);
  });

  it('is false for unknown / empty inputs rather than throwing', () => {
    expect(sessionHasLiveStream(undefined, 's1')).toBe(false);
    expect(sessionHasLiveStream(new Set(['s1']), null)).toBe(false);
    expect(sessionHasLiveStream(new Set(['s1']), undefined)).toBe(false);
    expect(sessionHasLiveStream(new Set(['s1']), '')).toBe(false);
  });
});

describe('shouldPaintStreamingBubble — 「还在输出」的边框只由权威活流决定', () => {
  it('paints while the view has a live stream and the bubble is streaming', () => {
    expect(shouldPaintStreamingBubble({
      msgIsStreaming: true, liveStreamForView: true,
    })).toBe(true);
  });

  it('does NOT paint from a persisted isStreaming copy alone (the stale-tail bug)', () => {
    // 回归守卫：服务端会把「传输断开时的中途快照」连同 metadata.isStreaming 一起持久化。
    // 切到该会话时 DB 回填把这条带回来 → 只有边框、没有内容的空气泡。
    expect(shouldPaintStreamingBubble({
      msgIsStreaming: true, liveStreamForView: false,
    })).toBe(false);
  });

  it('does NOT paint from a transiently stale local sending flag (the mid-switch frame)', () => {
    // 实测：切会话那一拍 `sending` 还残留着上一个视图的值。若把它当所有权证据，
    // 新 tab 的最后一条消息会在这一帧被画上边框、150ms 后才被权威内容替换。
    expect(shouldPaintStreamingBubble({
      msgIsStreaming: true, liveStreamForView: false,
    })).toBe(false);
  });

  it('never paints for a non-streaming message', () => {
    expect(shouldPaintStreamingBubble({
      msgIsStreaming: false, liveStreamForView: true,
    })).toBe(false);
    expect(shouldPaintStreamingBubble({
      msgIsStreaming: false, liveStreamForView: false,
    })).toBe(false);
  });
});
