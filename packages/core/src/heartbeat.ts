import { createLogger, HEARTBEAT_MIN_INITIAL_DELAY_MS, DEFAULT_HEARTBEAT_INTERVAL_MS } from '@markus/shared';
import type { EventBus } from './events.js';

const log = createLogger('heartbeat');

export interface HeartbeatActiveHours {
  start: string;   // "08:00"
  end: string;     // "22:00"
  timezone?: string;
}

export interface HeartbeatConfig {
  intervalMs: number;
  enabled: boolean;
  activeHours?: HeartbeatActiveHours;
}

/**
 * C1: minutes-since-midnight for `date` **in a specific IANA timezone**.
 * Falls back to the host-local clock when no timezone is given or the timezone
 * is invalid. Pure and side-effect-free so active-hours logic is testable and
 * consistent regardless of where the process runs.
 */
export function minutesOfDayInTimeZone(date: Date, timeZone?: string): number {
  if (!timeZone) return date.getHours() * 60 + date.getMinutes();
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(date);
    let h = 0;
    let m = 0;
    for (const p of parts) {
      if (p.type === 'hour') h = parseInt(p.value, 10) % 24; // '24' → 0 at midnight
      else if (p.type === 'minute') m = parseInt(p.value, 10);
    }
    return h * 60 + m;
  } catch {
    // Invalid timezone id — degrade to local time rather than throwing in a timer.
    return date.getHours() * 60 + date.getMinutes();
  }
}

/**
 * C1: whether `now` falls inside the configured active-hours window, evaluated in
 * `activeHours.timezone` (not the host's local timezone). Handles windows that wrap
 * past midnight (e.g. 22:00–06:00). Pure so it can be unit-tested across timezones.
 */
export function isWithinActiveHours(activeHours: HeartbeatActiveHours, now: Date = new Date()): boolean {
  const [startH, startM] = activeHours.start.split(':').map(Number);
  const [endH, endM] = activeHours.end.split(':').map(Number);
  const current = minutesOfDayInTimeZone(now, activeHours.timezone);
  const startMin = startH * 60 + startM;
  const endMin = endH * 60 + endM;
  if (startMin <= endMin) {
    return current >= startMin && current < endMin;
  }
  // Wraps midnight (e.g. 22:00 - 06:00)
  return current >= startMin || current < endMin;
}

export class HeartbeatScheduler {
  private initialTimer?: ReturnType<typeof setTimeout>;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private startTime = Date.now();
  private effectiveInitialDelayMs = 0;

  constructor(
    private agentId: string,
    private eventBus: EventBus,
    private config: HeartbeatConfig = { intervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS, enabled: true },
  ) {}

  /**
   * @param initialDelayMs - Delay before the first heartbeat fires.
   *   If omitted, uses random jitter in [0, intervalMs) to spread heartbeats
   *   across the interval window and avoid traffic spikes.
   */
  start(initialDelayMs?: number): void {
    if (this.running || !this.config.enabled) return;
    if (this.config.intervalMs <= 0) {
      log.info('Heartbeat disabled (intervalMs <= 0)', { agentId: this.agentId });
      return;
    }
    this.running = true;
    this.startTime = Date.now();

    const rawDelay = initialDelayMs ?? Math.floor(Math.random() * this.config.intervalMs);
    const delay = Math.max(rawDelay, HEARTBEAT_MIN_INITIAL_DELAY_MS);
    this.effectiveInitialDelayMs = delay;

    log.info('Starting heartbeat scheduler', {
      agentId: this.agentId,
      intervalMs: this.config.intervalMs,
      initialDelayMs: delay,
      activeHours: this.config.activeHours,
    });

    this.initialTimer = setTimeout(() => {
      this.initialTimer = undefined;
      this.tick();
      this.timer = setInterval(() => this.tick(), this.config.intervalMs);
    }, delay);
  }

  stop(): void {
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = undefined;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.running = false;
    log.info('Heartbeat scheduler stopped', { agentId: this.agentId });
  }

  /**
   * Change the heartbeat interval and apply it live. If the scheduler is
   * running, it is restarted so the new cadence takes effect immediately
   * (with fresh jitter for the next tick to avoid a thundering herd).
   */
  updateInterval(intervalMs: number): void {
    this.config.intervalMs = intervalMs;
    log.info('Heartbeat interval updated', { agentId: this.agentId, intervalMs });
    if (this.running) {
      this.stop();
      this.start();
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  getStatus(): { running: boolean; uptimeMs: number; intervalMs: number; initialDelayMs: number } {
    return {
      running: this.running,
      uptimeMs: this.running ? Date.now() - this.startTime : 0,
      intervalMs: this.config.intervalMs,
      initialDelayMs: this.effectiveInitialDelayMs,
    };
  }

  /** Manually trigger a heartbeat (e.g. from API) */
  trigger(): void {
    this.eventBus.emit('heartbeat:trigger', { agentId: this.agentId, triggeredAt: new Date().toISOString() });
  }

  private tick(): void {
    if (!this.running) return;

    if (this.config.activeHours && !this.isWithinActiveHours()) {
      log.debug('Skipping heartbeat — outside active hours', { agentId: this.agentId });
      return;
    }

    this.eventBus.emit('heartbeat:trigger', { agentId: this.agentId, triggeredAt: new Date().toISOString() });
  }

  private isWithinActiveHours(): boolean {
    return isWithinActiveHours(this.config.activeHours!);
  }
}
