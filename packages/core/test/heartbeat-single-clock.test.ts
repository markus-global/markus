import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventBus } from '../src/events.js';
import { AgentClock } from '../src/clock.js';
import { HeartbeatScheduler, HEARTBEAT_CLOCK_SOURCE } from '../src/heartbeat.js';
import { HEARTBEAT_MIN_INITIAL_DELAY_MS } from '@markus/shared';

/**
 * C8-C — the heartbeat must stop being a second periodic clock.
 *
 * Contract (docs/records/cut8-c-single-clock-design-2026-11-14.md §3.1):
 *   · In `clock` mode `HeartbeatScheduler` owns NO timer at all: `AgentClock` is the
 *     only periodic driver, and it calls `tick()` when the heartbeat is due.
 *   · In `legacy` mode the old private `setInterval` stays, so the channel can be
 *     rolled back independently (`MARKUS_HEARTBEAT_CLOCK=legacy`).
 *
 * These assertions are red before the change: today `start()` always arms a
 * `setTimeout` + `setInterval` pair.
 */

function makeClock() {
  let t = 1_000_000;
  const clock = new AgentClock('agent-1', 1000, () => t);
  return { clock, advance: (ms: number) => { t += ms; } };
}

describe('HeartbeatScheduler — single clock (C8-C)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('clock mode: start() creates NO timer — AgentClock is the only driver', () => {
    const bus = new EventBus();
    const { clock } = makeClock();
    const scheduler = new HeartbeatScheduler(
      'agent-1', bus, { intervalMs: 60_000, enabled: true },
      { mode: 'clock', clock },
    );

    scheduler.start(HEARTBEAT_MIN_INITIAL_DELAY_MS);

    expect(scheduler.isRunning()).toBe(true);
    // The whole point of the cut: zero timers owned by the heartbeat.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clock mode: only a due clock tick fires the trigger (no self-advance)', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on('heartbeat:trigger', handler);
    const { clock, advance } = makeClock();
    const scheduler = new HeartbeatScheduler(
      'agent-1', bus, { intervalMs: 60_000, enabled: true },
      { mode: 'clock', clock },
    );
    scheduler.start(HEARTBEAT_MIN_INITIAL_DELAY_MS);

    // Advancing wall-clock time alone fires nothing — there is no timer to fire.
    vi.advanceTimersByTime(10 * 60_000);
    expect(handler).not.toHaveBeenCalled();

    advance(HEARTBEAT_MIN_INITIAL_DELAY_MS);
    clock.tick();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ agentId: 'agent-1', mode: 'clock' });
  });

  it('clock mode: cadence comes from the clock, one trigger per interval', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on('heartbeat:trigger', handler);
    const { clock, advance } = makeClock();
    const scheduler = new HeartbeatScheduler(
      'agent-1', bus, { intervalMs: 60_000, enabled: true },
      { mode: 'clock', clock },
    );
    const initial = HEARTBEAT_MIN_INITIAL_DELAY_MS;
    scheduler.start(initial);

    advance(initial);
    clock.tick();
    expect(handler).toHaveBeenCalledTimes(1);

    advance(59_000);
    clock.tick();
    expect(handler).toHaveBeenCalledTimes(1);

    advance(1_000);
    clock.tick();
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('clock mode: updateInterval re-registers the source instead of starting a timer', () => {
    const bus = new EventBus();
    const { clock } = makeClock();
    const scheduler = new HeartbeatScheduler(
      'agent-1', bus, { intervalMs: 60_000, enabled: true },
      { mode: 'clock', clock },
    );
    scheduler.start(HEARTBEAT_MIN_INITIAL_DELAY_MS);

    scheduler.updateInterval(6 * 3600_000);

    const source = clock.getStatus().sources.find(s => s.name === HEARTBEAT_CLOCK_SOURCE);
    expect(source?.everyMs).toBe(6 * 3600_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(scheduler.getStatus().intervalMs).toBe(6 * 3600_000);
  });

  it('clock mode: stop() unregisters the source', () => {
    const bus = new EventBus();
    const { clock } = makeClock();
    const scheduler = new HeartbeatScheduler(
      'agent-1', bus, { intervalMs: 60_000, enabled: true },
      { mode: 'clock', clock },
    );
    scheduler.start(HEARTBEAT_MIN_INITIAL_DELAY_MS);
    scheduler.stop();

    expect(clock.getStatus().sources.some(s => s.name === HEARTBEAT_CLOCK_SOURCE)).toBe(false);
    expect(scheduler.isRunning()).toBe(false);
  });

  it('legacy mode: the old private timer still exists (independent rollback)', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on('heartbeat:trigger', handler);
    const { clock } = makeClock();
    const scheduler = new HeartbeatScheduler(
      'agent-1', bus, { intervalMs: 60_000, enabled: true },
      { mode: 'legacy', clock },
    );

    scheduler.start(HEARTBEAT_MIN_INITIAL_DELAY_MS);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    expect(clock.getStatus().sources.some(s => s.name === HEARTBEAT_CLOCK_SOURCE)).toBe(false);

    vi.advanceTimersByTime(HEARTBEAT_MIN_INITIAL_DELAY_MS);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ agentId: 'agent-1', mode: 'legacy' });
  });
});
