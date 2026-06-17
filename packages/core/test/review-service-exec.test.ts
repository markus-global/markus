import { describe, it, expect, vi, beforeEach } from 'vitest';

const execMock = vi.fn();

vi.mock('node:child_process', () => ({
  exec: (...args: unknown[]) => execMock(...args),
}));

import {
  ReviewService,
  createTypeScriptChecker,
  createTestChecker,
  createLintChecker,
} from '../src/review-service.js';

function invokeExec(
  cmd: string,
  opts: unknown,
  cb?: (err: unknown, stdout?: string, stderr?: string) => void,
) {
  const callback = typeof opts === 'function'
    ? opts as (err: unknown, stdout?: string, stderr?: string) => void
    : cb;
  if (!callback) return;
  callback(null, 'ok');
}

describe('ReviewService exec-based checkers', () => {
  beforeEach(() => {
    execMock.mockReset();
    execMock.mockImplementation(invokeExec);
  });

  it('typescript checker passes when tsc succeeds', async () => {
    const svc = new ReviewService();
    svc.registerChecker('typescript', createTypeScriptChecker());
    const report = await svc.runReview({ workingDirectory: '/tmp/project' });
    expect(report.checks[0].status).toBe('pass');
  });

  it('typescript checker fails when tsc throws', async () => {
    execMock.mockImplementation((_cmd, opts, cb) => {
      const callback = typeof opts === 'function' ? opts : cb;
      if (!callback) return;
      const err = new Error('tsc failed') as Error & { stdout?: string };
      err.stdout = 'type error TS1234';
      callback(err);
    });
    const svc = new ReviewService();
    svc.registerChecker('typescript', createTypeScriptChecker());
    const report = await svc.runReview({ workingDirectory: '/tmp/project' });
    expect(report.checks[0].status).toBe('fail');
  });

  it('test checker fails when vitest throws', async () => {
    execMock.mockImplementation((_cmd, opts, cb) => {
      const callback = typeof opts === 'function' ? opts : cb;
      if (!callback) return;
      const err = new Error('vitest failed') as Error & { stdout?: string };
      err.stdout = '1 failed';
      callback(err);
    });
    const svc = new ReviewService();
    svc.registerChecker('tests', createTestChecker());
    const report = await svc.runReview({ workingDirectory: '/tmp/project', baseBranch: 'main' });
    expect(report.checks[0].status).toBe('fail');
  });

  it('lint checker fails when eslint reports errors', async () => {
    execMock.mockImplementation((cmd, opts, cb) => {
      const callback = typeof opts === 'function' ? opts : cb;
      if (!callback) return;
      if (String(cmd).includes('git diff')) {
        callback(null, 'src/a.ts\n');
        return;
      }
      const err = new Error('eslint failed') as Error & { stdout?: string };
      err.stdout = 'Unexpected var';
      callback(err);
    });
    const svc = new ReviewService();
    svc.registerChecker('lint', createLintChecker());
    const report = await svc.runReview({ workingDirectory: '/tmp/project' });
    expect(report.checks[0].status).toBe('fail');
  });
});
