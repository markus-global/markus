import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const mockExecSync = vi.fn();

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execSync: (...args: unknown[]) => mockExecSync(...args) };
});

describe('QualityVerifier', () => {
  let tmpDir: string;

  beforeEach(() => {
    mockExecSync.mockReset();
    tmpDir = mkdtempSync(join(tmpdir(), 'qv-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('detectProjectType()', () => {
    it('detects node project with package.json', async () => {
      writeFileSync(
        join(tmpDir, 'package.json'),
        JSON.stringify({ scripts: { test: 'vitest' } }),
      );

      const { detectProjectType } = await import('../../src/coding-tools/quality-verifier.js');
      const result = detectProjectType(tmpDir);

      expect(result.type).toBe('node');
      expect(result.testCommand).toBe('npm test');
      expect(result.packageManager).toBe('npm');
    });

    it('detects pnpm package manager', async () => {
      writeFileSync(
        join(tmpDir, 'package.json'),
        JSON.stringify({ scripts: { test: 'vitest' } }),
      );
      writeFileSync(join(tmpDir, 'pnpm-lock.yaml'), '');

      const { detectProjectType } = await import('../../src/coding-tools/quality-verifier.js');
      const result = detectProjectType(tmpDir);

      expect(result.packageManager).toBe('pnpm');
      expect(result.testCommand).toBe('pnpm test');
    });

    it('detects yarn package manager', async () => {
      writeFileSync(
        join(tmpDir, 'package.json'),
        JSON.stringify({ scripts: { test: 'vitest' } }),
      );
      writeFileSync(join(tmpDir, 'yarn.lock'), '');

      const { detectProjectType } = await import('../../src/coding-tools/quality-verifier.js');
      const result = detectProjectType(tmpDir);

      expect(result.packageManager).toBe('yarn');
      expect(result.testCommand).toBe('yarn test');
    });

    it('detects node project without test script', async () => {
      writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ name: 'app' }));

      const { detectProjectType } = await import('../../src/coding-tools/quality-verifier.js');
      const result = detectProjectType(tmpDir);

      expect(result.type).toBe('node');
      expect(result.testCommand).toBeUndefined();
    });

    it('detects python project with pyproject.toml and pytest', async () => {
      writeFileSync(join(tmpDir, 'pyproject.toml'), '[tool.pytest]\n');

      const { detectProjectType } = await import('../../src/coding-tools/quality-verifier.js');
      const result = detectProjectType(tmpDir);

      expect(result.type).toBe('python');
      expect(result.testCommand).toBe('pytest');
    });

    it('detects python project with setup.py', async () => {
      writeFileSync(join(tmpDir, 'setup.py'), 'from setuptools import setup\n');

      const { detectProjectType } = await import('../../src/coding-tools/quality-verifier.js');
      const result = detectProjectType(tmpDir);

      expect(result.type).toBe('python');
      expect(result.testCommand).toBe('python -m unittest discover');
    });

    it('detects go project', async () => {
      writeFileSync(join(tmpDir, 'go.mod'), 'module example.com/app\n');

      const { detectProjectType } = await import('../../src/coding-tools/quality-verifier.js');
      const result = detectProjectType(tmpDir);

      expect(result.type).toBe('go');
      expect(result.testCommand).toBe('go test ./...');
    });

    it('detects rust project', async () => {
      writeFileSync(join(tmpDir, 'Cargo.toml'), '[package]\nname = "app"\n');

      const { detectProjectType } = await import('../../src/coding-tools/quality-verifier.js');
      const result = detectProjectType(tmpDir);

      expect(result.type).toBe('rust');
      expect(result.testCommand).toBe('cargo test');
    });

    it('detects java project with pom.xml', async () => {
      writeFileSync(join(tmpDir, 'pom.xml'), '<project></project>');

      const { detectProjectType } = await import('../../src/coding-tools/quality-verifier.js');
      const result = detectProjectType(tmpDir);

      expect(result.type).toBe('java');
      expect(result.testCommand).toBe('mvn test');
    });

    it('detects java project with build.gradle', async () => {
      writeFileSync(join(tmpDir, 'build.gradle'), 'plugins { id "java" }');

      const { detectProjectType } = await import('../../src/coding-tools/quality-verifier.js');
      const result = detectProjectType(tmpDir);

      expect(result.type).toBe('java');
      expect(result.testCommand).toBe('gradle test');
    });

    it("returns 'unknown' for empty directory", async () => {
      const { detectProjectType } = await import('../../src/coding-tools/quality-verifier.js');
      const result = detectProjectType(tmpDir);

      expect(result.type).toBe('unknown');
      expect(result.testCommand).toBeUndefined();
    });
  });

  describe('parseTestOutput()', () => {
    it('parses vitest "Tests X passed | Y failed" format', async () => {
      const { parseTestOutput } = await import('../../src/coding-tools/quality-verifier.js');
      const output = 'Tests  12 passed | 2 failed | 1 skipped';

      const result = parseTestOutput(output, 'node');

      expect(result).toEqual({ passed: 12, failed: 2, skipped: 0 });
    });

    it('parses vitest summary format', async () => {
      const { parseTestOutput } = await import('../../src/coding-tools/quality-verifier.js');
      const output = '  10 passed\n  1 failed\n  2 skipped';

      const result = parseTestOutput(output, 'node');

      expect(result).toEqual({ passed: 10, failed: 1, skipped: 2 });
    });

    it('parses pytest output', async () => {
      const { parseTestOutput } = await import('../../src/coding-tools/quality-verifier.js');
      const output = '======================== 15 passed, 3 failed in 2.50s ========================';

      const result = parseTestOutput(output, 'python');

      expect(result).toEqual({ passed: 15, failed: 3, skipped: 0 });
    });

    it('parses Go test output', async () => {
      const { parseTestOutput } = await import('../../src/coding-tools/quality-verifier.js');
      const output = 'ok  \texample.com/pkg\t0.123s\nFAIL\texample.com/other\t0.456s\nok  \texample.com/util\t0.789s';

      const result = parseTestOutput(output, 'go');

      expect(result).toEqual({ passed: 2, failed: 1, skipped: 0 });
    });

    it('returns zeros for unrecognized output', async () => {
      const { parseTestOutput } = await import('../../src/coding-tools/quality-verifier.js');
      const result = parseTestOutput('no test results here', 'unknown');

      expect(result).toEqual({ passed: 0, failed: 0, skipped: 0 });
    });
  });

  describe('runTests()', () => {
    it('returns success when no test command found', async () => {
      writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ name: 'app' }));

      const { runTests } = await import('../../src/coding-tools/quality-verifier.js');
      const result = runTests(tmpDir);

      expect(result.success).toBe(true);
      expect(result.output).toBe('No test command found');
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it('runs tests and parses successful output', async () => {
      writeFileSync(
        join(tmpDir, 'package.json'),
        JSON.stringify({ scripts: { test: 'vitest' } }),
      );
      mockExecSync.mockReturnValue('  5 passed\n  0 failed');

      const { runTests } = await import('../../src/coding-tools/quality-verifier.js');
      const result = runTests(tmpDir);

      expect(result.success).toBe(true);
      expect(result.passed).toBe(5);
      expect(result.failed).toBe(0);
      expect(mockExecSync).toHaveBeenCalledWith(
        'npm test',
        expect.objectContaining({ cwd: tmpDir }),
      );
    });

    it('returns failure when tests fail', async () => {
      writeFileSync(join(tmpDir, 'go.mod'), 'module example.com/app\n');
      const err = new Error('test failed') as Error & { stdout?: string; stderr?: string };
      err.stdout = 'ok  \texample.com/pkg\t0.1s\nFAIL\texample.com/bad\t0.2s';
      err.stderr = '';
      mockExecSync.mockImplementation(() => {
        throw err;
      });

      const { runTests } = await import('../../src/coding-tools/quality-verifier.js');
      const result = runTests(tmpDir);

      expect(result.success).toBe(false);
      expect(result.passed).toBe(1);
      expect(result.failed).toBe(1);
    });

    it('uses explicit command override', async () => {
      mockExecSync.mockReturnValue('  3 passed');

      const { runTests } = await import('../../src/coding-tools/quality-verifier.js');
      const result = runTests(tmpDir, 'custom-test-runner');

      expect(result.success).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith(
        'custom-test-runner',
        expect.objectContaining({ cwd: tmpDir }),
      );
    });
  });
});
