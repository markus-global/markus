import { createLogger } from '@markus/shared';
import type { HeartbeatTask } from '@markus/shared';
import { EventBus } from './events.js';
import { OpenClawHeartbeatScheduler } from './openclaw-heartbeat-scheduler.js';

const log = createLogger('heartbeat');

export interface HeartbeatContext {
  agentId: string;
  task: HeartbeatTask;
  triggeredAt: string;
}

export { type HeartbeatTaskStats, type HealthMetrics } from './openclaw-heartbeat-scheduler.js';

export class HeartbeatScheduler {
  private scheduler: OpenClawHeartbeatScheduler;

  constructor(
    private agentId: string,
    private eventBus: EventBus,
    private defaultIntervalMs: number = 30 * 60 * 1000,
  ) {
    this.scheduler = new OpenClawHeartbeatScheduler(agentId, eventBus, defaultIntervalMs);
  }

  start(tasks: HeartbeatTask[]): void {
    log.info('Starting heartbeat scheduler', {
      agentId: this.agentId,
      taskCount: tasks.length,
    });
    
    this.scheduler.start(tasks);
  }

  stop(): void {
    log.info('Stopping heartbeat scheduler', { agentId: this.agentId });
    this.scheduler.stop();
  }

  isRunning(): boolean {
    return this.scheduler.isRunning();
  }

  /**
   * Get health metrics for monitoring
   */
  getHealthMetrics(): ReturnType<OpenClawHeartbeatScheduler['getHealthMetrics']> {
    return this.scheduler.getHealthMetrics();
  }

  /**
   * Get stats for a specific task
   */
  getTaskStats(taskName: string): ReturnType<OpenClawHeartbeatScheduler['getTaskStats']> {
    return this.scheduler.getTaskStats(taskName);
  }

  /**
   * Manually trigger a heartbeat task
   */
  async triggerTask(taskName: string): Promise<boolean> {
    return this.scheduler.triggerTask(taskName);
  }

  /**
   * List all registered heartbeat tasks with their config and stats.
   */
  listTasks(): ReturnType<OpenClawHeartbeatScheduler['listTasks']> {
    return this.scheduler.listTasks();
  }

  /**
   * Update the schedule of an existing heartbeat task at runtime.
   */
  updateTaskSchedule(
    taskName: string,
    update: { intervalMs?: number; cronExpression?: string },
  ): boolean {
    return this.scheduler.updateTaskSchedule(taskName, update);
  }

  /**
   * Enable a previously disabled heartbeat task.
   */
  enableTask(taskName: string): boolean {
    return this.scheduler.enableTask(taskName);
  }

  /**
   * Disable a heartbeat task (stop scheduling, keep definition).
   */
  disableTask(taskName: string): boolean {
    return this.scheduler.disableTask(taskName);
  }
}