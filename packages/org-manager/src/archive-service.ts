import {
  createLogger,
  ARCHIVE_COMPLETED_AFTER_DAYS,
  ARCHIVE_TERMINAL_AFTER_DAYS,
  ARCHIVE_REQUIREMENT_AFTER_DAYS,
  ARCHIVE_SCAN_INTERVAL_MS,
  type ArchivePolicy,
} from '@markus/shared';
import type { TaskService } from './task-service.js';
import type { ProjectService } from './project-service.js';
import type { RequirementService } from './requirement-service.js';

const log = createLogger('archive-service');

/** Statuses eligible for auto-archive (all terminal except archived itself). */
const ARCHIVABLE_STATUSES = new Set(['completed', 'failed', 'rejected', 'cancelled']);

/** If any comment is newer than this threshold, the item has active discussion. */
const ACTIVE_DISCUSSION_DAYS = 7;
const ACTIVE_DISCUSSION_MS = ACTIVE_DISCUSSION_DAYS * 86_400_000;

export class ArchiveService {
  private scanInterval?: ReturnType<typeof setInterval>;
  private requirementService?: RequirementService;

  constructor(
    private taskService: TaskService,
    private projectService: ProjectService,
  ) {}

  setRequirementService(svc: RequirementService): void {
    this.requirementService = svc;
  }

  /**
   * Start periodic archive scans. Runs an initial scan immediately,
   * then repeats at the configured interval.
   */
  start(intervalMs = ARCHIVE_SCAN_INTERVAL_MS): void {
    this.runArchiveScan().catch(err =>
      log.warn('Initial archive scan failed', { error: String(err) }),
    );

    this.scanInterval = setInterval(() => {
      this.runArchiveScan().catch(err =>
        log.warn('Archive scan failed', { error: String(err) }),
      );
    }, intervalMs);
    log.info('Archive service started', { intervalMs });
  }

  stop(): void {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = undefined;
    }
  }

  async runArchiveScan(): Promise<{ archivedTasks: number; archivedRequirements: number }> {
    const archivedTasks = await this.archiveTasks();
    const archivedRequirements = this.archiveRequirements();

    if (archivedTasks > 0 || archivedRequirements > 0) {
      log.info('Archive scan complete', { archivedTasks, archivedRequirements });
    }
    return { archivedTasks, archivedRequirements };
  }

  private async archiveTasks(): Promise<number> {
    let archived = 0;
    const allTasks = this.taskService.listTasks({});
    const now = Date.now();

    for (const task of allTasks) {
      if (!ARCHIVABLE_STATUSES.has(task.status)) continue;

      const policy = this.getArchivePolicy(task.projectId);
      const thresholdDays = task.status === 'completed'
        ? policy.autoArchiveAfterDays
        : ARCHIVE_TERMINAL_AFTER_DAYS;

      const terminalSince = this.getTerminalTimestamp(task);
      const ageInDays = (now - terminalSince) / 86_400_000;

      if (ageInDays >= thresholdDays) {
        try {
          const comments = await this.taskService.getTaskComments(task.id);
          if (this.hasRecentComments(comments, now)) continue;
          this.taskService.archiveTask(task.id);
          archived++;
        } catch (err) {
          log.warn('Failed to archive task', { taskId: task.id, error: String(err) });
        }
      }
    }
    return archived;
  }

  private archiveRequirements(): number {
    if (!this.requirementService) return 0;

    let archived = 0;
    const allReqs = this.requirementService.listRequirements({});
    const now = Date.now();

    for (const req of allReqs) {
      if (!ARCHIVABLE_STATUSES.has(req.status)) continue;

      const terminalSince = new Date(req.updatedAt).getTime();
      const ageInDays = (now - terminalSince) / 86_400_000;

      if (ageInDays >= ARCHIVE_REQUIREMENT_AFTER_DAYS) {
        try {
          const comments = this.taskService.getRequirementComments(req.id);
          if (this.hasRecentComments(comments, now)) continue;
          this.requirementService.updateRequirementStatus(req.id, 'archived');
          archived++;
        } catch (err) {
          log.warn('Failed to archive requirement', { requirementId: req.id, error: String(err) });
        }
      }
    }
    return archived;
  }

  /**
   * Check whether the entity has comments newer than the active-discussion threshold.
   * Suppresses archiving while people are still talking.
   */
  private hasRecentComments(comments: Array<{ createdAt: string }>, now: number): boolean {
    if (!comments || comments.length === 0) return false;
    const newest = comments.reduce((latest, c) =>
      c.createdAt > latest ? c.createdAt : latest, comments[0]!.createdAt);
    return (now - new Date(newest).getTime()) < ACTIVE_DISCUSSION_MS;
  }

  /**
   * Best-effort extraction of when the task entered its current terminal status.
   * Prefers `completedAt` for completed tasks; falls back to `updatedAt`.
   */
  private getTerminalTimestamp(task: { completedAt?: string; updatedAt: string }): number {
    if (task.completedAt) return new Date(task.completedAt).getTime();
    return new Date(task.updatedAt).getTime();
  }

  private getArchivePolicy(projectId?: string): ArchivePolicy {
    if (projectId) {
      const project = this.projectService.getProject(projectId);
      if (project?.archivePolicy) return project.archivePolicy;
    }
    return {
      autoArchiveAfterDays: ARCHIVE_COMPLETED_AFTER_DAYS,
      retainTaskLogsForDays: 90,
      retainAuditLogsForDays: 365,
    };
  }
}
