import { describe, it, expect, vi } from 'vitest';
import {
  createStreamWatchdog,
  exponentialBackoffDelay,
  STREAM_WATCHDOG_DEFAULT_MS,
} from '../src/lib/streamResilience.ts';

describe('exponentialBackoffDelay', () => {
  it('is 0..base on first attempt (jitter protects against thundering herd)', () => {
    // random() -> 0 gives 0; random() -> ~1 gives base
    expect(exponentialBackoffDelay(0, { random: () => 0 })).toBe(0);
    expect(exponentialBackoffDelay(0, { random: () => 0.999 })).toBeLessThan(
      1000, // base=1000 → window=1000
    );
  });

  it('grows exponentially but caps at maxMs', () => {
    const rnd = () => 0.999;
    const low = exponentialBackoffDelay(0, { random: rnd });
    const mid = exponentialBackoffDelay(2, { random: rnd });
    // attempt=2 → window = base*4 = 4000
    expect(mid).toBeGreaterThan(low);
    expect(mid).toBeLessThanOrEqual(4000);

    // attempt huge → window base*2^10 → capped at maxMs 30000 (default maxAttempts=30)
    const big = exponentialBackoffDelay(10, { random: rnd });
    expect(big).toBeLessThanOrEqual(30000);
    // attempt that exceeds maxMs's implied cap still bounded by maxMs
    expect(big).toBeGreaterThanOrEqual(mid);
  });

  it('respects maxAttempts cap so delay does not grow unbounded', () => {
    const rnd = () => 0.999;
    const d2 = exponentialBackoffDelay(2, { random: rnd, maxAttempts: 3 });
    const d10 = exponentialBackoffDelay(10, { random: rnd, maxAttempts: 3 });
    // capped at attempt = maxAttempts-1 = 2 → window base*4
    expect(d2).toBeLessThanOrEqual(4000);
    expect(d10).toBeLessThanOrEqual(4000);
  });

  it('honors explicit maxMs cap', () => {
    const rnd = () => 0.999;
    const d = exponentialBackoffDelay(50, { random: rnd, maxMs: 500 });
    expect(d).toBeLessThanOrEqual(500);
  });
});

describe('createStreamWatchdog', () => {
  it('triggers onStall once when no bump within timeoutMs', () => {
    vi.useFakeTimers();
    try {
      const ac = new AbortController();
      const onStall = vi.fn();
      const wd = createStreamWatchdog({ signal: ac.signal, timeoutMs: 1000, onStall });

      vi.advanceTimersByTime(999);
      expect(onStall).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2);
      expect(onStall).toHaveBeenCalledTimes(1);

      // further elapse does NOT re-fire
      wd.bump();
      vi.advanceTimersByTime(5000);
      expect(onStall).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bump() resets the timer and prevents a stall while data is flowing', () => {
    vi.useFakeTimers();
    try {
      const ac = new AbortController();
      const onStall = vi.fn();
      const wd = createStreamWatchdog({ signal: ac.signal, timeoutMs: 1000, onStall });

      // Data keeps arriving just under threshold → never stalls.
      for (let i = 0; i < 100; i++) {
        vi.advanceTimersByTime(800);
        wd.bump();
      }
      expect(onStall).not.toHaveBeenCalled();

      // Then data stops → stalls after 1000ms of silence.
      vi.advanceTimersByTime(1001);
      expect(onStall).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() disarms the timer (normal stream end)', () => {
    vi.useFakeTimers();
    try {
      const ac = new AbortController();
      const onStall = vi.fn();
      const wd = createStreamWatchdog({ signal: ac.signal, timeoutMs: 1000, onStall });
      wd.stop();
      vi.advanceTimersByTime(10000);
      expect(onStall).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborting the signal disarms the watchdog (user stop / navigation)', () => {
    vi.useFakeTimers();
    try {
      const ac = new AbortController();
      const onStall = vi.fn();
      createStreamWatchdog({ signal: ac.signal, timeoutMs: 1000, onStall });
      ac.abort();
      vi.advanceTimersByTime(10000);
      expect(onStall).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('bump() after stall is a no-op (does not re-arm)', () => {
    vi.useFakeTimers();
    try {
      const ac = new AbortController();
      const onStall = vi.fn();
      const wd = createStreamWatchdog({ signal: ac.signal, timeoutMs: 1000, onStall });
      vi.advanceTimersByTime(5000);
      expect(onStall).toHaveBeenCalledTimes(1);
      wd.bump();
      vi.advanceTimersByTime(10000);
      expect(onStall).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// guard: default timeout constant stays a sane multiple of the 15s server heartbeat
describe('default watchdog timeout', () => {
  it('is an integer multiple comfortably above the 15s SSE heartbeat', () => {
    expect(STREAM_WATCHDOG_DEFAULT_MS).toBeGreaterThanOrEqual(60000);
    expect(STREAM_WATCHDOG_DEFAULT_MS % 1000).toBe(0);
  });
});