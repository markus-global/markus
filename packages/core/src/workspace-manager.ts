import { createLogger } from '@markus/shared';
import { join } from 'node:path';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(execCb);
const log = createLogger('workspace-manager');

export interface ProjectRepositoryRef {
  url?: string;
  localPath: string;
  defaultBranch: string;
  role: 'primary' | 'secondary';
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  taskId?: string;
  head: string;
}

export interface MergeResult {
  success: boolean;
  merged: boolean;
  conflicts?: string[];
  message: string;
}

export interface DiffStats {
  filesChanged: number;
  additions: number;
  deletions: number;
}

export class WorkspaceManager {
  async createWorktreeForTask(
    task: { id: string; projectId?: string },
    projectRepos: ProjectRepositoryRef[],
    repoIndex?: number
  ): Promise<string> {
    const repo = projectRepos[repoIndex ?? 0];
    if (!repo) throw new Error('No repository configured for this project');

    const worktreePath = join(repo.localPath, '.worktrees', `task-${task.id}`);
    const branchName = `task/${task.id}`;

    try {
      await execAsync(
        `git worktree add "${worktreePath}" -b "${branchName}" "${repo.defaultBranch}"`,
        { cwd: repo.localPath }
      );
      log.info('Worktree created', { taskId: task.id, path: worktreePath, branch: branchName });
      return worktreePath;
    } catch (err: unknown) {
      const _err = err as Record<string, string>;
      if (_err.message?.includes('already exists')) {
        log.warn('Worktree already exists, reusing', { taskId: task.id, path: worktreePath });
        return worktreePath;
      }
      throw err;
    }
  }

  async removeWorktree(repoPath: string, taskId: string): Promise<void> {
    const worktreePath = join(repoPath, '.worktrees', `task-${taskId}`);
    try {
      await execAsync(`git worktree remove "${worktreePath}" --force`, { cwd: repoPath });
      log.info('Worktree removed', { taskId, path: worktreePath });
    } catch (err) {
      log.warn('Failed to remove worktree (may already be gone)', { taskId, error: String(err) });
    }
  }

  async listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
    try {
      const { stdout } = await execAsync('git worktree list --porcelain', { cwd: repoPath });
      const worktrees: WorktreeInfo[] = [];
      let current: Partial<WorktreeInfo> = {};

      for (const line of stdout.split('\n')) {
        if (line.startsWith('worktree ')) {
          if (current.path) worktrees.push(current as WorktreeInfo);
          const wtPath = line.slice(9);
          current = { path: wtPath };
          const match = wtPath.match(/task-(.+)$/);
          if (match) current.taskId = match[1];
        } else if (line.startsWith('HEAD ')) {
          current.head = line.slice(5);
        } else if (line.startsWith('branch ')) {
          current.branch = line.slice(7);
        }
      }
      if (current.path) worktrees.push(current as WorktreeInfo);
      return worktrees;
    } catch {
      return [];
    }
  }

  async mergeTaskBranch(
    repoPath: string,
    taskId: string,
    targetBranch?: string
  ): Promise<MergeResult> {
    const branchName = `task/${taskId}`;
    const target = targetBranch ?? 'main';

    try {
      await execAsync(`git checkout "${target}"`, { cwd: repoPath });
      const { stdout } = await execAsync(
        `git merge --no-ff "${branchName}" -m "Merge ${branchName}"`,
        {
          cwd: repoPath,
        }
      );
      log.info('Branch merged', { taskId, branch: branchName, target });
      return { success: true, merged: true, message: stdout.trim() };
    } catch (err: unknown) {
      const _err = err as Record<string, string>;
      const msg = String(_err.stderr || _err.stdout || _err.message);
      if (msg.includes('CONFLICT')) {
        await execAsync('git merge --abort', { cwd: repoPath }).catch(() => {});
        const conflicts = msg.match(/CONFLICT \(.*?\): (.+)/g)?.map(c => c) ?? [];
        return { success: false, merged: false, conflicts, message: 'Merge conflicts detected' };
      }
      return { success: false, merged: false, message: msg };
    }
  }

  async checkMergeability(
    repoPath: string,
    taskBranch: string,
    targetBranch: string
  ): Promise<{ mergeable: boolean; conflicts?: string[] }> {
    try {
      const { stdout: mergeBase } = await execAsync(
        `git merge-base "${targetBranch}" "${taskBranch}"`,
        { cwd: repoPath }
      );
      const { stdout: result } = await execAsync(
        `git merge-tree ${mergeBase.trim()} "${targetBranch}" "${taskBranch}"`,
        { cwd: repoPath }
      );

      const hasConflicts = result.includes('changed in both');
      if (hasConflicts) {
        const conflictFiles = [...result.matchAll(/our\s+\d+ \w+ (.+)/g)].map(m => m[1]);
        return { mergeable: false, conflicts: conflictFiles };
      }
      return { mergeable: true };
    } catch {
      return { mergeable: true };
    }
  }

  async getDiffStats(worktreePath: string, baseBranch?: string): Promise<DiffStats> {
    const base = baseBranch ?? 'main';
    try {
      const { stdout } = await execAsync(`git diff --stat "${base}" HEAD`, { cwd: worktreePath });
      const lastLine = stdout.trim().split('\n').pop() ?? '';
      const filesMatch = lastLine.match(/(\d+) files? changed/);
      const addMatch = lastLine.match(/(\d+) insertions?/);
      const delMatch = lastLine.match(/(\d+) deletions?/);
      return {
        filesChanged: filesMatch ? parseInt(filesMatch[1]) : 0,
        additions: addMatch ? parseInt(addMatch[1]) : 0,
        deletions: delMatch ? parseInt(delMatch[1]) : 0,
      };
    } catch {
      return { filesChanged: 0, additions: 0, deletions: 0 };
    }
  }

  async deleteBranch(repoPath: string, taskId: string): Promise<void> {
    const branchName = `task/${taskId}`;
    try {
      await execAsync(`git branch -d "${branchName}"`, { cwd: repoPath });
      log.info('Branch deleted', { taskId, branch: branchName });
    } catch (err) {
      log.warn('Failed to delete branch', { taskId, error: String(err) });
    }
  }
}
