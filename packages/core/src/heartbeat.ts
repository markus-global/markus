import { createLogger } from '@markus/shared';
import type { HeartbeatTask } from '@markus/shared';
import { EventBus } from './events.js';

const log = createLogger('heartbeat');

export interface HeartbeatContext {
  agentId: string;
  task: HeartbeatTask;
  triggeredAt: string;
}

export class HeartbeatScheduler {
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private running = false;

  constructor(
    private agentId: string,
    private eventBus: EventBus,
    private defaultIntervalMs: number = 30 * 60 * 1000,
  ) {}

  start(tasks: HeartbeatTask[]): void {
    if (this.running) return;
    this.running = true;

    for (const task of tasks) {
      if (!task.enabled) continue;
      const interval = task.intervalMs ?? this.defaultIntervalMs;
      const key = `${this.agentId}:${task.name}`;

      log.info(`Scheduling heartbeat task: ${task.name}`, {
        agentId: this.agentId,
        intervalMs: interval,
      });

      const timer = setInterval(() => {
        this.trigger(task);
      }, interval);

      // Trigger immediately on start
      this.trigger(task);
      this.timers.set(key, timer);
    }
  }

  stop(): void {
    this.running = false;
    for (const [key, timer] of this.timers) {
      clearInterval(timer);
      log.info(`Stopped heartbeat task: ${key}`);
    }
    this.timers.clear();
  }

  isRunning(): boolean {
    return this.running;
  }

  private trigger(task: HeartbeatTask): void {
    const context: HeartbeatContext = {
      agentId: this.agentId,
      task,
      triggeredAt: new Date().toISOString(),
    };

    log.debug(`Heartbeat triggered: ${task.name}`, { agentId: this.agentId });
    this.eventBus.emit('heartbeat:trigger', context);
  }
}
