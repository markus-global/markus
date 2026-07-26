import { EventBus } from '../src/events.js';
import {
  HeartbeatScheduler,
  isWithinActiveHours,
  minutesOfDayInTimeZone,
} from '../src/heartbeat.js';
import { HEARTBEAT_MIN_INITIAL_DELAY_MS } from '@markus/shared';

describe('HeartbeatScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not start when disabled', () => {
    const bus = new EventBus();
    const scheduler = new HeartbeatScheduler('agent-1', bus, {
      intervalMs: 1000,
      enabled: false,
    });
    scheduler.start(0);
    expect(scheduler.isRunning()).toBe(false);
  });

  it('does not start when intervalMs <= 0', () => {
    const bus = new EventBus();
    const scheduler = new HeartbeatScheduler('agent-1', bus, {
      intervalMs: 0,
      enabled: true,
    });
    scheduler.start(0);
    expect(scheduler.isRunning()).toBe(false);
  });

  it('starts and stops', () => {
    const bus = new EventBus();
    const scheduler = new HeartbeatScheduler('agent-1', bus, {
      intervalMs: 60_000,
      enabled: true,
    });
    scheduler.start(HEARTBEAT_MIN_INITIAL_DELAY_MS);
    expect(scheduler.isRunning()).toBe(true);
    scheduler.stop();
    expect(scheduler.isRunning()).toBe(false);
  });

  it('does not double-start', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on('heartbeat:trigger', handler);
    const scheduler = new HeartbeatScheduler('agent-1', bus, {
      intervalMs: 60_000,
      enabled: true,
    });
    scheduler.start(HEARTBEAT_MIN_INITIAL_DELAY_MS);
    scheduler.start(HEARTBEAT_MIN_INITIAL_DELAY_MS);
    vi.advanceTimersByTime(HEARTBEAT_MIN_INITIAL_DELAY_MS);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('fires heartbeat on interval after initial delay', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on('heartbeat:trigger', handler);
    const intervalMs = 30_000;
    const scheduler = new HeartbeatScheduler('agent-1', bus, {
      intervalMs,
      enabled: true,
    });

    scheduler.start(HEARTBEAT_MIN_INITIAL_DELAY_MS);
    vi.advanceTimersByTime(HEARTBEAT_MIN_INITIAL_DELAY_MS);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ agentId: 'agent-1' });

    vi.advanceTimersByTime(intervalMs);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('enforces minimum initial delay', () => {
    const bus = new EventBus();
    const scheduler = new HeartbeatScheduler('agent-1', bus, {
      intervalMs: 60_000,
      enabled: true,
    });
    scheduler.start(100);
    expect(scheduler.getStatus().initialDelayMs).toBe(HEARTBEAT_MIN_INITIAL_DELAY_MS);
  });

  it('trigger emits event immediately', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on('heartbeat:trigger', handler);
    const scheduler = new HeartbeatScheduler('agent-2', bus);
    scheduler.trigger();
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].agentId).toBe('agent-2');
  });

  it('getStatus reports running and uptime', () => {
    const bus = new EventBus();
    const scheduler = new HeartbeatScheduler('agent-1', bus, {
      intervalMs: 60_000,
      enabled: true,
    });
    expect(scheduler.getStatus().running).toBe(false);
    scheduler.start(HEARTBEAT_MIN_INITIAL_DELAY_MS);
    vi.advanceTimersByTime(1000);
    const status = scheduler.getStatus();
    expect(status.running).toBe(true);
    expect(status.uptimeMs).toBeGreaterThanOrEqual(1000);
    expect(status.intervalMs).toBe(60_000);
  });

  it('stop clears timers before interval fires', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on('heartbeat:trigger', handler);
    const scheduler = new HeartbeatScheduler('agent-1', bus, {
      intervalMs: 10_000,
      enabled: true,
    });
    scheduler.start(HEARTBEAT_MIN_INITIAL_DELAY_MS);
    scheduler.stop();
    vi.advanceTimersByTime(HEARTBEAT_MIN_INITIAL_DELAY_MS + 20_000);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('C1: active-hours timezone handling', () => {
  // A fixed instant: 2026-07-23T12:00:00Z (noon UTC, summer → DST in effect).
  const noonUtc = new Date('2026-07-23T12:00:00Z');

  it('minutesOfDayInTimeZone converts the same instant per timezone', () => {
    expect(minutesOfDayInTimeZone(noonUtc, 'UTC')).toBe(12 * 60); // 12:00
    expect(minutesOfDayInTimeZone(noonUtc, 'America/Los_Angeles')).toBe(5 * 60); // 05:00 PDT
    expect(minutesOfDayInTimeZone(noonUtc, 'Asia/Tokyo')).toBe(21 * 60); // 21:00 JST
  });

  it('minutesOfDayInTimeZone falls back to local time for an invalid timezone', () => {
    const local = noonUtc.getHours() * 60 + noonUtc.getMinutes();
    expect(minutesOfDayInTimeZone(noonUtc, 'Not/AZone')).toBe(local);
  });

  it('evaluates the 08:00-22:00 window in the configured timezone, not the host', () => {
    const window = { start: '08:00', end: '22:00' };
    // Noon UTC is inside 08-22 in UTC and Tokyo (21:00) but not in LA (05:00).
    expect(isWithinActiveHours({ ...window, timezone: 'UTC' }, noonUtc)).toBe(true);
    expect(isWithinActiveHours({ ...window, timezone: 'Asia/Tokyo' }, noonUtc)).toBe(true);
    expect(isWithinActiveHours({ ...window, timezone: 'America/Los_Angeles' }, noonUtc)).toBe(false);
  });

  it('excludes the exact end minute and includes the exact start minute', () => {
    // Tokyo is 21:00 at noonUtc.
    expect(isWithinActiveHours({ start: '21:00', end: '22:00', timezone: 'Asia/Tokyo' }, noonUtc)).toBe(true);
    expect(isWithinActiveHours({ start: '08:00', end: '21:00', timezone: 'Asia/Tokyo' }, noonUtc)).toBe(false); // end exclusive
  });

  it('handles windows that wrap past midnight, per timezone', () => {
    // LA is 05:00 at noonUtc → inside a 22:00-06:00 overnight window.
    expect(isWithinActiveHours({ start: '22:00', end: '06:00', timezone: 'America/Los_Angeles' }, noonUtc)).toBe(true);
    // Tokyo is 21:00 → outside the overnight window.
    expect(isWithinActiveHours({ start: '22:00', end: '06:00', timezone: 'Asia/Tokyo' }, noonUtc)).toBe(false);
  });
});
