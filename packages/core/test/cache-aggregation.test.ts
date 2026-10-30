/**
 * Org-level cache metrics must be TOKEN-WEIGHTED, never a mean of per-agent
 * ratios — and "no measurement" must never be rendered as 0%.
 *
 * The `/api/usage` endpoint used to do `sum(stats.cacheHitRate) / allAgents.length`.
 * That is a mean of ratios, and it is wrong in both directions:
 *   - idle agents add 0 to the numerator but a full vote to the denominator, so
 *     one busy agent at 96% plus nine idle agents reports 9.6%;
 *   - one agent that moved 200M tokens weighs the same as one that made a single
 *     100-token call.
 *
 * Measured 2026-10-29, this is exactly the shape that made a 94–96% A2A burst
 * look like a catastrophe: the number on screen was not the hit rate.
 */

import { describe, it, expect } from 'vitest';
import { aggregateCacheHitRate, computeReplayRatio } from '../src/llm/provider-helpers.js';

describe('aggregateCacheHitRate — token-weighted', () => {
  it('ignores idle agents instead of letting them vote for 0%', () => {
    // One agent moved 1M tokens at 96%; nine agents never reported anything.
    const agents = [
      { cacheReadReported: 960_000, cacheDenominatorTotal: 1_000_000 },
      ...Array.from({ length: 9 }, () => ({ cacheReadReported: 0, cacheDenominatorTotal: 0 })),
    ];

    const r = aggregateCacheHitRate(agents);

    expect(r.cacheHitRate).toBeCloseTo(0.96, 5);
    expect(r.cacheHitSamples).toBe(1);
  });

  it('weights by volume, not by agent count', () => {
    // Big agent: 200M prompt at 95%. Small agent: 100 tokens, 0% hit.
    const agents = [
      { cacheReadReported: 190_000_000, cacheDenominatorTotal: 200_000_000 },
      { cacheReadReported: 0, cacheDenominatorTotal: 100 },
    ];

    const r = aggregateCacheHitRate(agents);

    // A mean of ratios would report 47.5%; the truth is ~95%.
    expect(r.cacheHitRate).toBeGreaterThan(0.94);
    expect(r.cacheHitRate).toBeLessThan(0.96);
  });

  it('returns null (not 0) when nothing was measured', () => {
    const r = aggregateCacheHitRate([
      { cacheReadReported: 0, cacheDenominatorTotal: 0 },
      { cacheReadReported: 0, cacheDenominatorTotal: 0 },
    ]);

    expect(r.cacheHitRate).toBeNull();
    expect(r.cacheHitSamples).toBe(0);
  });

  it('is exactly 0 (not null) when something was measured and missed', () => {
    const r = aggregateCacheHitRate([{ cacheReadReported: 0, cacheDenominatorTotal: 50_000 }]);

    expect(r.cacheHitRate).toBe(0);
    expect(r.cacheHitSamples).toBe(1);
  });

  it('never exceeds 1 even if a provider over-reports reads', () => {
    const r = aggregateCacheHitRate([{ cacheReadReported: 2_000, cacheDenominatorTotal: 1_000 }]);
    expect(r.cacheHitRate).toBe(1);
  });
});

describe('computeReplayRatio', () => {
  it('reports prompt tokens re-sent per output token', () => {
    // The measured GEO A2A burst: 218M prompt -> 0.7M output.
    expect(computeReplayRatio(218_000_000, 700_000)).toBeCloseTo(311.43, 1);
  });

  it('returns null when output is zero (ratio undefined, not infinite)', () => {
    expect(computeReplayRatio(1_000_000, 0)).toBeNull();
  });

  it('returns null when nothing was measured', () => {
    expect(computeReplayRatio(0, 0)).toBeNull();
  });
});
