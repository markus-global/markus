/**
 * DR3 — `memory-meta.json` records TWO TYPED EVENTS, not one bare instant.
 *
 * Why (docs/design/c8-residual-mechanisms-2026-11-15.md §3.2/§4.3): `lastConsolidatedAt`
 * was written by BOTH the dream cycle and the manual `memory_organize` tool, and the dream
 * guard read it as the boolean "has today's dream run?". One predicate answered two
 * questions, the writer was not the event the reader asked about, and a 09:00 manual tidy
 * silently cancelled the day's dream.
 *
 * These cases pin the four invariants at the WRITER level:
 *   1. event typing            — `recordDream()` / `recordOrganize()` each write their own field;
 *   2. arm-after-success       — only a completed run is recorded, and a failed write is REPORTED
 *                                (`false`) instead of being swallowed (see also the agent test);
 *   3. the key is the fact     — the stored `windowKey` is what the writer computed, never rebuilt;
 *   4. writes must be visible  — `recordDream()` returns false when the record is not on disk.
 * Plus: the legacy bare-instant file is migrated once (conservatively, as a dream), and the
 * REPORT-ONLY `getLastConsolidatedAt()` = max(dream, organized) keeps supplying
 * `api-server` / the 「上次整理 N 天前」 banner.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryStore } from '../src/memory/store.js';
import { shouldRunDreamCycle, dreamWindowKey, dayWindowKey } from '../src/memory/dream-trigger.js';

/** Clearly over the trigger threshold (`observationPercent` 99 ≫ MEMORY_DREAM_TRIGGER_PERCENT). */
const OVER = { observationPercent: 99, entryCount: 31 };

let dir: string;

const metaPath = () => join(dir, 'memory-meta.json');
const readMeta = () => JSON.parse(readFileSync(metaPath(), 'utf-8')) as Record<string, unknown>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'markus-dr3-meta-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('DR3 invariant 1 — two events, two writers, one file', () => {
  it('manual organize does NOT satisfy the dream window guard (the headline inverse)', () => {
    const store = new MemoryStore(dir);
    const now = new Date();

    store.recordOrganize(now);

    // The organize IS recorded …
    expect(store.getOrganizedRecord()).toEqual({ at: now.toISOString() });
    // … and it is NOT a dream, so today's pressured window still demands a dream.
    expect(store.getDreamRecord()).toBeNull();
    expect(
      shouldRunDreamCycle({ ...OVER, now, dream: store.getDreamRecord() }),
    ).toBe(true);
  });

  it('a dream record satisfies the guard — and the same window then stops a second dream', () => {
    const store = new MemoryStore(dir);
    const now = new Date();
    const windowKey = dreamWindowKey(OVER.entryCount, now);

    expect(store.recordDream(windowKey, now)).toBe(true);

    const dream = store.getDreamRecord();
    expect(dream).toEqual({ at: now.toISOString(), windowKey });
    expect(shouldRunDreamCycle({ ...OVER, now, dream })).toBe(false);
  });

  it('each writer writes ONLY its own field (organize after a dream does not erase the dream)', () => {
    const store = new MemoryStore(dir);
    const dreamAt = new Date('2026-11-15T03:33:50Z');
    const organizeAt = new Date('2026-11-15T09:00:00Z');

    store.recordDream('2026-11-15', dreamAt);
    store.recordOrganize(organizeAt);

    expect(store.getDreamRecord()).toEqual({ at: dreamAt.toISOString(), windowKey: '2026-11-15' });
    expect(store.getOrganizedRecord()).toEqual({ at: organizeAt.toISOString() });
    // …and the guard still sees the DREAM, not the later organize.
    expect(
      shouldRunDreamCycle({ ...OVER, now: new Date('2026-11-15T10:00:00Z'), dream: store.getDreamRecord() }),
    ).toBe(false);
  });

  it('the on-disk shape carries the typed events and no bare instant', () => {
    const store = new MemoryStore(dir);
    store.recordDream('2026-11-15', new Date('2026-11-15T03:33:50Z'));
    store.recordOrganize(new Date('2026-11-15T09:00:00Z'));

    const meta = readMeta();
    expect(meta['schemaVersion']).toBe(2);
    expect(meta['dream']).toEqual({ at: '2026-11-15T03:33:50.000Z', windowKey: '2026-11-15' });
    expect(meta['organized']).toEqual({ at: '2026-11-15T09:00:00.000Z' });
    expect(meta['lastConsolidatedAt']).toBeUndefined();
  });
});

