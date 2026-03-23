import { createLogger } from '@markus/shared';
import type { TaskService } from './task-service.js';

const log = createLogger('stale-detector');

export interface StaleConfig {
  maxInProgressMs: number;
  maxReviewWaitMs: number;
  maxAssignedUnstartedMs: number;
  iterationOverdueGraceDays: number;
  maxBranchDivergenceCommits: number;
}

export interface StaleItem {
  type: 'stuck_task' | 'review_stale' | 'unstarted_task' | 'iteration_overdue' | 'branch_diverged';
  taskId?: string;
  iterationId?: string;
  ageMs: number;
  agentId?: string;
  message: string;
}

const DEFAULT_CONFIG: StaleConfig = {
  maxInProgressMs: 24 * 60 * 60 * 1000,
  maxReviewWaitMs: 12 * 60 * 60 * 1000,
  maxAssignedUnstartedMs: 4 * 60 * 60 * 1000,
  iterationOverdueGraceDays: 1,
  maxBranchDivergenceCommits: 100,
};

export class StaleDetector {
  private config: StaleConfig;
  private scanInterval?: ReturnType<typeof setInterval>;

  constructor(
    private taskService: TaskService,
    config?: Partial<StaleConfig>
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  start(intervalMs = 3600000): void {
    this.scanInterval = setInterval(() => {
      this.scan().catch(err => log.warn('Stale scan failed', { error: String(err) }));
    }, intervalMs);
    log.info('Stale detector started', { intervalMs });
  }

  stop(): void {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = undefined;
    }
  }

  async scan(): Promise<StaleItem[]> {
    const staleItems: StaleItem[] = [];
    const allTasks = this.taskService.listTasks({});
    const now = Date.now();

    for (const task of allTasks) {
      const age = now - new Date(task.updatedAt).getTime();

      if (task.status === 'in_progress' && age > this.config.maxInProgressMs) {
        staleItems.push({
          type: 'stuck_task',
          taskId: task.id,
          ageMs: age,
          agentId: task.assignedAgentId,
          message: `Task "${task.title}" has been in_progress for ${Math.round(age / 3600000)}h`,
        });
      }

      if (task.status === 'review' && age > this.config.maxReviewWaitMs) {
        staleItems.push({
          type: 'review_stale',
          taskId: task.id,
          ageMs: age,
          agentId: task.reviewerAgentId ?? task.assignedAgentId,
          message: `Task "${task.title}" has been in review for ${Math.round(age / 3600000)}h with no action`,
        });
      }

      if (task.status === 'pending_approval' && age > this.config.maxAssignedUnstartedMs) {
        staleItems.push({
          type: 'unstarted_task',
          taskId: task.id,
          ageMs: age,
          agentId: task.assignedAgentId,
          message: `Task "${task.title}" awaiting approval for ${Math.round(age / 3600000)}h`,
        });
      }
    }

    if (staleItems.length > 0) {
      log.info(`Found ${staleItems.length} stale items`);
    }
    return staleItems;
  }
}
