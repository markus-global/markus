/**
 * Dream-cycle guard — the durable (restart-surviving) "already ran this window" check.
 *
 * Root cause this locks down: the periodic memory-consolidation guard used to be
 * an in-memory, per-Agent-instance field (`lastDreamDate`). A process restart
 * re-armed it, so the same agent could dream again the same day (observed
 * 2026-10-15: two `memory_consolidation` runs 2.5 min apart across a restart).
 *
 * DR3 (2026-11-15) — the durable fact is now TYPED (`memory-meta.json#dream` =
 * `{ at, windowKey }`), and the guard compares the stored window key as a STRING. These
 * cases pin the trigger half of that contract; `dream-typed-events.test.ts` pins the
 * writer/store half (organize cannot satisfy the guard, failure is retryable, migration).
 */
import { describe, it, expect } from 'vitest';
import {
  shouldRunDreamCycle,
  dreamWindowKey,
  dayWindowKey,
  MEMORY_DREAM_MAX_ENTRIES,
} from '../src/memory/dream-trigger.js';
import type { DreamRecord } from '../src/memory/types.js';
import { MEMORY_DREAM_MIN_ENTRIES } from '@markus/shared';

const OVER = { observationPercent: 99, entryCount: 31 }; // clearly over budget

/** A dream record whose window key is the calendar day of `at` (the normal-buffer case). */
function dreamAt(atIso: string): DreamRecord {
  return { at: atIso, windowKey: dayWindowKey(new Date(atIso)) };
}

describe('dreamWindowKey — daily, or 6h-bucketed when the buffer is bloated', () => {
  it('normal buffer (< max entries) → the calendar day', () => {
    const a = dreamWindowKey(10, new Date('2026-10-15T01:00:00Z'));
    const b = dreamWindowKey(10, new Date('2026-10-15T23:00:00Z'));
    expect(a).toBe('2026-10-15');
    expect(b).toBe('2026-10-15');
  });

  it('bloated buffer (> max entries) → day + 6h bucket, so up to 4x/day', () => {
    const b0 = dreamWindowKey(MEMORY_DREAM_MAX_ENTRIES + 1, new Date('2026-10-15T01:00:00Z'));
    const b1 = dreamWindowKey(MEMORY_DREAM_MAX_ENTRIES + 1, new Date('2026-10-15T07:00:00Z'));
    expect(b0).not.toBe(b1);
    expect(b0.startsWith('2026-10-15')).toBe(true);
  });
});

describe('shouldRunDreamCycle — pressure only when no clock supplied (back-compat)', () => {
  it('below both thresholds → never', () => {
    expect(shouldRunDreamCycle({ observationPercent: 5, entryCount: 5 })).toBe(false);
    expect(shouldRunDreamCycle({ observationPercent: 10, entryCount: MEMORY_DREAM_MIN_ENTRIES - 1 })).toBe(false);
  });

  it('over either threshold → runs (no dedup fields supplied)', () => {
    expect(shouldRunDreamCycle(OVER)).toBe(true);
    expect(shouldRunDreamCycle({ observationPercent: 10, entryCount: MEMORY_DREAM_MIN_ENTRIES })).toBe(true);
  });
});

describe('shouldRunDreamCycle — durable dedup on the typed dream record (the restart fix)', () => {
  const now = new Date('2026-10-15T23:13:10Z');

  it('a dream already recorded TODAY (fresh process, no in-flight run) → skip', () => {
    expect(
      shouldRunDreamCycle({ ...OVER, now, dream: dreamAt('2026-10-15T10:34:29.213Z') }),
    ).toBe(false);
  });

  it('the recorded window was YESTERDAY → run today', () => {
    expect(
      shouldRunDreamCycle({ ...OVER, now, dream: dreamAt('2026-10-14T10:25:24.778Z') }),
    ).toBe(true);
  });

  it('never dreamt (null) → run', () => {
    expect(shouldRunDreamCycle({ ...OVER, now, dream: null })).toBe(true);
  });

  it('no dream field at all (no meta file) → run', () => {
    expect(shouldRunDreamCycle({ ...OVER, now })).toBe(true);
  });

  it('bloated buffer: an EARLIER 6h bucket today does not block a later bucket', () => {
    const entryCount = MEMORY_DREAM_MAX_ENTRIES + 1;
    const earlierKey = dreamWindowKey(entryCount, new Date('2026-10-15T01:00:00Z'));
    expect(
      shouldRunDreamCycle({
        observationPercent: 99,
        entryCount,
        now: new Date('2026-10-15T19:00:00Z'),
        dream: { at: '2026-10-15T01:00:00Z', windowKey: earlierKey },
      }),
    ).toBe(true);
  });

  it('a record with NO window key (untyped/legacy shape) cannot cancel a dream → run', () => {
    // Conservative by construction: the guard compares strings, so a missing key never
    // matches. A record like this can only cost one extra dream, never a skipped one.
    expect(
      shouldRunDreamCycle({ ...OVER, now, dream: { at: '2026-10-15T10:34:29.213Z', windowKey: '' } }),
    ).toBe(true);
  });

  it('the same window is already IN FLIGHT in this process → skip', () => {
    const key = dreamWindowKey(OVER.entryCount, now);
    expect(
      shouldRunDreamCycle({ ...OVER, now, dream: null, dreamInFlightKey: key }),
    ).toBe(false);
  });

  it('an in-flight run from ANOTHER window does not block this one', () => {
    const otherKey = dreamWindowKey(OVER.entryCount, new Date('2026-10-14T10:00:00Z'));
    expect(
      shouldRunDreamCycle({ ...OVER, now, dream: null, dreamInFlightKey: otherKey }),
    ).toBe(true);
  });

  it('the window key is compared as a fact, never re-derived from `at`', () => {
    // A bloated buffer records `2026-10-15_58...`; a record carrying only the day key
    // (`2026-10-15`, e.g. migrated from a legacy instant) must NOT match — the stored
    // string IS the fact, so no timestamp arithmetic can make these two agree.
    const entryCount = MEMORY_DREAM_MAX_ENTRIES + 1;
    const nowBloated = new Date('2026-10-15T10:00:00Z');
    expect(
      shouldRunDreamCycle({
        observationPercent: 99,
        entryCount,
        now: nowBloated,
        dream: { at: nowBloated.toISOString(), windowKey: dayWindowKey(nowBloated) },
      }),
    ).toBe(true);
  });
});
