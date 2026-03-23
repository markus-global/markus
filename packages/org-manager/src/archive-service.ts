import { createLogger, type ArchivePolicy } from '@markus/shared';
import type { TaskService } from './task-service.js';
import type { ProjectService } from './project-service.js';
import type { WorkspaceManager } from '@markus/core';

const log = createLogger('archive-service');

const DEFAULT_POLICY: ArchivePolicy = {
  autoArchiveAfterDays: 30,
  deleteWorktreeOnAcceptance: true,
  deleteBranchOnArchive: true,
  retainTaskLogsForDays: 90,
  retainAuditLogsForDays: 365,
};

export class ArchiveService {
  private scanInterval?: ReturnType<typeof setInterval>;

  constructor(
    private taskService: TaskService,
    private projectService: ProjectService,
    private workspaceManager?: WorkspaceManager
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

  async runArchiveScan(): Promise<{
    archived: number;
    worktreesRemoved: number;
    branchesDeleted: number;
  }> {
    let archived = 0;
    let worktreesRemoved = 0;
    let branchesDeleted = 0;

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

        if (policy.deleteBranchOnArchive && task.projectId && this.workspaceManager) {
          const project = this.projectService.getProject(task.projectId);
          if (project?.repositories?.[0]) {
            await this.workspaceManager
              .deleteBranch(project.repositories[0].localPath, task.id)
              .catch(() => {});
            branchesDeleted++;
          }
        }
      }
    }

    if (this.workspaceManager) {
      for (const project of this.projectService.listProjects()) {
        if (!project.repositories?.[0]) continue;
        const repoPath = project.repositories[0].localPath;
        const worktrees = await this.workspaceManager.listWorktrees(repoPath);

        for (const wt of worktrees) {
          if (!wt.taskId) continue;
          const task = this.taskService.getTask(wt.taskId);
          if (!task || ['completed', 'failed', 'cancelled', 'archived'].includes(task.status)) {
            await this.workspaceManager.removeWorktree(repoPath, wt.taskId).catch(() => {});
            worktreesRemoved++;
          }
        }
      }
    }

    if (archived > 0 || worktreesRemoved > 0 || branchesDeleted > 0) {
      log.info('Archive scan complete', { archived, worktreesRemoved, branchesDeleted });
    }
    return { archived, worktreesRemoved, branchesDeleted };
  }

  async archiveIteration(iterationId: string): Promise<void> {
    const iteration = this.projectService.getIteration(iterationId);
    if (!iteration) return;

    const tasks = this.taskService.listTasks({}).filter(t => t.iterationId === iterationId);
    const allDone = tasks.every(t =>
      ['completed', 'failed', 'cancelled', 'archived'].includes(t.status)
    );

    if (allDone) {
      this.projectService.updateIterationStatus(iterationId, 'completed');
      log.info('Iteration archived', { iterationId });
    }
  }

  private getArchivePolicy(projectId?: string): ArchivePolicy {
    if (projectId) {
      const project = this.projectService.getProject(projectId);
      if (project?.archivePolicy) return project.archivePolicy;
    }
    return DEFAULT_POLICY;
  }
}
