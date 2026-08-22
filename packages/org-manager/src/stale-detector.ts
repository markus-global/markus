import { createLogger } from '@markus/shared';
import type { TaskService } from './task-service.js';

const log = createLogger('stale-detector');

export interface StaleConfig {
  maxInProgressMs: number;
  maxReviewWaitMs: number;
  maxAssignedUnstartedMs: number;
  maxBranchDivergenceCommits: number;
}

export interface StaleItem {
  type: 'stuck_task' | 'review_stale' | 'unstarted_task' | 'branch_diverged';
  taskId?: string;
  ageMs: number;
  agentId?: string;
  message: string;
}

const DEFAULT_CONFIG: StaleConfig = {
  maxInProgressMs: 24 * 60 * 60 * 1000,
  maxReviewWaitMs: 12 * 60 * 60 * 1000,
  maxAssignedUnstartedMs: 4 * 60 * 60 * 1000,
  maxBranchDivergenceCommits: 100,
};

export class StaleDetector {
  private config: StaleConfig;
  private scanInterval?: ReturnType<typeof setInterval>;
  private onStaleItems?: (items: StaleItem[]) => void;
  /** Keys already notified (taskId:staleType). A key is held until the task is no longer stale,
   *  so the same task is NOT re-notified on every scan — but will be notified again if it
   *  becomes stale a second time after recovering. */
  private notifiedKeys = new Set<string>();

  constructor(
    private taskService: TaskService,
    config?: Partial<StaleConfig>,
    onStaleItems?: (items: StaleItem[]) => void
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.onStaleItems = onStaleItems;
  }

  start(intervalMs = 3600000): void {
    this.scanInterval = setInterval(() => {
      this.scan()
        .then(items => {
          if (items.length > 0 && this.onStaleItems) {
            this.onStaleItems(items);
          }
        })
        .catch(err => log.warn('Stale scan failed', { error: String(err) }));
    }, intervalMs);
    log.info('Stale detector started', { intervalMs });
  }

  stop(): void {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = undefined;
    }
  }

  private key(taskId: string, type: StaleItem['type']): string {
    return `${taskId}:${type}`;
  }

  private pushIfNotNotified(
    staleItems: StaleItem[],
    currentKeys: Set<string>,
    taskId: string,
    type: StaleItem['type'],
    item: Omit<StaleItem, 'type' | 'taskId'>
  ): void {
    const k = this.key(taskId, type);
    currentKeys.add(k);
    if (this.notifiedKeys.has(k)) return;
    this.notifiedKeys.add(k);
    staleItems.push({ type, taskId, ...item });
  }

  async scan(): Promise<StaleItem[]> {
    const staleItems: StaleItem[] = [];
    const allTasks = this.taskService.listTasks({});
    const now = Date.now();
    const currentKeys = new Set<string>();

    for (const task of allTasks) {
      const age = now - new Date(task.updatedAt).getTime();

      if (task.status === 'in_progress' && age > this.config.maxInProgressMs) {
        this.pushIfNotNotified(staleItems, currentKeys, task.id, 'stuck_task', {
          ageMs: age,
          agentId: task.assignedAgentId,
          message: `Task "${task.title}" has been in_progress for ${Math.round(age / 3600000)}h`,
        });
      }

      if (task.status === 'review' && age > this.config.maxReviewWaitMs) {
        this.pushIfNotNotified(staleItems, currentKeys, task.id, 'review_stale', {
          ageMs: age,
          agentId: task.reviewerId ?? task.assignedAgentId,
          message: `Task "${task.title}" has been in review for ${Math.round(age / 3600000)}h with no action`,
        });
      }

      if (task.status === 'pending' && age > this.config.maxAssignedUnstartedMs) {
        this.pushIfNotNotified(staleItems, currentKeys, task.id, 'unstarted_task', {
          ageMs: age,
          agentId: task.assignedAgentId,
          message: `Task "${task.title}" awaiting approval for ${Math.round(age / 3600000)}h`,
        });
      }
    }

    // Release memory for tasks that are no longer stale, so they can be notified again
    // if they become stale a second time (e.g. after recovery).
    for (const k of [...this.notifiedKeys]) {
      if (!currentKeys.has(k)) this.notifiedKeys.delete(k);
    }

    if (staleItems.length > 0) {
      log.info(`Found ${staleItems.length} stale items`);
    }
    return staleItems;
  }
}
