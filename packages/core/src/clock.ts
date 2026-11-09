import { createLogger } from '@markus/shared';

const log = createLogger('clock');

/**
 * A named, cadenced job registered on an {@link AgentClock}.
 *
 * `everyMs` is the cadence; `initialDelayMs` (default 0) delays the *first* run,
 * which is how jitter is expressed. `register()` with the same `name` replaces —
 * one source, one writer.
 */
export interface ClockSource {
  name: string;
  everyMs: number;
  initialDelayMs?: number;
  fn: () => void | Promise<void>;
}

interface RegisteredSource {
  src: ClockSource;
  nextDueAt: number;
  lastRunAt?: number;
}

/**
 * The single periodic driver for one agent's **time-driven transitions**.
 *
 * Before this existed, each periodic concern (heartbeat, memory consolidation,
 * wakeup sweep, and — worse — defer/lease maintenance that only ran when the
 * attention loop happened to iterate) owned its own timer. An idle agent with an
 * empty queue never iterated, so a due deferred item could stay parked until some
 * unrelated event woke the loop. One clock that ticks regardless of queue state
 * gives every time-driven transition the same runtime owner.
 *
 * Design rules (matches the mechanism spec's R-10.1):
 * - **One `setInterval`**, coarse tick (`tickMs`, default 1s); each source keeps
 *   its own cadence and is invoked only when due.
 * - **Idempotent `start()`**, `timer.unref()` so it never keeps the process alive.
 * - **Failure isolation**: a throwing/rejecting source is logged and skipped; it
 *   never stops the clock or the other sources.
 * - **Pure scheduling**: the clock decides *when*; the `fn` decides *what*.
 */
export class AgentClock {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly sources = new Map<string, RegisteredSource>();

  constructor(
    private readonly agentId: string,
    private readonly tickMs = 1000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Register (or replace) a cadenced source. Same name overwrites. */
  register(source: ClockSource): void {
    const nextDueAt = this.now() + (source.initialDelayMs ?? 0);
    this.sources.set(source.name, { src: source, nextDueAt });
  }

  unregister(name: string): void {
    this.sources.delete(name);
  }

  /** Start the single ticker. Idempotent — a second call is a no-op. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
  }

  /** Stop the ticker. Idempotent. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.running = false;
  }

  /**
   * Run every source whose cadence is due. Public so tests can drive it with a
   * deterministic clock; the real timer calls it with `Date.now()`.
   */
  tick(at: number = this.now()): void {
    for (const entry of this.sources.values()) {
      if (at < entry.nextDueAt) continue;
      // Schedule the next run BEFORE invoking, so a slow/throwing fn cannot
      // wedge the cadence or double-fire on the next tick.
      entry.nextDueAt = at + entry.src.everyMs;
      entry.lastRunAt = at;
      try {
        const result = entry.src.fn();
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch(err =>
            log.warn('Clock source rejected', { agentId: this.agentId, source: entry.src.name, error: String(err) }),
          );
        }
      } catch (err) {
        log.warn('Clock source threw', { agentId: this.agentId, source: entry.src.name, error: String(err) });
      }
    }
  }

  getStatus(): {
    running: boolean;
    tickMs: number;
    sources: Array<{ name: string; everyMs: number; lastRunAt?: number }>;
  } {
    return {
      running: this.running,
      tickMs: this.tickMs,
      sources: [...this.sources.values()].map(e => ({
        name: e.src.name,
        everyMs: e.src.everyMs,
        lastRunAt: e.lastRunAt,
      })),
    };
  }
}
