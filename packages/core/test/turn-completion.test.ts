import { describe, it, expect } from 'vitest';
import { decideTurnReply, shouldComposeAnswer } from '../src/turn-completion.js';

/**
 * Regression target (2026-10-18): a DM turn ran out of budget mid-refactor. The
 * continuation executed 24 tool iterations, then concatenated 15 narration fragments
 * and posted the blob as the reply, which was delivered to the peer as a message and
 * burned a whole turn on their side.
 *
 * Contract under test: only an ANSWER may cross the turn boundary; narration never does.
 */
describe('decideTurnReply', () => {
  const narration =
    '核实完 BUG-1～4 全部代码事实。继续施工。先看创建路径已有的校验收敛点：';

  it('delivers the final response when the turn produced one', () => {
    const r = decideTurnReply({
      finalText: '已修好，PR #12。',
      reply: narration,
      endTurnRequested: true,
      continuationDidWork: true,
    });
    expect(r).toEqual({ text: '已修好，PR #12。', completed: true });
  });

  it('never glues narration onto the answer (the 2026-10-18 blob)', () => {
    const r = decideTurnReply({
      finalText: '已修好，PR #12。',
      reply: narration,
      endTurnRequested: true,
      composedAnswer: 'composed',
      continuationDidWork: true,
    });
    expect(r.text).toBe('已修好，PR #12。');
    expect(r.text).not.toContain('继续施工');
  });

  it('accepts the turn text when the turn declared itself done', () => {
    const r = decideTurnReply({
      reply: '收到，我核完就回。',
      endTurnRequested: true,
      continuationDidWork: true,
    });
    expect(r).toEqual({ text: '收到，我核完就回。', completed: true });
  });

  it('lets the turn text stand when the close-out changed nothing', () => {
    const r = decideTurnReply({
      reply: 'Today I reviewed PRs and fixed bugs.',
      endTurnRequested: false,
      continuationDidWork: false,
    });
    expect(r).toEqual({ text: 'Today I reviewed PRs and fixed bugs.', completed: true });
  });

  it('refuses to ship narration from a turn that was still working — the actual bug', () => {
    const r = decideTurnReply({
      reply: narration,
      endTurnRequested: false,
      continuationDidWork: true,
    });
    expect(r.completed).toBe(false);
    expect(r.text).toBe('');
  });

  it('uses a deliberately composed answer instead of narration', () => {
    const r = decideTurnReply({
      reply: narration,
      endTurnRequested: false,
      composedAnswer: '动了两处代码，还没跑测试。',
      continuationDidWork: true,
    });
    expect(r).toEqual({ text: '动了两处代码，还没跑测试。', completed: true });
  });

  it('treats an empty end_turn turn as answered-but-empty (no retry loop)', () => {
    const r = decideTurnReply({ reply: '   ', endTurnRequested: true, continuationDidWork: true });
    expect(r).toEqual({ text: '', completed: true });
  });
});

describe('shouldComposeAnswer', () => {
  it('composes only when work happened and no answer exists', () => {
    expect(shouldComposeAnswer({ endTurnRequested: false, continuationDidWork: true })).toBe(true);
    expect(shouldComposeAnswer({ finalText: '  ', endTurnRequested: false, continuationDidWork: true })).toBe(true);
  });

  it('does not compose when a final response, an explicit end, or an idle close-out exists', () => {
    expect(shouldComposeAnswer({ finalText: 'done', endTurnRequested: false, continuationDidWork: true })).toBe(false);
    expect(shouldComposeAnswer({ endTurnRequested: true, continuationDidWork: true })).toBe(false);
    expect(shouldComposeAnswer({ endTurnRequested: false, continuationDidWork: false })).toBe(false);
  });
});
