import { describe, it, expect, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { createBackgroundExecTool, createProcessTool } from '../src/tools/process-manager.js';

/**
 * Regression for the background-exec descendant leak (found + fixed 2026-10-01).
 *
 * `isolatedGroup` used to be derived from `isIsolatedProcessGroup(child.pid)`,
 * i.e. a `ps` probe of the wrapper's CURRENT state. For a self-daemonizing
 * command (`sleep N & exit 0`) the wrapper is gone by the time we ask, so the
 * probe returned false → `hasLeakedDescendants()` returned false → `kill`
 * answered "Process already exited" and the grandchild leaked forever.
 *
 * The fix trusts the spawn contract (`detached: !isWin`) instead. These tests
 * pin the observable behaviour, not the implementation.
 */

const MARK = '777812';
const sleepMarker = `sleep ${MARK}`;
// Self-match-proof pattern: bracket the first digit so the literal string
// `sleep 777812` does NOT appear in the search command's own argv. `execSync`
// runs through `sh -c 'pgrep -f "sleep 777812" || true'`, whose command line
// literally contains `sleep 777812` — so a plain `pgrep -f` matched that
// wrapper and reported a phantom survivor on Linux/CI ("expected 1 to be +0"),
// while macOS happened not to. `sleep [7]77812` still matches the real process
// but not the shell that spells the pattern out. Measured 2026-10-02.
const markerPattern = `sleep [${MARK[0]}]${MARK.slice(1)}`;
const pgrep = `pgrep -f "${markerPattern}" || true`;

function survivors(): number {
  const out = execSync(pgrep, { encoding: 'utf8' }).trim();
  return out ? out.split('\n').length : 0;
}

describe('background exec: reap descendants after the wrapper exits', () => {
  const bgExec = createBackgroundExecTool();
  const proc = createProcessTool();

  afterAll(() => {
    try {
      execSync(`pkill -f "${markerPattern}" || true`);
    } catch {
      /* nothing left to clean up */
    }
  });

  it('kills the surviving grandchild of a self-daemonizing command', async () => {
    const start = JSON.parse(await bgExec.execute({ command: `${sleepMarker} & exit 0` }));
    expect(start.status).toBe('running');
    expect(start.pid).toBeGreaterThan(0);

    // Let the wrapper exit while the grandchild keeps running — the exact state
    // in which the old `ps` probe reported "not isolated".
    await new Promise((r) => setTimeout(r, 1500));
    expect(survivors(), 'precondition: the grandchild must actually be alive').toBeGreaterThan(0);

    const killed = JSON.parse(
      await proc.execute({ action: 'kill', sessionId: start.sessionId }),
    );
    expect(killed.status).toBe('success');

    // SIGTERM first, SIGKILL after the grace window.
    await new Promise((r) => setTimeout(r, 3500));
    expect(survivors(), 'no descendant may survive the kill').toBe(0);
  }, 15000);
});
