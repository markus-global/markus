import { createLogger } from '@markus/shared';
import type { TaskService } from './task-service.js';

const log = createLogger('stale-detector');

export interface StaleConfig {
  maxInProgressMs: number;
  maxReviewWaitMs: number;
  maxAssignedUnstartedMs: number;
  maxBranchDivergenceCommits: number;
  /** ID of the agent to escalate stale review tasks to (e.g. team manager). */
  escalationTargetId?: string;
}

export interface StaleItem {
  type: 'stuck_task' | 'review_stale' | 'unstarted_task' | 'branch_diverged';
  taskId?: string;
  ageMs: number;
  agentId?: string;
  message: string;
  /** True if the detector auto-escalated this stale item. */
  escalated?: boolean;
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
        const hours = Math.round(age / 3600000);
        const staleReviewerId = task.reviewerId ?? task.assignedAgentId;
        const item: StaleItem = {
          type: 'review_stale',
          taskId: task.id,
          ageMs: age,
          agentId: staleReviewerId,
          message: `Task "${task.title}" has been in review for ${hours}h with no action`,
        };

        // Auto-escalate: if an escalation target is configured and the reviewer is different,
        // reassign the reviewer and add a note so the task doesn't get stuck.
        if (this.config.escalationTargetId && staleReviewerId !== this.config.escalationTargetId) {
          try {
            this.taskService.addTaskNote(
              task.id,
              `[Auto-escalation] Reviewer (${staleReviewerId}) did not act for ${hours}h. Escalating to ${this.config.escalationTargetId}.`,
              'system',
            );
            this.taskService.updateTask(task.id, { reviewerId: this.config.escalationTargetId }, 'system');
            log.warn('Auto-escalated stale review task', {
              taskId: task.id,
              from: staleReviewerId,
              to: this.config.escalationTargetId,
              hours,
            });
            item.escalated = true;
          } catch (err) {
            log.warn('Auto-escalation failed', { taskId: task.id, error: String(err) });
          }
        }

        staleItems.push(item);
      }

      if (task.status === 'pending' && age > this.config.maxAssignedUnstartedMs) {
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
