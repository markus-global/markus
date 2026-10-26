/**
 * Guards the restart blind spot (dogfooding finding, 2026-10-26).
 *
 * The context reading is the platform's ONLY water-level number (it never
 * estimates). It lived purely in memory, so after a restart every session's first
 * turn reported `[CONTEXT pending]` — and the 90% hard gate fails open without a
 * reading, leaving a session already at 95% one completely ungated turn. That is
 * exactly the request that overflows.
 *
 * The reading is stored on the session record the memory store already owns and
 * already persists. It is deliberately NOT a store of its own: one fact, one
 * home, one writer. These tests pin the behaviour that matters — survival across
 * a process boundary, and removal when the history it measured is gone.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/memory/store.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'markus-ctx-reading-'));
}

/** Session saves are debounced by 1s; wait past it before opening a "new process". */
const settle = () => new Promise((resolve) => setTimeout(resolve, 1200));

describe('provider reading on the session record', () => {
  it('survives a process boundary — the whole point of storing it', async () => {
    const dir = tempDir();
    const store = new MemoryStore(dir);
    const session = store.getOrCreateSession('agt_test', 'sess_1');
    store.recordReportedInputTokens(session.id, { tokens: 900_000, messageCount: 300 });
    await settle();

    // A second store stands in for the next process: same dataDir, empty memory.
    const afterRestart = new MemoryStore(dir);
    expect(afterRestart.getReportedInputTokens('sess_1')).toEqual({ tokens: 900_000, messageCount: 300 });
  });

  it('returns undefined for a session that never had a reading', () => {
    expect(new MemoryStore(tempDir()).getReportedInputTokens('sess_unknown')).toBeUndefined();
  });

  it('drops the reading when cleared — a pre-compaction number must not come back', async () => {
    const dir = tempDir();
    const store = new MemoryStore(dir);
    const session = store.getOrCreateSession('agt_test', 'sess_1');
    store.recordReportedInputTokens(session.id, { tokens: 950_000, messageCount: 400 });
    await settle();

    store.clearReportedInputTokens('sess_1');
    await settle();

    // Post-compaction the session is small; carrying the old number across a
    // restart would gate healthy work on a measurement that describes nothing.
    expect(new MemoryStore(dir).getReportedInputTokens('sess_1')).toBeUndefined();
  });

  it('refuses a non-positive measurement instead of gating on nonsense', () => {
    const store = new MemoryStore(tempDir());
    const session = store.getOrCreateSession('agt_test', 'sess_1');
    store.recordReportedInputTokens(session.id, { tokens: 0, messageCount: 10 });
    expect(store.getReportedInputTokens('sess_1')).toBeUndefined();
  });

  it('keeps sessions apart', async () => {
    const dir = tempDir();
    const store = new MemoryStore(dir);
    store.recordReportedInputTokens(store.getOrCreateSession('agt_test', 'sess_a').id, { tokens: 100, messageCount: 1 });
    store.recordReportedInputTokens(store.getOrCreateSession('agt_test', 'sess_b').id, { tokens: 200, messageCount: 2 });
    await settle();

    const afterRestart = new MemoryStore(dir);
    expect(afterRestart.getReportedInputTokens('sess_a')?.tokens).toBe(100);
    expect(afterRestart.getReportedInputTokens('sess_b')?.tokens).toBe(200);
  });
});
