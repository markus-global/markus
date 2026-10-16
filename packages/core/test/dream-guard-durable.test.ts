/**
 * Dream-cycle guard — durable (restart-surviving) "already ran this window" check.
 *
 * Root cause this locks down: the periodic memory-consolidation guard used to be
 * an in-memory, per-Agent-instance field (`lastDreamDate`). A process restart
 * re-armed it, so the same agent could dream again the same day (observed
 * 2026-10-15: two `memory_consolidation` runs 2.5 min apart across a restart).
 * The durable fact already exists — `memory-meta.json#lastConsolidatedAt` — it
 * just was not consulted. These cases pin the durable-window semantics.
 */
import { describe, it, expect } from 'vitest';
import {
  shouldRunDreamCycle,
  dreamWindowKey,
  MEMORY_DREAM_MAX_ENTRIES,
} from '../src/memory/dream-trigger.js';
import { MEMORY_DREAM_MIN_ENTRIES } from '@markus/shared';

const OVER = { observationPercent: 99, entryCount: 31 }; // clearly over budget

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

describe('shouldRunDreamCycle — durable dedup (the restart fix)', () => {
  const now = new Date('2026-10-15T23:13:10Z');

  it('a consolidation already recorded TODAY (durable) → skip, even on a fresh instance', () => {
    // Fresh process: in-memory key is empty, but memory-meta.json says today.
    expect(
      shouldRunDreamCycle({ ...OVER, now, lastConsolidatedAt: '2026-10-15T10:34:29.213Z', lastInMemoryWindowKey: '' }),
    ).toBe(false);
  });

  it('last consolidation was YESTERDAY → run today', () => {
    expect(
      shouldRunDreamCycle({ ...OVER, now, lastConsolidatedAt: '2026-10-14T10:25:24.778Z', lastInMemoryWindowKey: '' }),
    ).toBe(true);
  });

  it('never consolidated (null) → run', () => {
    expect(
      shouldRunDreamCycle({ ...OVER, now, lastConsolidatedAt: null, lastInMemoryWindowKey: '' }),
    ).toBe(true);
  });

  it('in-memory key already matches this window → skip (in-flight / same-process reentry)', () => {
    const key = dreamWindowKey(OVER.entryCount, now);
    expect(
      shouldRunDreamCycle({ ...OVER, now, lastConsolidatedAt: null, lastInMemoryWindowKey: key }),
    ).toBe(false);
  });

  it('bloated buffer: an EARLIER 6h bucket today does not block a later bucket', () => {
    const entryCount = MEMORY_DREAM_MAX_ENTRIES + 1;
    expect(
      shouldRunDreamCycle({
        observationPercent: 99,
        entryCount,
        now: new Date('2026-10-15T19:00:00Z'),
        lastConsolidatedAt: '2026-10-15T01:00:00Z', // earlier 6h bucket
        lastInMemoryWindowKey: '',
      }),
    ).toBe(true);
  });

  it('malformed durable timestamp is ignored (treated as never) → run', () => {
    expect(
      shouldRunDreamCycle({ ...OVER, now, lastConsolidatedAt: 'not-a-date', lastInMemoryWindowKey: '' }),
    ).toBe(true);
  });
});
