import { describe, it, expect, beforeEach } from 'vitest';
import {
  ReviewService,
  createTypeScriptChecker,
  createTestChecker,
  createLintChecker,
  createDescriptionChecker,
  createChangedFilesChecker,
} from '../src/review-service.js';

describe('ReviewService built-in checkers extended', () => {
  let svc: ReviewService;

  beforeEach(() => {
    svc = new ReviewService();
  });

  it('typescript checker skips without working directory', async () => {
    svc.registerChecker('typescript', createTypeScriptChecker());
    const report = await svc.runReview({});
    expect(report.checks[0].status).toBe('skip');
  });

  it('test checker skips without working directory', async () => {
    svc.registerChecker('tests', createTestChecker());
    const report = await svc.runReview({});
    expect(report.checks[0].status).toBe('skip');
  });

  it('lint checker skips without working directory', async () => {
    svc.registerChecker('lint', createLintChecker());
    const report = await svc.runReview({});
    expect(report.checks[0].status).toBe('skip');
  });

  it('description checker skips when description is missing', async () => {
    svc.registerChecker('desc', createDescriptionChecker());
    const report = await svc.runReview({});
    expect(report.checks[0].status).toBe('warn');
  });

  it('changed files checker skips when no files provided', async () => {
    svc.registerChecker('scope', createChangedFilesChecker());
    const report = await svc.runReview({});
    expect(report.checks[0].status).toBe('skip');
  });

  it('trims report history when exceeding MAX_REPORTS', async () => {
    svc.registerChecker('a', async () => ({ name: 'a', status: 'pass', message: 'ok' }));
    for (let i = 0; i < 505; i++) {
      await svc.runReview({ taskId: `task_${i}` });
    }
    expect(svc.getRecentReports(600).length).toBeLessThanOrEqual(500);
  });
});
