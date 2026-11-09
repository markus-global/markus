import { describe, it, expect, vi, afterEach } from 'vitest';
import { AgentClock } from '../src/clock.js';

/** Deterministic clock: we inject `now`, so no fake timers needed for cadence tests. */
function makeClock(tickMs = 1000) {
  let t = 1_000_000;
  const clock = new AgentClock('agt_x', tickMs, () => t);
  return { clock, set: (v: number) => { t = v; }, advance: (ms: number) => { t += ms; }, now: () => t };
}

afterEach(() => { vi.useRealTimers(); });

describe('AgentClock — one interval, N cadenced sources', () => {
  it('runs a source only once its cadence is due', () => {
    const { clock, advance } = makeClock();
    const fn = vi.fn();
    clock.register({ name: 's', everyMs: 30_000, initialDelayMs: 30_000, fn });

    clock.tick();                 // now + 0, not yet due
    expect(fn).not.toHaveBeenCalled();

    advance(30_000);
    clock.tick();
    expect(fn).toHaveBeenCalledTimes(1);

    advance(30_000);
    clock.tick();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('runs immediately when no initial delay is given', () => {
    const { clock } = makeClock();
    const fn = vi.fn();
    clock.register({ name: 's', everyMs: 60_000, fn });
    clock.tick();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('isolates a throwing source: others still run, clock keeps going', () => {
    const { clock, advance } = makeClock();
    const bad = vi.fn(() => { throw new Error('boom'); });
    const good = vi.fn();
    clock.register({ name: 'bad', everyMs: 1000, fn: bad });
    clock.register({ name: 'good', everyMs: 1000, fn: good });

    clock.tick();
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);

    advance(1000);
    clock.tick();
    expect(good).toHaveBeenCalledTimes(2);
  });

  it('register with the same name overrides (one source, one writer)', () => {
    const { clock } = makeClock();
    const first = vi.fn();
    const second = vi.fn();
    clock.register({ name: 'dup', everyMs: 1000, fn: first });
    clock.register({ name: 'dup', everyMs: 1000, fn: second });
    clock.tick();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(clock.getStatus().sources.length).toBe(1);
  });

  it('start is idempotent — two starts do not double the tick rate', () => {
    vi.useFakeTimers();
    const clock = new AgentClock('agt_y', 1000); // real Date.now, faked by vitest
    const fn = vi.fn();
    clock.register({ name: 's', everyMs: 1000, fn });

    clock.start();
    clock.start();

    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(5); // 1 interval ⇒ 5 ticks, not 10
    expect(clock.getStatus().running).toBe(true);

    clock.stop();
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(5); // stopped
    expect(clock.getStatus().running).toBe(false);
  });

  it('unregister removes a source', () => {
    const { clock, advance } = makeClock();
    const fn = vi.fn();
    clock.register({ name: 's', everyMs: 1000, fn });
    clock.unregister('s');
    clock.tick();
    advance(5000);
    clock.tick();
    expect(fn).not.toHaveBeenCalled();
  });
});
