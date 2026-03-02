import { describe, it, expect, beforeEach } from 'vitest';
import {
  ReviewService,
  createDescriptionChecker,
  createChangedFilesChecker,
} from '../src/review-service.js';
import type { ReviewChecker } from '../src/review-service.js';

describe('ReviewService', () => {
  let svc: ReviewService;

  beforeEach(() => {
    svc = new ReviewService();
  });

  describe('checker registration', () => {
    it('registers and lists checkers', () => {
      const checker: ReviewChecker = async () => ({ name: 'test', status: 'pass', message: 'ok' });
      svc.registerChecker('test', checker);
      expect(svc.listCheckers()).toContain('test');
    });

    it('unregisters checkers', () => {
      svc.registerChecker('test', async () => ({ name: 'test', status: 'pass', message: 'ok' }));
      svc.unregisterChecker('test');
      expect(svc.listCheckers()).not.toContain('test');
    });
  });

  describe('runReview', () => {
    it('runs all registered checkers', async () => {
      svc.registerChecker('a', async () => ({ name: 'a', status: 'pass', message: 'ok' }));
      svc.registerChecker('b', async () => ({ name: 'b', status: 'warn', message: 'meh' }));

      const report = await svc.runReview({});
      expect(report.checks).toHaveLength(2);
      expect(report.overallStatus).toBe('warn');
      expect(report.summary).toContain('1 passed');
      expect(report.summary).toContain('1 warnings');
    });

    it('returns pass when all checks pass', async () => {
      svc.registerChecker('a', async () => ({ name: 'a', status: 'pass', message: 'ok' }));
      svc.registerChecker('b', async () => ({ name: 'b', status: 'pass', message: 'ok' }));

      const report = await svc.runReview({});
      expect(report.overallStatus).toBe('pass');
    });

    it('returns fail when any check fails', async () => {
      svc.registerChecker('pass', async () => ({ name: 'pass', status: 'pass', message: 'ok' }));
      svc.registerChecker('fail', async () => ({ name: 'fail', status: 'fail', message: 'bad' }));

      const report = await svc.runReview({});
      expect(report.overallStatus).toBe('fail');
    });

    it('handles checker errors gracefully', async () => {
      svc.registerChecker('broken', async () => { throw new Error('boom'); });
      const report = await svc.runReview({});
      expect(report.checks[0].status).toBe('fail');
      expect(report.checks[0].message).toContain('boom');
    });

    it('tracks duration for each check', async () => {
      svc.registerChecker('slow', async () => {
        await new Promise(r => setTimeout(r, 10));
        return { name: 'slow', status: 'pass', message: 'ok' };
      });
      const report = await svc.runReview({});
      expect(report.checks[0].durationMs).toBeGreaterThanOrEqual(5);
    });

    it('includes task and agent IDs in report', async () => {
      svc.registerChecker('a', async () => ({ name: 'a', status: 'pass', message: 'ok' }));
      const report = await svc.runReview({ taskId: 'task-1', agentId: 'agent-1' });
      expect(report.taskId).toBe('task-1');
      expect(report.agentId).toBe('agent-1');
    });
  });

  describe('report retrieval', () => {
    it('retrieves report by ID', async () => {
      svc.registerChecker('a', async () => ({ name: 'a', status: 'pass', message: 'ok' }));
      const report = await svc.runReview({});
      expect(svc.getReport(report.id)).toBeDefined();
    });

    it('retrieves reports by taskId', async () => {
      svc.registerChecker('a', async () => ({ name: 'a', status: 'pass', message: 'ok' }));
      await svc.runReview({ taskId: 'task-1' });
      await svc.runReview({ taskId: 'task-2' });
      await svc.runReview({ taskId: 'task-1' });

      expect(svc.getReportsByTask('task-1')).toHaveLength(2);
      expect(svc.getReportsByTask('task-2')).toHaveLength(1);
    });

    it('gets recent reports in reverse order', async () => {
      svc.registerChecker('a', async () => ({ name: 'a', status: 'pass', message: 'ok' }));
      const r1 = await svc.runReview({ taskId: 'first' });
      const r2 = await svc.runReview({ taskId: 'second' });

      const recent = svc.getRecentReports(5);
      expect(recent[0].id).toBe(r2.id);
      expect(recent[1].id).toBe(r1.id);
    });
  });

  describe('built-in checkers', () => {
    it('description checker warns on short description', async () => {
      svc.registerChecker('desc', createDescriptionChecker());
      const report = await svc.runReview({ description: 'hi' });
      expect(report.checks[0].status).toBe('warn');
    });

    it('description checker passes on adequate description', async () => {
      svc.registerChecker('desc', createDescriptionChecker());
      const report = await svc.runReview({ description: 'This is a proper task description with enough detail.' });
      expect(report.checks[0].status).toBe('pass');
    });

    it('changed files checker warns on large changesets', async () => {
      svc.registerChecker('scope', createChangedFilesChecker(3));
      const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts'];
      const report = await svc.runReview({ changedFiles: files });
      expect(report.checks[0].status).toBe('warn');
    });

    it('changed files checker passes for small changesets', async () => {
      svc.registerChecker('scope', createChangedFilesChecker(10));
      const report = await svc.runReview({ changedFiles: ['a.ts', 'b.ts'] });
      expect(report.checks[0].status).toBe('pass');
    });
  });
});
