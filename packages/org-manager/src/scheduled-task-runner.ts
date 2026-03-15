import { createLogger, type Task } from '@markus/shared';
import type { TaskService } from './task-service.js';

const log = createLogger('scheduled-task-runner');

/**
 * Evaluates scheduled tasks and re-creates them when their schedule fires.
 * Runs on a fixed poll interval, checking all scheduled tasks to see if
 * their nextRunAt has passed. When it has, the runner resets the task to
 * pending so the normal task execution flow picks it up again.
 */
export class ScheduledTaskRunner {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private taskService: TaskService,
    private pollIntervalMs = 60_000,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      this.tick().catch(e => log.error('Scheduled task tick failed', { error: String(e) }));
    }, this.pollIntervalMs);
    log.info('ScheduledTaskRunner started', { pollIntervalMs: this.pollIntervalMs });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.running = false;
    log.info('ScheduledTaskRunner stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  private async tick(): Promise<void> {
    const scheduledTasks = this.taskService.listScheduledTasks();
    const now = Date.now();

    for (const task of scheduledTasks) {
      if (!task.scheduleConfig) continue;

      const config = task.scheduleConfig;

      if (config.maxRuns !== undefined && (config.currentRuns ?? 0) >= config.maxRuns) {
        continue;
      }

      const nextRun = config.nextRunAt ? new Date(config.nextRunAt).getTime() : 0;
      if (nextRun > now) continue;

      if (['in_progress', 'assigned', 'review', 'revision', 'blocked', 'pending_approval'].includes(task.status)) {
        continue;
      }

      if (config.paused) {
        continue;
      }

      try {
        await this.fireScheduledTask(task);
      } catch (e) {
        log.error('Failed to fire scheduled task', { taskId: task.id, error: String(e) });
      }
    }
  }

  private async fireScheduledTask(task: Task): Promise<void> {
    log.info('Firing scheduled task', { taskId: task.id, title: task.title });

    await this.taskService.advanceScheduleConfig(task.id);

    if (['completed', 'cancelled', 'failed', 'accepted'].includes(task.status)) {
      await this.taskService.resetTaskForRerun(task.id);
    }

    const current = this.taskService.getTask(task.id);
    if (current && current.assignedAgentId && ['assigned', 'pending'].includes(current.status)) {
      try {
        await this.taskService.runTask(task.id);
        log.info('Scheduled task auto-started', { taskId: task.id });
      } catch (err) {
        log.warn('Failed to auto-start scheduled task (agent may be busy)', { taskId: task.id, error: String(err) });
      }
    }
  }
}
