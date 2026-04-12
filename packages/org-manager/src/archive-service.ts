import { createLogger, type ArchivePolicy } from '@markus/shared';
import type { TaskService } from './task-service.js';
import type { ProjectService } from './project-service.js';

const log = createLogger('archive-service');

const DEFAULT_POLICY: ArchivePolicy = {
  autoArchiveAfterDays: 30,
  retainTaskLogsForDays: 90,
  retainAuditLogsForDays: 365,
};

export class ArchiveService {
  private scanInterval?: ReturnType<typeof setInterval>;

  constructor(
    private taskService: TaskService,
    private projectService: ProjectService,
  ) {}

  start(intervalMs = 86400000): void {
    this.scanInterval = setInterval(() => {
      this.runArchiveScan().catch(err => log.warn('Archive scan failed', { error: String(err) }));
    }, intervalMs);
    log.info('Archive service started', { intervalMs });
  }

  stop(): void {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = undefined;
    }
  }

  async runArchiveScan(): Promise<{ archived: number }> {
    let archived = 0;

    const allTasks = this.taskService.listTasks({});
    const now = Date.now();

    for (const task of allTasks) {
      if (task.status !== 'completed') continue;

      const policy = this.getArchivePolicy(task.projectId);
      const completedAt = new Date(task.updatedAt).getTime();
      const ageInDays = (now - completedAt) / 86400000;

      if (ageInDays >= policy.autoArchiveAfterDays) {
        this.taskService.archiveTask(task.id);
        archived++;
      }
    }

    if (archived > 0) {
      log.info('Archive scan complete', { archived });
    }
    return { archived };
  }

  private getArchivePolicy(projectId?: string): ArchivePolicy {
    if (projectId) {
      const project = this.projectService.getProject(projectId);
      if (project?.archivePolicy) return project.archivePolicy;
    }
    return DEFAULT_POLICY;
  }
}
