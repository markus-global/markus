/**
 * Compaction TIMING — the economic signal, separate from window pressure.
 *
 * `[CONTEXT n% used]` answers "will the request still fit". This answers "does
 * compacting pay for itself". They are different invariants and must never be
 * collapsed into one number: a session at 63% of a 1M window was measured as
 * 78.3% of the org's entire prompt spend (2026-10-29).
 *
 * Model (derivation: the `Compaction TIMING` block in src/context-budget.ts):
 *   r(h) = h·c_hit + (1−h)·c_miss
 *   K    = P'·c_miss − P·r(h) + S·c_out      one-time cost
 *   Δ    = f·P·r(h)                          saving per later call
 *   compact ⟺ K ≤ 0  ∨  K/Δ ≤ N
 *
 * Contract locked here:
 *   1. h=0 ⇒ always compact (an uncached prompt is pure cost, no penalty).
 *   2. High h raises the bar — a big prompt is CHEAP when it is cached.
 *   3. `m(h) = c_miss/r(h) ∈ [1, 5]`, so `f* < 4/N`: there is no such thing as
 *      "hit rate so good I should never compact".
 *   4. No measurement ⇒ null (silence), never a guess.
 *   5. The agent-facing line carries the ACTION and the lever, never numbers.
 */

import { describe, it, expect } from 'vitest';
import {
  compactionGuidance,
  compactionActionLine,
  estimateCompactionFractions,
  shouldEmitCompactionHint,
  COMPACTION_PRICE,
} from '../src/context-budget.js';

const P = 580_000; // a real long-session prompt (measured 2026-10-29)

describe('compactionGuidance — economics of compacting now', () => {
  it('always compacts when nothing is cached (penalty is ~0)', () => {
    const g = compactionGuidance({ promptTokens: P, hitRate: 0, fEst: 0.1, nEst: 1 });
    expect(g).not.toBeNull();
    expect(g!.action).toBe('compact');
    // Uncached: one-time penalty is negative — you even save on the first call.
    expect(g!.params.oneTimePenaltyUsd).toBeLessThanOrEqual(0);
  });

  it('holds when a high hit rate makes a small trim uneconomic', () => {
    // h=0.95 => blended price is 4x cheaper than a miss, so paying one full
    // re-bill to save 5% of the prompt is a loss.
    const g = compactionGuidance({ promptTokens: P, hitRate: 0.95, fEst: 0.05, nEst: 1 });
    expect(g!.action).toBe('hold');
    expect(g!.params.paybackCalls).toBeGreaterThan(1);
  });

  it('compacts when the trim is deep enough to pay back immediately', () => {
    // f=65% measured on the 2026-10-29 session; payback ≈ 0.7 calls.
    const g = compactionGuidance({ promptTokens: P, hitRate: 0.95, fEst: 0.65, nEst: 1 });
    expect(g!.action).toBe('compact');
    expect(g!.params.paybackCalls).toBeLessThan(1);
  });

  it('a larger horizon lowers the bar (same f flips hold → compact)', () => {
    const h = 0.95;
    const short = compactionGuidance({ promptTokens: P, hitRate: h, fEst: 0.12, nEst: 2 });
    const long = compactionGuidance({ promptTokens: P, hitRate: h, fEst: 0.12, nEst: 40 });
    expect(short!.action).toBe('hold');
    expect(long!.action).toBe('compact');
    expect(long!.params.fStar).toBeLessThan(short!.params.fStar);
  });

  it('m(h) is bounded by c_miss/c_hit, so f* never exceeds 4/N', () => {
    for (const h of [0.5, 0.9, 0.99, 0.999]) {
      const g = compactionGuidance({ promptTokens: P, hitRate: h, fEst: 0.3, nEst: 10 });
      expect(g!.params.fStar).toBeLessThan(4 / 10);
    }
  });

  it('returns null (silence) when the inputs cannot support a decision', () => {
    expect(compactionGuidance({ promptTokens: 0, hitRate: 0.9, fEst: 0.5, nEst: 5 })).toBeNull();
    expect(compactionGuidance({ promptTokens: P, hitRate: Number.NaN, fEst: 0.5, nEst: 5 })).toBeNull();
    expect(compactionGuidance({ promptTokens: P, hitRate: 0.9, fEst: 0, nEst: 5 })).toBeNull();
    expect(compactionGuidance({ promptTokens: P, hitRate: 0.9, fEst: 0.5, nEst: 0 })).toBeNull();
  });

  it('is deterministic (cache-friendly: same input ⇒ same verdict)', () => {
    const a = compactionGuidance({ promptTokens: P, hitRate: 0.93, fEst: 0.4, nEst: 7 });
    const b = compactionGuidance({ promptTokens: P, hitRate: 0.93, fEst: 0.4, nEst: 7 });
    expect(a).toEqual(b);
  });

  it('uses the measured DeepSeek ratio: cache hit is 1/5 of a miss', () => {
    expect(COMPACTION_PRICE.hitPerToken / COMPACTION_PRICE.missPerToken).toBeCloseTo(0.2, 10);
  });
});

