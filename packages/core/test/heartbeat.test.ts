import { EventBus } from '../src/events.js';
import { HeartbeatScheduler } from '../src/heartbeat.js';
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
