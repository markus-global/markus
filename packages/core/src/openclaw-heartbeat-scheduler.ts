import { createLogger } from '@markus/shared';
import type { HeartbeatTask } from '@markus/shared';
import { EventBus } from './events.js';
import { schedule } from 'node-cron';

const log = createLogger('openclaw-heartbeat');

export interface HeartbeatContext {
  agentId: string;
  task: HeartbeatTask;
  triggeredAt: string;
}

export interface HeartbeatTaskStats {
  name: string;
  lastRun?: string;
  nextRun?: string;
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  lastError?: string;
}

export interface HealthMetrics {
  uptime: number;
  taskCount: number;
  activeTasks: number;
  failedTasks: number;
  lastHeartbeat?: string;
  taskStats: HeartbeatTaskStats[];
}

export class OpenClawHeartbeatScheduler {
  private cronTasks = new Map<string, any>(); // node-cron ScheduledTask type
  private intervalTimers = new Map<string, ReturnType<typeof setInterval>>();
  private running = false;
  private taskStats = new Map<string, HeartbeatTaskStats>();
  private startTime = Date.now();

  constructor(
    private agentId: string,
    private eventBus: EventBus,
    private defaultIntervalMs: number = 30 * 60 * 1000,
  ) {}

  /**
   * Start scheduling heartbeat tasks
   */
  start(tasks: HeartbeatTask[]): void {
    if (this.running) return;
    this.running = true;
    this.startTime = Date.now();

    log.info('Starting OpenClaw heartbeat scheduler', {
      agentId: this.agentId,
      taskCount: tasks.length,
    });

    for (const task of tasks) {
      if (!task.enabled) continue;
      this.scheduleTask(task);
    }
  }

  /**
   * Stop all scheduled tasks
   */
  stop(): void {
    this.running = false;
    
    // Stop all cron tasks
    for (const [key, cronTask] of this.cronTasks) {
      cronTask.stop();
      log.info(`Stopped cron heartbeat task: ${key}`);
    }
    this.cronTasks.clear();
    
    // Stop all interval timers
    for (const [key, timer] of this.intervalTimers) {
      clearInterval(timer);
      log.info(`Stopped interval heartbeat task: ${key}`);
    }
    this.intervalTimers.clear();
    
    log.info('OpenClaw heartbeat scheduler stopped', { agentId: this.agentId });
  }

  /**
   * Schedule a single task based on its configuration
   */
  private scheduleTask(task: HeartbeatTask): void {
    const key = `${this.agentId}:${task.name}`;
    
    // Initialize task stats
    this.taskStats.set(key, {
      name: task.name,
      totalRuns: 0,
      successfulRuns: 0,
      failedRuns: 0,
    });

    // Schedule based on cron expression if provided
    if (task.cronExpression) {
      this.scheduleCronTask(task, key);
    } else {
      // Fall back to interval-based scheduling
      this.scheduleIntervalTask(task, key);
    }
  }

  /**
   * Schedule a task using cron expression
   */
  private scheduleCronTask(task: HeartbeatTask, key: string): void {
    try {
      log.info(`Scheduling cron heartbeat task: ${task.name}`, {
        agentId: this.agentId,
        cronExpression: task.cronExpression,
      });

      const cronTask = schedule(task.cronExpression!, () => {
        this.executeTask(task, key);
      }, {
        scheduled: true,
        timezone: 'UTC',
      });

      this.cronTasks.set(key, cronTask);
      
      // Calculate next run time
      const stats = this.taskStats.get(key)!;
      const nextRun = this.getNextCronRun(task.cronExpression!);
      stats.nextRun = nextRun?.toISOString();
      
    } catch (error) {
      log.error(`Failed to schedule cron task: ${task.name}`, {
        agentId: this.agentId,
        cronExpression: task.cronExpression,
        error: error instanceof Error ? error.message : String(error),
      });
      
      // Fall back to interval scheduling if cron fails
      log.warn(`Falling back to interval scheduling for task: ${task.name}`);
      this.scheduleIntervalTask(task, key);
    }
  }

