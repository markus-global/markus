/**
 * Guards the restart blind spot (dogfooding finding, 2026-10-26).
 *
 * The context reading is the ONLY water-level number in the platform (no
 * estimation). It lived purely in memory, so after a restart every session's
 * first turn reported `[CONTEXT pending]` — and the 90% hard gate fails open
 * without a reading, leaving a session already at 95% one completely ungated
 * turn. That is precisely the request that overflows.
 *
 * These tests pin the durable cache that closes it: it must survive a process
 * boundary, must never resurrect a pre-compaction reading, and must never break
 * a turn when the cache is unreadable.
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileContextReadingStore } from '../src/context-reading-store.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'markus-ctx-reading-'));
}

describe('FileContextReadingStore', () => {
  it('survives a process boundary (the whole point)', () => {
    const dir = tempDir();
    const first = new FileContextReadingStore(dir, 0);
    first.save('sess_1', { tokens: 900_000, messageCount: 300 });

    // A new instance stands in for the next process: same dir, empty memory.
    const afterRestart = new FileContextReadingStore(dir, 0);
    expect(afterRestart.load('sess_1')).toEqual({ tokens: 900_000, messageCount: 300 });
  });

  it('returns undefined for a session it never saw', () => {
    expect(new FileContextReadingStore(tempDir(), 0).load('sess_unknown')).toBeUndefined();
  });

  it('drops the reading on clear — a pre-compaction number must not come back', () => {
    const dir = tempDir();
    const store = new FileContextReadingStore(dir, 0);
    store.save('sess_1', { tokens: 950_000, messageCount: 400 });
    store.clear('sess_1');

    // Post-compaction the session is small; carrying the old reading across a
    // restart would gate healthy work on a number that no longer describes it.
    expect(new FileContextReadingStore(dir, 0).load('sess_1')).toBeUndefined();
  });

  it('ignores a corrupt cache file instead of disabling the gate forever', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'context-readings.json'), '{ not json', 'utf-8');
    const store = new FileContextReadingStore(dir, 0);
    expect(store.load('sess_1')).toBeUndefined();
    // Still usable afterwards.
    store.save('sess_1', { tokens: 1000, messageCount: 5 });
    expect(store.load('sess_1')).toEqual({ tokens: 1000, messageCount: 5 });
  });

  it('rejects a non-positive token count rather than gating on nonsense', () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'context-readings.json'),
      JSON.stringify({ sess_1: { tokens: 0, messageCount: 10 } }),
      'utf-8',
    );
    expect(new FileContextReadingStore(dir, 0).load('sess_1')).toBeUndefined();
  });

  it('writes atomically — no half-written file is left behind', () => {
    const dir = tempDir();
    const store = new FileContextReadingStore(dir, 0);
    store.save('sess_1', { tokens: 42, messageCount: 1 });
    expect(existsSync(join(dir, 'context-readings.json.tmp'))).toBe(false);
    expect(() => JSON.parse(readFileSync(join(dir, 'context-readings.json'), 'utf-8'))).not.toThrow();
  });

  it('keeps several sessions apart', () => {
    const dir = tempDir();
    const store = new FileContextReadingStore(dir, 0);
    store.save('sess_a', { tokens: 100, messageCount: 1 });
    store.save('sess_b', { tokens: 200, messageCount: 2 });
    const reloaded = new FileContextReadingStore(dir, 0);
    expect(reloaded.load('sess_a')?.tokens).toBe(100);
    expect(reloaded.load('sess_b')?.tokens).toBe(200);
  });
});