describe('DR3 invariant 3 — the stored key is the fact', () => {
  it('a bloated-window key is stored verbatim (never rebuilt from the timestamp)', () => {
    const store = new MemoryStore(dir);
    const at = new Date('2026-11-15T07:05:00Z');
    const bloatedKey = dreamWindowKey(1000, at); // `2026-11-15_<bucket>`
    expect(bloatedKey).not.toBe(dayWindowKey(at));

    store.recordDream(bloatedKey, at);

    expect(readMeta()['dream']).toMatchObject({ windowKey: bloatedKey });
    expect(store.getDreamRecord()?.windowKey).toBe(bloatedKey);
    // Same window ⇒ deduped …
    expect(
      shouldRunDreamCycle({ observationPercent: 99, entryCount: 1000, now: at, dream: store.getDreamRecord() }),
    ).toBe(false);
    // … and the key is not recomputed with a DIFFERENT entry count later: a non-bloated
    // buffer at the same instant asks for the day key, which the stored key does not match.
    expect(
      shouldRunDreamCycle({ observationPercent: 99, entryCount: 10, now: at, dream: store.getDreamRecord() }),
    ).toBe(true);
  });
});

describe('DR3 invariant 4 — a write that did not land must not look like a write', () => {
  it('recordDream() refuses an empty window key (would look armed, dedup nothing)', () => {
    const store = new MemoryStore(dir);
    expect(store.recordDream('')).toBe(false);
    expect(existsSync(metaPath())).toBe(false); // nothing written at all
  });

  it('recordDream() returns false when the file cannot be written, and reads then say "never"', () => {
    // A directory at the record path makes the atomic write fail at rename time.
    mkdirSync(metaPath(), { recursive: true });
    const store = new MemoryStore(dir);

    expect(store.recordDream('2026-11-15')).toBe(false);
    expect(store.getDreamRecord()).toBeNull();
    // "Not recorded" therefore means RETRY, not "ran but forgotten".
    expect(shouldRunDreamCycle({ ...OVER, now: new Date('2026-11-15T10:00:00Z'), dream: store.getDreamRecord() }))
      .toBe(true);
  });
});

