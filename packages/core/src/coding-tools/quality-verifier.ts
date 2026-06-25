import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import type { TestResult } from '@markus/shared';

export type ProjectType = 'node' | 'python' | 'go' | 'rust' | 'java' | 'unknown';

export interface ProjectDetection {
  type: ProjectType;
  testCommand?: string;
  packageManager?: string;
}

export function detectProjectType(workdir: string): ProjectDetection {
  if (existsSync(join(workdir, 'package.json'))) {
    const pkg = JSON.parse(readFileSync(join(workdir, 'package.json'), 'utf-8'));
    const testScript = pkg.scripts?.test;
    const pm = existsSync(join(workdir, 'pnpm-lock.yaml'))
      ? 'pnpm'
      : existsSync(join(workdir, 'yarn.lock'))
        ? 'yarn'
        : 'npm';
    return {
      type: 'node',
      testCommand: testScript ? `${pm} test` : undefined,
      packageManager: pm,
    };
  }

  if (existsSync(join(workdir, 'pyproject.toml')) || existsSync(join(workdir, 'setup.py'))) {
    const hasPytest =
      existsSync(join(workdir, 'pyproject.toml')) &&
      readFileSync(join(workdir, 'pyproject.toml'), 'utf-8').includes('pytest');
    return {
      type: 'python',
      testCommand: hasPytest ? 'pytest' : 'python -m unittest discover',
    };
  }

  if (existsSync(join(workdir, 'go.mod'))) {
    return { type: 'go', testCommand: 'go test ./...' };
  }

  if (existsSync(join(workdir, 'Cargo.toml'))) {
    return { type: 'rust', testCommand: 'cargo test' };
  }

  if (existsSync(join(workdir, 'pom.xml')) || existsSync(join(workdir, 'build.gradle'))) {
    const cmd = existsSync(join(workdir, 'pom.xml')) ? 'mvn test' : 'gradle test';
    return { type: 'java', testCommand: cmd };
  }

  return { type: 'unknown' };
}

export function runTests(workdir: string, command?: string): TestResult {
  const detection = detectProjectType(workdir);
  const testCmd = command || detection.testCommand;

  if (!testCmd) {
    return { passed: 0, failed: 0, skipped: 0, success: true, output: 'No test command found' };
  }

  try {
    const output = execSync(testCmd, {
      cwd: workdir,
      encoding: 'utf-8',
      timeout: 300_000,
      env: { ...process.env, CI: 'true' },
    });

    const parsed = parseTestOutput(output, detection.type);
    return { ...parsed, success: parsed.failed === 0, output: output.slice(0, 10_000) };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string };
    const output = (execErr.stdout || '') + '\n' + (execErr.stderr || '');
    const parsed = parseTestOutput(output, detection.type);
    return { ...parsed, success: false, output: output.slice(0, 10_000) };
  }
}

export function parseTestOutput(
  output: string,
  projectType: ProjectType,
): { passed: number; failed: number; skipped: number } {
  const vitestMatch = output.match(/Tests\s+(\d+)\s+passed.*?(\d+)\s+failed/);
  if (vitestMatch) {
    return { passed: parseInt(vitestMatch[1]), failed: parseInt(vitestMatch[2]), skipped: 0 };
  }

  const vitestSummary = output.match(/(\d+)\s+passed/);
  const vitestFailed = output.match(/(\d+)\s+failed/);
  const vitestSkipped = output.match(/(\d+)\s+skipped/);
  if (vitestSummary) {
    return {
      passed: parseInt(vitestSummary[1]),
      failed: vitestFailed ? parseInt(vitestFailed[1]) : 0,
      skipped: vitestSkipped ? parseInt(vitestSkipped[1]) : 0,
    };
  }

  const pytestMatch = output.match(/(\d+)\s+passed(?:,\s+(\d+)\s+failed)?/);
  if (pytestMatch) {
    return {
      passed: parseInt(pytestMatch[1]),
      failed: parseInt(pytestMatch[2] || '0'),
      skipped: 0,
    };
  }

  const goOk = (output.match(/^ok\s/gm) || []).length;
  const goFail = (output.match(/^FAIL\s/gm) || []).length;
  if (goOk + goFail > 0) {
    return { passed: goOk, failed: goFail, skipped: 0 };
  }

  void projectType;
  return { passed: 0, failed: 0, skipped: 0 };
}
