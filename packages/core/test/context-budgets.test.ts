/**
 * Budget arithmetic and truncation honesty.
 *
 * The reserve bug this pins: 384,000 tokens were withheld from the window for an
 * output that measured at most 2,607 across sampled calls, while the wire value
 * was 32,768. Reserving the catalog ceiling instead of the actual ask shrank the
 * usable window by 37% and made every water-level reading look better than it was.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveOutputReserve,
  omittedNotice,
  isPlausibleReported,
  truncateWithNotice,
  OUTPUT_RESERVE_FLOOR,
  OUTPUT_RESERVE_P99_HEADROOM,
} from '../src/context-budgets.js';

describe('resolveOutputReserve', () => {
  it('does not reserve the catalog ceiling just because it is the ceiling', () => {
    const reserve = resolveOutputReserve({ catalogMaxOutput: 384_000, configuredMaxTokens: 32_768 });
    expect(reserve).toBe(32_768);
  });

  it('never goes below what we actually send on the wire', () => {
    // A small P99 must NOT shrink the reserve under the wire cap.
    const reserve = resolveOutputReserve({
      catalogMaxOutput: 384_000,
      configuredMaxTokens: 32_768,
      observedP99: 1_000,
    });
    expect(reserve).toBe(32_768);
  });

  it('grows above the wire cap when real output exceeds it', () => {
    const reserve = resolveOutputReserve({
      catalogMaxOutput: 384_000,
      configuredMaxTokens: 8_192,
      observedP99: 20_000,
    });
    expect(reserve).toBe(Math.ceil(20_000 * OUTPUT_RESERVE_P99_HEADROOM));
  });

  it('never exceeds the catalog ceiling', () => {
    const reserve = resolveOutputReserve({
      catalogMaxOutput: 16_384,
      configuredMaxTokens: 32_768,
      observedP99: 40_000,
    });
    expect(reserve).toBe(16_384);
  });

  it('falls back to the floor when nothing is known (thin telemetry, unknown model)', () => {
    expect(resolveOutputReserve({})).toBe(OUTPUT_RESERVE_FLOOR);
  });

  it('with no catalog ceiling, the ask wins (an unknown model must not zero the reserve)', () => {
    const reserve = resolveOutputReserve({ configuredMaxTokens: 16_000 });
    expect(reserve).toBe(16_000);
  });

  it('frees the window the ceiling was eating', () => {
    const window = 1_000_000;
    const before = window - 384_000;
    const after = window - resolveOutputReserve({ catalogMaxOutput: 384_000, configuredMaxTokens: 32_768 });
    expect(after - before).toBe(351_232);
    expect(after / before).toBeGreaterThan(1.5);
  });
});

describe('omittedNotice', () => {
  it('says nothing when the list is complete', () => {
    expect(omittedNotice(5, 5, 'use task_list')).toBeUndefined();
    expect(omittedNotice(5, 3, 'use task_list')).toBeUndefined();
  });

  it('states how many are hidden and how to get them', () => {
    const notice = omittedNotice(15, 23, 'use `task_list` for the full board');
    expect(notice).toContain('8 more');
    expect(notice).toContain('task_list');
  });
});

describe('isPlausibleReported', () => {
  it('accepts a report within estimator drift (measured ~1.15x)', () => {
    expect(isPlausibleReported(296_356, 258_583)).toBe(true);
  });

  it('rejects a report from another call/session — the 1.84x and 0.31x cases', () => {
    // Observed on this machine: 574,880 reported against a 316,070 pack, and
    // 98,657 against a 503,814 pack. Both made the water level meaningless.
    expect(isPlausibleReported(574_880, 316_070)).toBe(false);
    expect(isPlausibleReported(98_657, 503_814)).toBe(false);
  });

  it('treats missing/zero readings as unusable rather than as a measurement', () => {
    expect(isPlausibleReported(undefined, 100_000)).toBe(false);
    expect(isPlausibleReported(0, 100_000)).toBe(false);
    expect(isPlausibleReported(100, 0)).toBe(false);
  });
});

describe('truncateWithNotice', () => {
  it('leaves short text untouched', () => {
    expect(truncateWithNotice('short', 100, 'read the file')).toEqual({ text: 'short', truncated: false });
  });

  it('announces the cut and how to recover, instead of ending mid-sentence', () => {
    const { text, truncated } = truncateWithNotice('x'.repeat(1000), 100, 'read PROJECT.md');
    expect(truncated).toBe(true);
    expect(text).toContain('900');
    expect(text).toContain('read PROJECT.md');
    expect(text).toContain('not shown');
  });
});