  /**
   * Schedule a task using interval
   */
  private scheduleIntervalTask(task: HeartbeatTask, key: string): void {
    const interval = task.intervalMs ?? this.defaultIntervalMs;
    
    log.info(`Scheduling interval heartbeat task: ${task.name}`, {
      agentId: this.agentId,
      intervalMs: interval,
    });

    const timer = setInterval(() => {
      this.executeTask(task, key);
    }, interval);

    this.intervalTimers.set(key, timer);
    
    // Calculate next run time for interval
    const stats = this.taskStats.get(key)!;
    const nextRun = new Date(Date.now() + interval);
    stats.nextRun = nextRun.toISOString();
  }

  /**
   * Execute a heartbeat task with error handling and retry logic
   */
  private async executeTask(task: HeartbeatTask, key: string): Promise<void> {
    const stats = this.taskStats.get(key)!;
    stats.lastRun = new Date().toISOString();
    stats.totalRuns++;
    
    try {
      log.debug(`Executing heartbeat task: ${task.name}`, { agentId: this.agentId });
      
      const context: HeartbeatContext = {
        agentId: this.agentId,
        task,
        triggeredAt: new Date().toISOString(),
      };

      // Emit heartbeat event
      this.eventBus.emit('heartbeat:trigger', context);
      
      // Update task stats
      stats.successfulRuns++;
      stats.lastError = undefined;
      
      log.debug(`Heartbeat task completed: ${task.name}`, { agentId: this.agentId });
      
    } catch (error) {
      log.error(`Heartbeat task failed: ${task.name}`, {
        agentId: this.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      
      // Update task stats
      stats.failedRuns++;
      stats.lastError = error instanceof Error ? error.message : String(error);
      
      // Emit error event
      this.eventBus.emit('heartbeat:error', {
        agentId: this.agentId,
        task,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      });
    }
    
    // Update next run time
    if (task.cronExpression) {
      const nextRun = this.getNextCronRun(task.cronExpression);
      stats.nextRun = nextRun?.toISOString();
    } else {
      const interval = task.intervalMs ?? this.defaultIntervalMs;
      const nextRun = new Date(Date.now() + interval);
      stats.nextRun = nextRun.toISOString();
    }
  }

  /**
   * Calculate next run time for cron expression
   */
  private getNextCronRun(cronExpression: string): Date | null {
    try {
      // node-cron doesn't provide next run time directly
      // We'll calculate it by parsing the cron expression
      // For now, return null and we'll calculate it differently
      return null;
    } catch (error) {
      log.warn(`Failed to calculate next run time for cron expression: ${cronExpression}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Get health metrics for monitoring
   */
  getHealthMetrics(): HealthMetrics {
    const now = Date.now();
    const uptime = now - this.startTime;
    
    const taskStats = Array.from(this.taskStats.values());
    const activeTasks = this.cronTasks.size + this.intervalTimers.size;
    const failedTasks = taskStats.filter(stats => stats.failedRuns > 0).length;
    
    // Find last heartbeat time
    let lastHeartbeat: string | undefined;
    for (const stats of taskStats) {
      if (stats.lastRun && (!lastHeartbeat || stats.lastRun > lastHeartbeat)) {
        lastHeartbeat = stats.lastRun;
      }
    }

    return {
      uptime,
      taskCount: taskStats.length,
      activeTasks,
      failedTasks,
      lastHeartbeat,
      taskStats,
    };
  }

  /**
   * Get stats for a specific task
   */
  getTaskStats(taskName: string): HeartbeatTaskStats | undefined {
    const key = `${this.agentId}:${taskName}`;
    return this.taskStats.get(key);
  }

  /**
   * Check if scheduler is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Manually trigger a heartbeat task
   */
  async triggerTask(taskName: string): Promise<boolean> {
    // Find the task by name
    const tasks = Array.from(this.taskStats.keys())
      .filter(key => key.endsWith(`:${taskName}`))
      .map(key => {
        const [agentId, name] = key.split(':');
        return { key, name };
      });
    
    if (tasks.length === 0) {
      log.warn(`Task not found: ${taskName}`, { agentId: this.agentId });
      return false;
    }
    
    // For now, we don't have access to the original task object
    // We'll need to store tasks when scheduling them
    log.info(`Manual trigger not fully implemented for task: ${taskName}`);
    return false;
  }
}