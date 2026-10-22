/**
 * Stream-event write batcher.
 *
 * Why this exists
 * ───────────────
 * `execution_stream_logs` receives one INSERT per stream event (`tool_start`,
 * `tool_end`, `status`, text flush). With node:sqlite, an INSERT outside an
 * explicit transaction is its own implicit transaction — i.e. **one WAL commit
 * (fsync) per event**. Measured on a real ledger: 4.27M rows / 5.9 GB, and it is
 * the single highest-frequency writer in the system.
 *
 * Contract we must preserve
 * ─────────────────────────
 * Callers of `append()` get a fully-formed row back **synchronously** (they use
 * `id` / `createdAt` immediately, e.g. to emit an SSE frame). So we cannot defer
 * the *row construction*, only the *write*.
 *
 * Invariants (each one is enforced somewhere, not hoped for)
 * ─────────────────────────────────────────────────────────
 *  I1  Readers never miss buffered rows  → every read/delete path flushes first.
 *  I2  Order is preserved                → FIFO buffer, single flush in push order.
 *  I3  Bounded loss on a hard crash      → at most `flushIntervalMs` of events.
 *  I4  No duplicate writes               → buffer is drained before the write
 *                                          starts (re-entrancy safe).
 *  I5  No leak on idle                   → the timer is unref'd and stops itself
 *                                          when the buffer empties.
 */

export interface StreamBatcherOptions<T = unknown> {
  /** Writes one batch atomically (single transaction). Must be synchronous. */
  writer: (rows: T[]) => void;
  /** Flush when this many rows are buffered. Default 100. */
  maxRows?: number;
  /** Flush at most this long after the first buffered row. Default 250 ms. */
  flushIntervalMs?: number;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
}

const DEFAULT_MAX_ROWS = 100;
const DEFAULT_FLUSH_INTERVAL_MS = 250;

export class StreamWriteBatcher<T> {
  private readonly writer: (rows: T[]) => void;
  private readonly maxRows: number;
  private readonly flushIntervalMs: number;
  private readonly now: () => number;

  private buffer: T[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstPushAt = 0;
  private disposed = false;
  /** Number of rows actually handed to `writer` — test/diagnostic surface. */
  private written = 0;
  private batches = 0;

  constructor(opts: StreamBatcherOptions<T>) {
    this.writer = opts.writer;
    this.maxRows = Math.max(1, opts.maxRows ?? DEFAULT_MAX_ROWS);
    this.flushIntervalMs = Math.max(0, opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
    this.now = opts.now ?? Date.now;
  }

  push(row: T): void {
    if (this.disposed) throw new Error('StreamWriteBatcher: push after dispose');
    if (this.buffer.length === 0) this.firstPushAt = this.now();
    this.buffer.push(row);
    if (this.buffer.length >= this.maxRows) {
      this.flush();
      return;
    }
    this.armTimer();
  }

  /** Write everything currently buffered. Safe to call when empty. */
  flush(): void {
    this.clearTimer();
    if (this.buffer.length === 0) return;
    // I4: drain BEFORE writing so a throw (or re-entrant push) cannot double-write.
    const batch = this.buffer;
    this.buffer = [];
    this.written += batch.length;
    this.batches += 1;
    this.writer(batch);
  }

  pendingCount(): number {
    return this.buffer.length;
  }

  stats(): { written: number; batches: number; pending: number } {
    return { written: this.written, batches: this.batches, pending: this.buffer.length };
  }

  /** Flush, then stop the timer for good. Pushing afterwards is a programming error. */
  dispose(): void {
    if (this.disposed) return;
    this.flush();
    this.disposed = true;
  }

  private armTimer(): void {
    if (this.timer || this.flushIntervalMs <= 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      // I5: do not keep the event loop alive for a telemetry buffer.
      try { this.flush(); } catch { /* caller's read path will surface the error */ }
    }, this.flushIntervalMs);
    const t = this.timer as unknown as { unref?: () => void };
    if (typeof t.unref === 'function') t.unref();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
