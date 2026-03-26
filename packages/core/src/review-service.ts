import { createLogger } from '@markus/shared';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(execCb);
const log = createLogger('review-service');

export interface ReviewCheckResult {
  name: string;
  status: 'pass' | 'fail' | 'warn' | 'skip';
  message: string;
  details?: string;
  durationMs?: number;
}

export interface ReviewReport {
  id: string;
  taskId?: string;
  agentId?: string;
  createdAt: string;
  checks: ReviewCheckResult[];
  overallStatus: 'pass' | 'fail' | 'warn';
  summary: string;
}

export type ReviewChecker = (context: ReviewContext) => Promise<ReviewCheckResult>;

export interface ReviewContext {
  taskId?: string;
  agentId?: string;
  changedFiles?: string[];
  description?: string;
  worktreePath?: string;
  baseBranch?: string;
}

/**
 * Review Service — runs a pipeline of quality checks against agent work products.
 *
 * Designed to be extensible: register custom checkers for TypeScript, test coverage,
 * code style, security, etc. Each checker returns a pass/fail/warn result.
 *
 * Future: bridge with external tools (reviewdog, PR-Agent, GitHub Checks API).
 */
export class ReviewService {
  private checkers = new Map<string, ReviewChecker>();
  private reports: ReviewReport[] = [];
  private static readonly MAX_REPORTS = 500;

  registerChecker(name: string, checker: ReviewChecker): void {
    this.checkers.set(name, checker);
    log.info(`Review checker registered: ${name}`);
  }

  unregisterChecker(name: string): void {
    this.checkers.delete(name);
  }

  listCheckers(): string[] {
    return [...this.checkers.keys()];
  }

  async runReview(context: ReviewContext): Promise<ReviewReport> {
    const id = `review_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const checks: ReviewCheckResult[] = [];

    for (const [name, checker] of this.checkers) {
      const start = Date.now();
      try {
        const result = await checker(context);
        result.durationMs = Date.now() - start;
        checks.push(result);
      } catch (err) {
        checks.push({
          name,
          status: 'fail',
          message: `Checker threw an error: ${String(err)}`,
          durationMs: Date.now() - start,
        });
      }
    }

    const hasFailure = checks.some(c => c.status === 'fail');
    const hasWarning = checks.some(c => c.status === 'warn');
    const overallStatus = hasFailure ? 'fail' : hasWarning ? 'warn' : 'pass';

    const passCount = checks.filter(c => c.status === 'pass').length;
    const failCount = checks.filter(c => c.status === 'fail').length;
    const warnCount = checks.filter(c => c.status === 'warn').length;
    const summary = `${passCount} passed, ${failCount} failed, ${warnCount} warnings out of ${checks.length} checks`;

    const report: ReviewReport = {
      id,
      taskId: context.taskId,
      agentId: context.agentId,
      createdAt: new Date().toISOString(),
      checks,
      overallStatus,
      summary,
    };

    this.reports.push(report);
    if (this.reports.length > ReviewService.MAX_REPORTS) {
      this.reports.splice(0, this.reports.length - ReviewService.MAX_REPORTS);
    }

    log.info(`Review completed: ${overallStatus}`, { id, summary });
    return report;
  }

  getReport(id: string): ReviewReport | undefined {
    return this.reports.find(r => r.id === id);
  }

  getReportsByTask(taskId: string): ReviewReport[] {
    return this.reports.filter(r => r.taskId === taskId);
  }

  getRecentReports(limit = 20): ReviewReport[] {
    return this.reports.slice(-limit).reverse();
  }
}

// --- Built-in checkers ---

export function createTypeScriptChecker(): ReviewChecker {
  return async ctx => {
    if (!ctx.worktreePath) {
      return {
        name: 'typescript',
        status: 'skip',
        message: 'No worktree path — skipping TypeScript check',
      };
    }
    try {
      await execAsync('npx tsc --noEmit 2>&1', {
        cwd: ctx.worktreePath,
        timeout: 120000,
      });
      return { name: 'typescript', status: 'pass', message: 'TypeScript compilation clean' };
    } catch (err: unknown) {
      const _err = err as Record<string, unknown>;
      const output = _err.stdout || _err.stderr || String(err);
      return {
        name: 'typescript',
        status: 'fail',
        message: 'TypeScript compilation errors',
        details: String(output),
      };
    }
  };
}

export function createTestChecker(): ReviewChecker {
  return async ctx => {
    if (!ctx.worktreePath) {
      return { name: 'tests', status: 'skip', message: 'No worktree path — skipping tests' };
    }
    try {
      const base = ctx.baseBranch ?? 'main';
      const { stdout: testOutput } = await execAsync(
        `npx vitest run --reporter=verbose --changed ${base} 2>&1`,
        { cwd: ctx.worktreePath, timeout: 300000 }
      );
      return {
        name: 'tests',
        status: 'pass',
        message: 'All tests passed',
        details: testOutput.slice(-1000),
      };
    } catch (err: unknown) {
      const _err = err as Record<string, unknown>;
      const output = _err.stdout || _err.stderr || String(err);
      return {
        name: 'tests',
        status: 'fail',
        message: 'Test failures detected',
        details: String(output),
      };
    }
  };
}

export function createLintChecker(): ReviewChecker {
  return async ctx => {
    if (!ctx.worktreePath) {
      return { name: 'lint', status: 'skip', message: 'No worktree path — skipping lint' };
    }
    try {
      const base = ctx.baseBranch ?? 'main';
      const { stdout: changedFiles } = await execAsync(
        `git diff --name-only ${base} -- '*.ts' '*.tsx' '*.js' '*.jsx'`,
        { cwd: ctx.worktreePath }
      );
      const files = changedFiles.trim().split('\n').filter(Boolean);
      if (files.length === 0) {
        return { name: 'lint', status: 'pass', message: 'No lintable files changed' };
      }
      await execAsync(`npx eslint ${files.join(' ')} 2>&1`, {
        cwd: ctx.worktreePath,
        timeout: 60000,
      });
      return { name: 'lint', status: 'pass', message: `Lint clean on ${files.length} files` };
    } catch (err: unknown) {
      const _err = err as Record<string, unknown>;
      const output = _err.stdout || _err.stderr || String(err);
      return {
        name: 'lint',
        status: 'fail',
        message: 'Lint errors found',
        details: String(output),
      };
    }
  };
}

export function createDescriptionChecker(): ReviewChecker {
  return async ctx => {
    if (!ctx.description || ctx.description.trim().length < 10) {
      return {
        name: 'description',
        status: 'warn',
        message: 'Task description is missing or too short',
      };
    }
    return { name: 'description', status: 'pass', message: 'Description is adequate' };
  };
}

export function createChangedFilesChecker(maxFiles = 50): ReviewChecker {
  return async ctx => {
    if (!ctx.changedFiles) {
      return { name: 'scope', status: 'skip', message: 'No changed files information available' };
    }
    if (ctx.changedFiles.length > maxFiles) {
      return {
        name: 'scope',
        status: 'warn',
        message: `Large changeset: ${ctx.changedFiles.length} files (recommend < ${maxFiles})`,
      };
    }
    return { name: 'scope', status: 'pass', message: `${ctx.changedFiles.length} files changed` };
  };
}
