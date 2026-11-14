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

/**
 * 重构 2：心跳巡检状态指纹（纯函数，可确定性单测）。
 *
 * 编码「与 LLM 巡检相关的 agent 状态」—— 队列内容 + 活跃任务。仅当指纹变化时
 * 才值得运行一次心跳 LLM 巡检；指纹不变 → skip（只写时间戳落库，不空转 LLM）。
 *
 * 维度设计（对照 docs/agent-liveness-redesign.md §三.2「LLM 巡检只在有实际变化时发生」）：
 *   · 队列签名：**内容（sourceType + item id）**而非深度 —— 同一邮件一直挂着不构成
 *     「状态变化」；新邮件到达（新 id）才触发。修复旧实现「队列深度相同即 skip /
 *     队列深度变化即巡检」的双向误判：同一邮件挂一天不空转 LLM，新邮件却立刻感知。
 *   · 活跃任务签名：任务开始/结束 → 巡检一次；任务集稳定 → 不巡检（任务会话自己
 *     在做 LLM 工作，心跳不需要重复巡检）。
 *
 * 特意**不含** lastHeartbeat 时间戳（skip 也会写它 → 含则指纹恒变化 → 永远巡检）。
 */
export function heartbeatStateFingerprint(
  queued: Array<{ sourceType: string; id: string }>,
  activeTaskIds: Iterable<string>,
): string {
  const queue = queued
    .filter(i => i.sourceType !== 'heartbeat')
    .map(i => `${i.sourceType}:${i.id}`)
    .sort()
    .join(',');
  const tasks = [...activeTaskIds].sort().join(',');
  return `q:[${queue}]|t:[${tasks}]`;
}

/**
 * C8-C: which periodic driver owns this heartbeat.
 *
 *  · `clock`  (default) — `AgentClock` is the ONLY timer; the scheduler owns none and is
 *    invoked through a named clock source. One agent ⇒ one periodic driver.
 *  · `legacy` — the pre-C8-C private `setTimeout` + `setInterval` pair. Kept as an
 *    independently flippable rollback channel (`MARKUS_HEARTBEAT_CLOCK=legacy`); flipping
 *    it never changes the dream channel.
 */
export type HeartbeatTimerMode = 'clock' | 'legacy';

/** The clock port this scheduler registers itself on (structurally `AgentClock`). */
export interface HeartbeatClockPort {
  register(source: { name: string; everyMs: number; initialDelayMs?: number; fn: () => void | Promise<void> }): void;
  unregister(name: string): void;
}

/** Name of the clock source that carries the heartbeat cadence. */
export const HEARTBEAT_CLOCK_SOURCE = 'heartbeat';

export interface HeartbeatSchedulerOptions {
  /** Cadence owner. Defaults to `clock`. */
  mode?: HeartbeatTimerMode;
  /** Required for `clock` mode; without it the scheduler falls back to `legacy`. */
  clock?: HeartbeatClockPort;
}

export class HeartbeatScheduler {
  private initialTimer?: ReturnType<typeof setTimeout>;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private startTime = Date.now();
  private effectiveInitialDelayMs = 0;
  private readonly mode: HeartbeatTimerMode;
  private readonly clock?: HeartbeatClockPort;

  constructor(
    private agentId: string,
    private eventBus: EventBus,
    private config: HeartbeatConfig = { intervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS, enabled: true },
    options: HeartbeatSchedulerOptions = {},
  ) {
    // `clock` mode without a clock port would silently never fire — that is a missing
    // wiring bug, so degrade to the legacy timer (which at least runs) and say so loudly
    // rather than becoming a dead heartbeat nobody notices.
    this.clock = options.clock;
    this.mode = options.mode === 'clock' && this.clock ? 'clock' : 'legacy';
    if (options.mode === 'clock' && !this.clock) {
      log.warn('Heartbeat requested clock mode without a clock port — using legacy timer', {
        agentId: this.agentId,
      });
    }
  }

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
      mode: this.mode,
      intervalMs: this.config.intervalMs,
      initialDelayMs: delay,
      activeHours: this.config.activeHours,
    });

    if (this.mode === 'clock') {
      // One timer for the whole agent: register the cadence, own nothing.
      this.registerClockSource(delay);
      return;
    }

    this.initialTimer = setTimeout(() => {
      this.initialTimer = undefined;
      this.tick();
      this.timer = setInterval(() => this.tick(), this.config.intervalMs);
    }, delay);
  }

  private registerClockSource(initialDelayMs?: number): void {
    this.clock!.register({
      name: HEARTBEAT_CLOCK_SOURCE,
      everyMs: this.config.intervalMs,
      initialDelayMs: initialDelayMs ?? Math.floor(Math.random() * this.config.intervalMs),
      fn: () => this.tick(),
    });
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
    if (this.mode === 'clock') this.clock?.unregister(HEARTBEAT_CLOCK_SOURCE);
    this.running = false;
    log.info('Heartbeat scheduler stopped', { agentId: this.agentId, mode: this.mode });
  }

  /**
   * Change the heartbeat interval and apply it live. If the scheduler is running,
   * the cadence is re-armed immediately with fresh jitter (avoiding a thundering
   * herd) — by re-registering the clock source in `clock` mode, or by restarting
   * the private timer in `legacy` mode.
   */
  updateInterval(intervalMs: number): void {
    this.config.intervalMs = intervalMs;
    log.info('Heartbeat interval updated', { agentId: this.agentId, intervalMs });
    if (!this.running) return;
    if (this.mode === 'clock') {
      this.registerClockSource();
      return;
    }
    this.stop();
    this.start();
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
    this.emitTrigger();
  }

  /**
   * One liveness beat. Public because in `clock` mode the cadence owner is
   * `AgentClock`, which invokes this through the registered source.
   *
   * It emits exactly one observable event and does nothing else: no mailbox row, no
   * timer. Whether a beat becomes a patrol is the listener's decision (see Agent).
   */
  tick(): void {
    if (!this.running) return;

    if (this.config.activeHours && !this.isWithinActiveHours()) {
      log.debug('Skipping heartbeat — outside active hours', { agentId: this.agentId });
      return;
    }

    this.emitTrigger();
  }

  private emitTrigger(): void {
    this.eventBus.emit('heartbeat:trigger', {
      agentId: this.agentId,
      triggeredAt: new Date().toISOString(),
      mode: this.mode,
    });
  }

  /** Which periodic driver owns this heartbeat — for status surfaces and probes. */
  getMode(): HeartbeatTimerMode {
    return this.mode;
  }

  private isWithinActiveHours(): boolean {
    return isWithinActiveHours(this.config.activeHours!);
  }
}
