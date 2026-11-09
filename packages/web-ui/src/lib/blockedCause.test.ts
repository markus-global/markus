import { describe, it, expect } from 'vitest';
import { blockedReasonOf, BLOCKED_REASON_KEY } from './stateVocabulary.ts';
import { needsHumanDecision } from './blockedReason.ts';

describe('blocked cause — user-visible distinction', () => {
  it('maps each blocked reason to a distinct, user-facing label key', () => {
    expect(BLOCKED_REASON_KEY[blockedReasonOf('deps')]).toBe('waitingDeps');   // 等待依赖
    expect(BLOCKED_REASON_KEY[blockedReasonOf('hold')]).toBe('onHold');        // 已挂起
    expect(BLOCKED_REASON_KEY[blockedReasonOf('workflow')]).toBe('workflowPaused');
  });

  it('legacy/unknown reason falls back to deps (never fabricates "needs you")', () => {
    expect(blockedReasonOf(null)).toBe('deps');
    expect(blockedReasonOf('weird')).toBe('deps');
  });

  it('only hold needs the user; deps and workflow do not', () => {
    expect(needsHumanDecision({ blockedReason: 'hold', blockedBy: [] })).toBe(true);
    expect(needsHumanDecision({ blockedReason: 'deps', blockedBy: [] })).toBe(false);
    expect(needsHumanDecision({ blockedReason: 'workflow', blockedBy: [] })).toBe(false);
  });
});
