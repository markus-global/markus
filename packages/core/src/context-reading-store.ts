/**
 * Durable store for the last provider-reported context reading per session.
 *
 * ## Why this exists
 *
 * `ContextEngine` measures context fill from the provider's own report — it does
 * not estimate. That reading used to live only in an in-memory Map, so after a
 * restart every session's FIRST turn had no reading at all. The `[CONTEXT]`
 * banner said `pending`, and the 90% hard gate fails open without a reading, so
 * a session already at 95% got one completely ungated turn — which is exactly
 * the request that overflows.
 *
 * Observed by dogfooding on 2026-10-26: a 317-message session came back from a
 * restart reporting `[CONTEXT pending — no provider measurement for this
 * session yet]`. The gate was blind on the turn most likely to be too big.
 *
 * ## Why a file and not a database column
 *
 * This is a **cache of a number the provider told us**, not a source of truth.
 * The truth is the session history; this only saves waiting one call to re-learn
 * a fact we already knew. A per-agent JSON file needs no schema migration and no
 * cross-package plumbing, and losing it is harmless (we simply fall back to
 * `pending`, i.e. today's behaviour).
 *
 * ## Invariants
 *
 *   • One file per agent: `<agentDataDir>/context-readings.json`.
 *   • Atomic replace (tmp + rename): a crash mid-write must never leave a
 *     half-written JSON that disables the gate for every session of that agent.
 *   • Cleared on compaction: a pre-compaction high reading must not survive a
 *     restart and immediately gate a session that just shrank.
 *   • Failures are swallowed: an unreadable or unwritable cache must never break
 *     a turn. Worst case we are back to `pending`.
 */
import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface ContextReading {
  /** Provider-reported prompt tokens for the most recent call of this session. */
  tokens: number;
  /** History length that reading was measured against (guards against rewrites). */
  messageCount: number;
}

export class FileContextReadingStore {
  private readonly path: string;
  /** In-memory mirror; the file is only touched when this changes. */
  private readings: Record<string, ContextReading> | undefined;
  private dirty = false;
  private lastFlush = 0;

  /**
   * @param dataDir Agent data directory (the same one `MemoryStore` uses).
   * @param flushIntervalMs Minimum gap between writes. Readings arrive after
   *   every single LLM call; writing each time would be pointless churn on a
   *   value that only matters at process exit boundaries.
   */
  constructor(dataDir: string, private readonly flushIntervalMs = 5000) {
    this.path = join(dataDir, 'context-readings.json');
  }

  load(sessionId: string): ContextReading | undefined {
    const all = this.loadAll();
    const reading = all[sessionId];
    if (!reading) return undefined;
    if (!Number.isFinite(reading.tokens) || reading.tokens <= 0) return undefined;
    return reading;
  }

  save(sessionId: string, reading: ContextReading): void {
    const all = this.loadAll();
    const previous = all[sessionId];
    if (previous && previous.tokens === reading.tokens && previous.messageCount === reading.messageCount) {
      return; // unchanged — do not touch the disk
    }
    all[sessionId] = reading;
    this.dirty = true;
    this.flush(false);
  }

  clear(sessionId: string): void {
    const all = this.loadAll();
    if (!(sessionId in all)) return;
    delete all[sessionId];
    this.dirty = true;
    this.flush(true);
  }

  private loadAll(): Record<string, ContextReading> {
    if (this.readings) return this.readings;
    try {
      const raw = readFileSync(this.path, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, ContextReading>;
      this.readings = parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      // Missing or corrupt: start clean rather than disabling the gate forever.
      this.readings = {};
    }
    return this.readings;
  }

  private flush(force: boolean): void {
    if (!this.dirty) return;
    const now = Date.now();
    if (!force && now - this.lastFlush < this.flushIntervalMs) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.readings ?? {}), 'utf-8');
      // Atomic replace: readers see either the old file or the new one.
      renameSync(tmp, this.path);
      this.dirty = false;
      this.lastFlush = now;
    } catch {
      // Cache only — never surface IO failure into a turn.
      try { unlinkSync(`${this.path}.tmp`); } catch { /* nothing to clean */ }
    }
  }

  /** Force a write now. Called on shutdown paths and by tests. */
  flushNow(): void {
    this.flush(true);
  }
}
