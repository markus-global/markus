import { describe, it, expect } from 'vitest';
import { shouldSweepGhostStreaming } from '../src/pages/ChatHelpers.ts';

/**
 * The ghost-streaming sweep lands `isStreaming: false` on live bubbles — it
 * kills the animated "outputting" border and the running-tool segments while the
 * backend keeps generating. These cases pin down the two authorities it reads,
 * and specifically the regression where the buffer-manager phase (authoritative,
 * and deliberately still 'streaming' while a SIBLING tab of the same agent is
 * live) was not consulted, so a stale/coarse signal swept a live bubble.
 */
const base = {
  chatMode: 'direct' as const,
  hasAgent: true,
  sending: false,
  streamingVisual: false,
  chatStoreStreaming: false,
  convPhase: 'ready' as const,
  hasStreamingTail: true,
};

describe('shouldSweepGhostStreaming', () => {
  it('sweeps a genuine ghost: nothing live anywhere, bubble still flagged', () => {
    expect(shouldSweepGhostStreaming(base)).toBe(true);
  });

  it('REGRESSION: manager says the conversation is streaming → never sweep', () => {
    // Both derived signals say "idle" (the sibling-tab case: one turn ended and
    // its cleanup dropped the coarse signals), yet the buffer manager knows a
    // stream is still live for this conversation. The manager must win — this is
    // the exact case where the border used to vanish mid-turn.
    expect(shouldSweepGhostStreaming({
      ...base,
      chatStoreStreaming: false,
      sending: false,
      streamingVisual: false,
      convPhase: 'streaming',
      hasStreamingTail: true,
    })).toBe(false);
  });

  it('does not sweep while the view is sending', () => {
    expect(shouldSweepGhostStreaming({ ...base, sending: true })).toBe(false);
  });

  it('does not sweep while the preview streaming visual is on', () => {
    expect(shouldSweepGhostStreaming({ ...base, streamingVisual: true })).toBe(false);
  });

  it('does not sweep while chatStore still reports the agent as streaming', () => {
    expect(shouldSweepGhostStreaming({ ...base, chatStoreStreaming: true })).toBe(false);
  });

  it('does nothing without a flagged bubble (no ghost to sweep)', () => {
    expect(shouldSweepGhostStreaming({ ...base, hasStreamingTail: false })).toBe(false);
  });

  it('is a direct-mode-only concern', () => {
    expect(shouldSweepGhostStreaming({ ...base, chatMode: 'channel' })).toBe(false);
    expect(shouldSweepGhostStreaming({ ...base, chatMode: 'dm' })).toBe(false);
  });

  it('does nothing without a selected agent', () => {
    expect(shouldSweepGhostStreaming({ ...base, hasAgent: false })).toBe(false);
  });

  it('still sweeps once the turn really is over (phase collapsed to ready)', () => {
    // Guard against over-fixing: the phase veto must not strand a real ghost.
    for (const convPhase of ['ready', 'idle'] as const) {
      expect(shouldSweepGhostStreaming({ ...base, convPhase })).toBe(true);
    }
  });
});
