import { createLogger } from '@markus/shared';
import type { EventBus } from './events.js';

const log = createLogger('heartbeat');

export interface HeartbeatConfig {
  intervalMs: number;
  enabled: boolean;
  activeHours?: {
    start: string;   // "08:00"
    end: string;     // "22:00"
    timezone?: string;
  };
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
    private config: HeartbeatConfig = { intervalMs: 30 * 60 * 1000, enabled: true },
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

    const delay = initialDelayMs ?? Math.floor(Math.random() * this.config.intervalMs);
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
    const { start, end } = this.config.activeHours!;
    const [startH, startM] = start.split(':').map(Number);
    const [endH, endM] = end.split(':').map(Number);
    const now = new Date();
    const h = now.getHours();
    const m = now.getMinutes();
    const current = h * 60 + m;
    const startMin = startH * 60 + startM;
    const endMin = endH * 60 + endM;

    if (startMin <= endMin) {
      return current >= startMin && current < endMin;
    }
    // Wraps midnight (e.g. 22:00 - 06:00)
    return current >= startMin || current < endMin;
  }
}
