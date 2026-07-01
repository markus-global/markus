import { createLogger, type Task } from '@markus/shared';
import type { TaskService } from './task-service.js';

const log = createLogger('scheduled-task-runner');

const MIN_STAGGER_MS = 2 * 60_000;   // 2 minutes
const MAX_STAGGER_MS = 15 * 60_000;  // 15 minutes

/**
 * Evaluates scheduled tasks and re-creates them when their schedule fires.
 * Runs on a fixed poll interval, checking all scheduled tasks to see if
 * their nextRunAt has passed. When it has, the runner resets the task to
 * pending so the normal task execution flow picks it up again.
 *
 * On startup, an initial tick runs immediately to catch any tasks whose
 * nextRunAt elapsed while the system was down.  To avoid a thundering-herd
 * when many overdue tasks exist, each overdue task is staggered by a random
 * delay between MIN_STAGGER_MS and MAX_STAGGER_MS.
 */
export class ScheduledTaskRunner {
  private timer?: ReturnType<typeof setInterval>;
  private staggerTimers: ReturnType<typeof setTimeout>[] = [];
  private running = false;
  private startedAt = 0;

  constructor(
    private taskService: TaskService,
    private pollIntervalMs = 60_000,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();

    this.tick().catch(e => log.error('Initial scheduled task tick failed', { error: String(e) }));

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
    for (const t of this.staggerTimers) clearTimeout(t);
    this.staggerTimers = [];
    this.running = false;
    log.info('ScheduledTaskRunner stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Returns true during the startup grace period (first poll cycle after
   * start).  Used to stagger overdue tasks instead of firing them all at once.
   */
  private isStartupPhase(): boolean {
    return Date.now() - this.startedAt < this.pollIntervalMs;
  }

  private async tick(): Promise<void> {
    const scheduledTasks = this.taskService.listScheduledTasks();
    const now = Date.now();
    const startup = this.isStartupPhase();

    for (const task of scheduledTasks) {
      if (!task.scheduleConfig) continue;

      const config = task.scheduleConfig;

      if (config.maxRuns && config.maxRuns > 0 && (config.currentRuns ?? 0) >= config.maxRuns) {
        continue;
      }

      const nextRun = config.nextRunAt ? new Date(config.nextRunAt).getTime() : 0;
      if (nextRun > now) continue;

      if (['in_progress', 'review', 'blocked', 'pending', 'archived', 'rejected', 'cancelled'].includes(task.status)) {
        continue;
      }

      if (config.paused) {
        continue;
      }

      if (startup && nextRun < this.startedAt) {
        const delay = MIN_STAGGER_MS + Math.random() * (MAX_STAGGER_MS - MIN_STAGGER_MS);
        log.info('Staggering overdue scheduled task', {
          taskId: task.id,
          title: task.title,
          overdueBy: `${Math.round((now - nextRun) / 60_000)}m`,
          firingIn: `${Math.round(delay / 60_000)}m`,
        });
        const timer = setTimeout(() => {
          if (!this.running) return;
          const current = this.taskService.getTask(task.id);
          if (!current || !current.scheduleConfig) return;
          if (current.scheduleConfig.paused) return;
          if (['in_progress', 'review', 'blocked', 'pending', 'archived', 'rejected', 'cancelled'].includes(current.status)) return;
          this.fireScheduledTask(current).catch(e =>
            log.error('Failed to fire staggered scheduled task', { taskId: task.id, error: String(e) }),
          );
        }, delay);
        this.staggerTimers.push(timer);
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

    const resettableStatuses = ['completed', 'failed'];
    if (resettableStatuses.includes(task.status)) {
      await this.taskService.resetTaskForRerun(task.id);
    } else if (!['in_progress', 'review', 'blocked', 'pending', 'cancelled'].includes(task.status)) {
      log.warn('Scheduled task has unexpected status, resetting for rerun', { taskId: task.id, status: task.status });
      await this.taskService.resetTaskForRerun(task.id);
    }

    const current = this.taskService.getTask(task.id);
    if (current && current.status === 'in_progress') {
      try {
        await this.taskService.runTask(task.id);
        log.info('Scheduled task auto-started', { taskId: task.id });
      } catch (err) {
        log.warn('Failed to auto-start scheduled task (agent may be busy)', { taskId: task.id, error: String(err) });
      }
    }
  }
}