describe('DR3 migration — a legacy bare instant becomes a dream record (conservative)', () => {
  it('reads the legacy `lastConsolidatedAt` as a dream record keyed by its calendar day', () => {
    const legacyAt = '2026-11-15T03:33:50.026Z';
    writeFileSync(metaPath(), JSON.stringify({ lastConsolidatedAt: legacyAt }), 'utf-8');

    const store = new MemoryStore(dir);
    const dream = store.getDreamRecord();

    expect(dream).toEqual({ at: legacyAt, windowKey: '2026-11-15' });
    // Conservative: the upgrade must NOT cancel today's dedup (the machine dreamt at 03:33).
    expect(
      shouldRunDreamCycle({ ...OVER, now: new Date('2026-11-15T10:00:00Z'), dream }),
    ).toBe(false);
  });

  it('writes a one-time migration marker: typed shape, legacy field removed', () => {
    writeFileSync(metaPath(), JSON.stringify({ lastConsolidatedAt: '2026-11-15T03:33:50.026Z' }), 'utf-8');

    const store = new MemoryStore(dir);
    store.getDreamRecord(); // a read triggers the one-time upgrade

    const meta = readMeta();
    expect(meta['schemaVersion']).toBe(2);
    expect(meta['lastConsolidatedAt']).toBeUndefined();
    expect(meta['dream']).toEqual({ at: '2026-11-15T03:33:50.026Z', windowKey: '2026-11-15' });
  });

  it('an unparsable legacy instant cannot be typed — and must not crash or block a dream', () => {
    writeFileSync(metaPath(), JSON.stringify({ lastConsolidatedAt: 'not-a-date' }), 'utf-8');

    const store = new MemoryStore(dir);
    expect(store.getDreamRecord()).toBeNull();
    expect(shouldRunDreamCycle({ ...OVER, now: new Date(), dream: store.getDreamRecord() })).toBe(true);
  });

  it('a migration that cannot be written still serves the typed view', () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'markus-dr3-ro-'));
    try {
      const inner = join(dir2, 'meta-dir');
      mkdirSync(inner, { recursive: true });
      // Occupy the meta FILE path with a DIRECTORY so the durable write really fails.
      // An earlier version of this test made `dataDir` a directory and called that
      // "unwritable" — but dataDir is *supposed* to be a directory, so the write
      // succeeded and the case asserted nothing.
      mkdirSync(join(inner, 'memory-meta.json'), { recursive: true });
      const store = new MemoryStore(inner);
      expect(store.getDreamRecord()).toBeNull();
      expect(store.getLastConsolidatedAt()).toBeNull();
      // Invariant 4: a write that cannot land must be REPORTED, not swallowed.
      expect(store.recordDream('2026-11-15')).toBe(false);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});

describe('DR3 — getLastConsolidatedAt() keeps supplying the freshness number', () => {
  it('is max(dream, organized) — an organize-only agent is not blank any more than a dream-only one', () => {
    const store = new MemoryStore(dir);
    expect(store.getLastConsolidatedAt()).toBeNull(); // never anything → null, not "" or 0

    store.recordDream('2026-11-15', new Date('2026-11-15T03:33:50Z'));
    expect(store.getLastConsolidatedAt()).toBe('2026-11-15T03:33:50.000Z');

    store.recordOrganize(new Date('2026-11-15T09:00:00Z'));
    expect(store.getLastConsolidatedAt()).toBe('2026-11-15T09:00:00.000Z'); // later organize wins

    store.recordDream('2026-11-16', new Date('2026-11-16T03:00:00Z'));
    expect(store.getLastConsolidatedAt()).toBe('2026-11-16T03:00:00.000Z'); // later dream wins
  });

  it('is the same number the health report and the status API expose (no separate derivation)', () => {
    const store = new MemoryStore(dir);
    store.recordOrganize(new Date('2026-11-15T09:00:00Z'));
    expect(store.getMemoryHealth().lastConsolidatedAt).toBe(store.getLastConsolidatedAt());
  });

  it('a legacy instant still reports a freshness time after migration', () => {
    writeFileSync(metaPath(), JSON.stringify({ lastConsolidatedAt: '2026-11-15T03:33:50.026Z' }), 'utf-8');
    const store = new MemoryStore(dir);
    expect(store.getLastConsolidatedAt()).toBe('2026-11-15T03:33:50.026Z');
  });
});

describe('DR3 — restart parity', () => {
  it('a dream recorded by one store instance is seen by the next (no second dream after restart)', () => {
    const now = new Date('2026-11-15T10:00:00Z');
    const first = new MemoryStore(dir);
    const windowKey = dreamWindowKey(OVER.entryCount, now);
    expect(first.recordDream(windowKey, now)).toBe(true);

    // A fresh process: no in-memory state at all, only the file.
    const second = new MemoryStore(dir);
    expect(
      shouldRunDreamCycle({ ...OVER, now, dream: second.getDreamRecord() }),
    ).toBe(false);
  });
});
