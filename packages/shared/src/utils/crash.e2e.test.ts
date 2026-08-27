import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * End-to-end boundary test: spawn REAL child Node processes that import the
 * COMPILED crash module (dist) and then crash. Verifies that:
 *   1) an uncaughtException writes a crash report to crash.log + last-crash.json
 *   2) the next boot's detectUncleanShutdown() sees the unclean exit
 *   3) a clean shutdown is NOT flagged as a crash
 *   4) a leftover 'running' marker (SIGKILL/OOM-style) is flagged unclean
 * This validates the P0 "崩溃留痕/归因" contract against real processes, not mocks.
 */

let tmpHome: string;
const originalHome = process.env.HOME;
const distDir = join(__dirname, '..', '..', 'dist', 'utils');

function runChild(code: string, opts: { env?: Record<string, string> } = {}): { stdout: string; code: number } {
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, HOME: tmpHome, ...opts.env },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    });
    return { stdout: out, code: 0 };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { stdout: (err.stdout ?? '') + (err.stderr ?? ''), code: err.status ?? 1 };
  }
}

const importCrash = `import { installCrashGuard, markRunStarted, markCleanShutdown, detectUncleanShutdown } from ${JSON.stringify('file://' + join(distDir, 'crash.js'))};`;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'markus-crash-e2e-'));
  process.env.HOME = tmpHome;
  mkdirSync(join(tmpHome, '.markus', 'logs'), { recursive: true });
});

afterAll(() => {
  process.env.HOME = originalHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('crash supervision E2E (real child process)', () => {
  it('records an uncaughtException crash report and flags the next boot unclean', () => {
    // Child A: install guard, run-marker, then throw.
    const src = `${importCrash}
      installCrashGuard({ context: () => ({ phase: 'boot' }) });
      markRunStarted();
      setTimeout(() => { throw new Error('simulated-uncaught-crash'); }, 50);
      setInterval(() => {}, 5000);
    `;
    const resA = runChild(src);
    expect(resA.code).not.toBe(0); // crashed abnormally

    const crashLog = join(tmpHome, '.markus', 'logs', 'crash.log');
    expect(existsSync(crashLog)).toBe(true);
    const last = JSON.parse(readFileSync(join(tmpHome, '.markus', 'logs', 'last-crash.json'), 'utf-8'));
    expect(last.reason).toBe('uncaughtException');
    expect(last.message).toContain('simulated-uncaught-crash');
    expect(last.context?.phase).toBe('boot');

    // Child B: fresh boot → detect unclean.
    const probe = runChild(`${importCrash}
      const d = detectUncleanShutdown();
      console.log(JSON.stringify({ unclean: d.unclean, reason: d.lastCrash?.reason }));
    `);
    const parsed = JSON.parse(probe.stdout.trim().split('\n').pop()!);
    expect(parsed.unclean).toBe(true);
    expect(parsed.reason).toBe('uncaughtException');
  });

  it('leftover running marker (SIGKILL/OOM-style hard kill) is flagged unclean', () => {
    // Simulate a hard kill: a 'running' run-state with no clean-shutdown marker.
    writeFileSync(
      join(tmpHome, '.markus', 'logs', 'run-state.json'),
      JSON.stringify({ pid: 99999, bootedAt: '2026-01-01T00:00:00Z', lastAliveAt: '2026-01-01T00:05:00Z', status: 'running' }),
    );
    writeFileSync(join(tmpHome, '.markus', 'logs', 'last-crash.json'), JSON.stringify({}));
    const probe = runChild(`${importCrash}
      const d = detectUncleanShutdown();
      console.log(JSON.stringify({ unclean: d.unclean, gapSec: d.lastAliveGapSec }));
    `);
    const parsed = JSON.parse(probe.stdout.trim().split('\n').pop()!);
    expect(parsed.unclean).toBe(true);
    expect(parsed.gapSec).toBeGreaterThan(0);
  });

  it('clean shutdown is NOT flagged as a crash on the next boot', () => {
    // Child A: run-marker + clean shutdown, then exit 0.
    const src = `${importCrash}
      markRunStarted();
      setTimeout(() => { markCleanShutdown(); process.exit(0); }, 20);
    `;
    const resA = runChild(src);
    expect(resA.code).toBe(0);

    // Child B: fresh boot → NOT unclean.
    const probe = runChild(`${importCrash}
      const d = detectUncleanShutdown();
      console.log(JSON.stringify({ unclean: d.unclean }));
    `);
    const parsed = JSON.parse(probe.stdout.trim().split('\n').pop()!);
    expect(parsed.unclean).toBe(false);
  });
});