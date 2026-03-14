import { createLogger, type Task, type ScheduleConfig } from '@markus/shared';
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

      if (task.status === 'in_progress' || task.status === 'assigned') {
        continue;
      }

      try {
        await this.fireScheduledTask(task, config);
      } catch (e) {
        log.error('Failed to fire scheduled task', { taskId: task.id, error: String(e) });
      }
    }
  }

  private async fireScheduledTask(task: Task, config: ScheduleConfig): Promise<void> {
    log.info('Firing scheduled task', { taskId: task.id, title: task.title });

    const currentRuns = (config.currentRuns ?? 0) + 1;
    const nextRunAt = this.computeNextRun(config);

    const updatedConfig: ScheduleConfig = {
      ...config,
      currentRuns,
      lastRunAt: new Date().toISOString(),
      nextRunAt,
    };

    await this.taskService.updateScheduleConfig(task.id, updatedConfig);

    if (task.status === 'completed' || task.status === 'cancelled' || task.status === 'failed') {
      await this.taskService.resetTaskForRerun(task.id);
    }
  }

  /**
   * Compute the next run time based on the schedule config.
   * Supports `every` (interval shorthand) and `cron` expressions.
   * Returns undefined if the schedule is exhausted or one-shot.
   */
  private computeNextRun(config: ScheduleConfig): string | undefined {
    if (config.runAt) {
      return undefined;
    }

    if (config.every) {
      const ms = parseInterval(config.every);
      if (ms > 0) {
        return new Date(Date.now() + ms).toISOString();
      }
    }

    if (config.cron) {
      const ms = estimateCronInterval(config.cron);
      if (ms > 0) {
        return new Date(Date.now() + ms).toISOString();
      }
    }

    return undefined;
  }
}

function parseInterval(shorthand: string): number {
  const match = shorthand.match(/^(\d+)(ms|s|m|h|d|w)$/);
  if (!match) return 0;
  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  return value * (multipliers[unit] ?? 0);
}

/**
 * Simple heuristic to estimate the next interval from a cron expression.
 * For production use this could be replaced with a proper cron parser library,
 * but for now we handle common patterns.
 */
function estimateCronInterval(cron: string): number {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return 3_600_000;

  const [minute, hour] = parts;

  if (minute !== '*' && hour === '*') {
    return 3_600_000;
  }
  if (minute !== '*' && hour !== '*') {
    return 86_400_000;
  }

  return 3_600_000;
}