describe('estimateCompactionFractions — the two proxy quantities', () => {
  const base = {
    promptTokens: 650_000,
    totalChars: 800_000,
    recentChars: 40_000, // last 40 messages are 5% of the prompt
    callsThisTurn: 20,
  };

  it('nEst reflects THIS turn\'s progress, not calls-per-turn', () => {
    // The first version used calls/turns and produced nEst=1 on a session that
    // was visibly mid-flight (`fEst:0.95, nEst:1` in the real 2026-10-29 log).
    const { nEst } = estimateCompactionFractions(base);
    expect(nEst).toBe(20);
  });

  it('nEst is at least 1 even before any call in the turn', () => {
    expect(estimateCompactionFractions({ ...base, callsThisTurn: 0 }).nEst).toBe(1);
  });

  it('nEst is capped so an unbounded horizon cannot justify any trim', () => {
    expect(estimateCompactionFractions({ ...base, callsThisTurn: 999 }).nEst).toBe(50);
  });

  it('fEst SUBTRACTS the summary that compaction has to write', () => {
    const withSummary = estimateCompactionFractions(base).fEst;
    const withoutSummary = estimateCompactionFractions({ ...base, summaryTokens: 0 }).fEst;
    // Keeping 5% of chars ⇒ 0.95 before accounting for the anchor summary.
    expect(withoutSummary).toBeCloseTo(0.95, 2);
    // The summary is re-sent on every later call, so it eats into the benefit.
    expect(withSummary).toBeLessThan(withoutSummary);
  });

  it('fEst stays in [0, 0.95] and never divides by zero', () => {
    expect(estimateCompactionFractions({ ...base, totalChars: 0 }).fEst).toBe(0);
    expect(estimateCompactionFractions({ ...base, recentChars: 0 }).fEst).toBeLessThanOrEqual(0.95);
    expect(estimateCompactionFractions({ ...base, recentChars: base.totalChars }).fEst).toBe(0);
  });

  it('feeds the guidance so a mid-flight turn clears the bar', () => {
    const { fEst, nEst } = estimateCompactionFractions(base);
    const g = compactionGuidance({
      promptTokens: base.promptTokens,
      hitRate: 0.93,
      fEst,
      nEst,
      summaryTokens: 3000,
    });
    // With 20 calls expected ahead, even a moderate trim pays back within the turn.
    expect(g!.params.fStar).toBeLessThan(0.25);
  });
});

describe('shouldEmitCompactionHint — first, flip, re-arm', () => {
  it('ALWAYS emits the first time (nothing said yet)', () => {
    expect(shouldEmitCompactionHint({ action: 'hold', callIndex: 1 })).toBe(true);
    expect(shouldEmitCompactionHint({ action: 'compact', callIndex: 1 })).toBe(true);
  });

  it('emits when the verdict FLIPS', () => {
    const prev = { verdict: 'hold' as const, emittedAtCall: 1 };
    expect(shouldEmitCompactionHint({ previous: prev, action: 'compact', callIndex: 2 })).toBe(true);
  });

  it('stays silent while the verdict is unchanged and not stale', () => {
    const prev = { verdict: 'compact' as const, emittedAtCall: 1 };
    expect(shouldEmitCompactionHint({ previous: prev, action: 'compact', callIndex: 5, rearmCalls: 20 })).toBe(false);
  });

  it('re-states the same verdict once it goes stale (re-arm)', () => {
    const prev = { verdict: 'compact' as const, emittedAtCall: 1 };
    expect(shouldEmitCompactionHint({ previous: prev, action: 'compact', callIndex: 21, rearmCalls: 20 })).toBe(true);
  });

  it('a seeded-but-never-computed verdict must not swallow the first real one', () => {
    // Regression guard: the shipped version seeded `'hold'` from the "no
    // measurement" branch without ever deciding anything, so the first genuine
    // `'hold'` looked unchanged and disappeared.
    const neverDecided = { verdict: undefined, emittedAtCall: 0 };
    expect(shouldEmitCompactionHint({ previous: neverDecided, action: 'hold', callIndex: 3 })).toBe(true);
  });
});

describe('compactionActionLine — action only, never arithmetic', () => {
  it('names the lever ONLY when there is an action to take', () => {
    const compact = compactionActionLine('compact');
    expect(compact).toContain('session');
    expect(compact).toContain("operation:'compact'");

    // "hold" has no lever by definition — the correct action is to keep going.
    const hold = compactionActionLine('hold');
    expect(hold).toMatch(/keep going|not worth/i);
  });

  it('carries no arithmetic in either direction', () => {
    for (const action of ['compact', 'hold'] as const) {
      const line = compactionActionLine(action);
      // No blended price, no ratios, no payback counts, no formula symbols.
      expect(line).not.toMatch(/\d+\.\d+%/);
      expect(line).not.toMatch(/\$\d/);
      expect(line).not.toMatch(/\bf\*|\bm\(h\)|N\*/);
    }
  });

  it('tells the agent what to DO in both directions', () => {
    expect(compactionActionLine('compact')).toContain("operation:'compact'");
    // "Don't compact" is a legitimate, useful conclusion — it must be sayable.
    expect(compactionActionLine('hold')).toMatch(/keep going|not worth/i);
  });
});
