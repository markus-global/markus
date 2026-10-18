import { createLogger, type NotificationI18n } from '@markus/shared';
import type { TaskService } from './task-service.js';

const log = createLogger('stale-detector');

export interface StaleConfig {
  maxInProgressMs: number;
  /**
   * Reviewer-facing reminder: a card sitting in review with no action for this long
   * wakes the REVIEWER, not a human. Sized against real behaviour — a competent
   * review of a large card takes 3–8 minutes, so 30 minutes means "this turn
   * produced nothing", not "the reviewer is slow".
   */
  reviewReminderMs: number;
  /**
   * Human escalation: only after the reviewer has already been reminded and the card
   * is STILL untouched does a human get a notification.
   *
   * History: this used to be the ONLY review signal (12h, humans only). Reviewers were
   * never reminded at all, so a review turn that produced no action (2026-10-17: four
   * cards, two independent reviewers, 21s/26s/45s turns) sat silent until a human
   * happened to notice 15 hours later. Notify the responsible party first.
   */
  maxReviewWaitMs: number;
  maxAssignedUnstartedMs: number;
  maxBranchDivergenceCommits: number;
}

export interface StaleItem {
  type: 'stuck_task' | 'review_reminder' | 'review_stale' | 'unstarted_task' | 'branch_diverged';
  taskId?: string;
  ageMs: number;
  agentId?: string;
  message: string;
  /**
   * The sentence as structure — the key and its params. The detector knows what to
   * say; only the consumer knows which language the reader wants, so the sentence
   * travels as data rather than as the English literal above.
   */
  i18n?: NotificationI18n;
}

const DEFAULT_CONFIG: StaleConfig = {
  maxInProgressMs: 24 * 60 * 60 * 1000,
  reviewReminderMs: 30 * 60 * 1000,
  maxReviewWaitMs: 4 * 60 * 60 * 1000,
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
          i18n: {
            bodyKey: 'notifications.bodies.staleTaskInProgress',
            bodyParams: { title: task.title, hours: Math.round(age / 3600000) },
          },
        });
      }

      // `age` is measured from `updatedAt`, which IS the authoritative "last time anyone
      // touched this card" fact. A card whose updatedAt still equals its submission
      // timestamp has not been acted on at all — measured scoped to the current review
      // round, this separated all four 2026-10-17 stuck cards from the 20 review turns
      // that really did decide, with no false positives and no new instrumentation.
      if (task.status === 'review' && age > this.config.reviewReminderMs) {
        this.pushIfNotNotified(staleItems, currentKeys, task.id, 'review_reminder', {
          ageMs: age,
          agentId: task.reviewerId ?? task.assignedAgentId,
          message: `Task "${task.title}" has been awaiting your review for ${Math.round(age / 60000)}min with no action on the card`,
          i18n: {
            bodyKey: 'notifications.bodies.staleTaskInReview',
            bodyParams: { title: task.title, hours: Math.round(age / 3600000) },
          },
        });
      }

      if (task.status === 'review' && age > this.config.maxReviewWaitMs) {
        this.pushIfNotNotified(staleItems, currentKeys, task.id, 'review_stale', {
          ageMs: age,
          agentId: task.reviewerId ?? task.assignedAgentId,
          message: `Task "${task.title}" has been in review for ${Math.round(age / 3600000)}h with no action`,
          i18n: {
            bodyKey: 'notifications.bodies.staleTaskInReview',
            bodyParams: { title: task.title, hours: Math.round(age / 3600000) },
          },
        });
      }

      if (task.status === 'pending' && age > this.config.maxAssignedUnstartedMs) {
        this.pushIfNotNotified(staleItems, currentKeys, task.id, 'unstarted_task', {
          ageMs: age,
          agentId: task.assignedAgentId,
          message: `Task "${task.title}" awaiting approval for ${Math.round(age / 3600000)}h`,
          i18n: {
            bodyKey: 'notifications.bodies.staleTaskUnstarted',
            bodyParams: { title: task.title, hours: Math.round(age / 3600000) },
          },
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
