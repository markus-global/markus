/**
 * Process-group helpers for long-running child processes spawned by Markus.
 *
 * WHY THIS EXISTS
 * ---------------
 * `sh -c "<command>"` is only a *wrapper*. The real work happens in its
 * descendants: `pnpm test` → `vitest` → fork workers, `pnpm dev` →
 * concurrently → tsx, …

 * Signalling only the wrapper (`child.kill(...)`) therefore terminates the
 * wrapper and leaves every descendant alive. They get reparented to PID 1,
 * keep burning CPU/RAM and stay unreachable until the OS is rebooted. This is
 * exactly how a `pnpm test` was observed running for 38 minutes at 100% CPU /
 * 3.4 GB after its timeout had already fired.
 *
 * The fix has two halves — BOTH are required:
 *   1. spawn the wrapper with `detached: true` (POSIX `setsid`) so it becomes
 *      the leader of its OWN process group, i.e. `pgid === pid`;
 *   2. signal that whole group with a negative PID (`kill(-pgid)`), escalating
 *      SIGTERM → SIGKILL.
 *
 * SAFETY
 * ------
 * `kill(-pid)` is only issued after we have *verified* (via `ps`) that the
 * child really is its own group leader AND that this group is not Markus' own
 * process group. Without that check, a caller that forgot `detached: true`
 * would signal Markus' own group and kill the app itself.
 */

import { spawnSync, type ChildProcess } from 'node:child_process';
import { platform } from 'node:os';

/** Grace period between SIGTERM and SIGKILL. Overridable for tests. */
export const KILL_GRACE_MS = (() => {
  const raw = Number(process.env['MARKUS_KILL_GRACE_MS']);
  return Number.isFinite(raw) && raw >= 0 ? raw : 2000;
})();

export function isWindows(): boolean {
  return platform() === 'win32';
}

/** Read the process-group id of `pid`, or null when unknown. */
function readPgid(pid: number): number | null {
  if (isWindows()) return null;
  try {
    const res = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000,
    });
    const value = parseInt(String(res.stdout ?? '').trim(), 10);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * True when `pid` leads its own process group and that group is not ours.
 * Call this *after* spawning with `detached: true`; only then is it safe to
 * use `kill(-pid)`.
 */
export function isIsolatedProcessGroup(pid: number | undefined): boolean {
  if (isWindows() || !pid || pid <= 1) return false;
  const pgid = readPgid(pid);
  if (pgid === null || pgid !== pid) return false;
  const selfPgid = readPgid(process.pid);
  if (selfPgid !== null && selfPgid === pgid) return false;
  return true;
}

/**
 * True while ANY member of the group is alive. A POSIX process group survives
 * its leader, so this detects "wrapper exited but descendants leaked".
 */
export function isProcessGroupAlive(pid: number | undefined): boolean {
  if (isWindows() || !pid || pid <= 1) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

export type SignalDelivery = 'group' | 'process' | 'none';

/**
 * Deliver `signal` to the child and (when isolated) everything it spawned.
 * Never throws.
 */
export function signalTree(
  child: ChildProcess,
  pid: number,
  signal: NodeJS.Signals,
  isolatedGroup: boolean,
): SignalDelivery {
  if (isWindows()) {
    // Windows has no process groups; `/T` walks the tree instead.
    if (signal === 'SIGKILL') {
      try {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
          timeout: 5000,
        });
      } catch {
        /* fall through to the direct kill below */
      }
    }
    try {
      child.kill(signal);
      return 'process';
    } catch {
      return 'none';
    }
  }

  if (isolatedGroup && pid > 1) {
    try {
      process.kill(-pid, signal);
      return 'group';
    } catch {
      /* ESRCH (already gone) or EPERM → fall back to the direct child */
    }
  }
  try {
    child.kill(signal);
    return 'process';
  } catch {
    return 'none';
  }
}

export interface KillTreeHandle {
  /** How the SIGTERM was delivered. */
  delivered: SignalDelivery;
  /** Cancel the pending SIGKILL escalation (call when the tree dies early). */
  cancelEscalation: () => void;
}

/**
 * Terminate a wrapper process AND its descendants: SIGTERM to the group, then
 * SIGKILL after `graceMs` if anything survived. `onEscalation` fires only when
 * the SIGKILL was actually needed (i.e. something ignored SIGTERM).
 */
export function killProcessTree(
  child: ChildProcess,
  pid: number,
  isolatedGroup: boolean,
  onEscalation?: () => void,
  graceMs: number = KILL_GRACE_MS,
): KillTreeHandle {
  const delivered = signalTree(child, pid, 'SIGTERM', isolatedGroup);

  const timer = setTimeout(() => {
    // Re-check liveness so a recycled PID can never be signalled by accident.
    const stillAlive = isolatedGroup ? isProcessGroupAlive(pid) : false;
    if (!stillAlive && !isolatedGroup) {
      // Not isolated: be defensive and re-signal the direct child only.
      signalTree(child, pid, 'SIGKILL', false);
      return;
    }
    if (!stillAlive) return;
    signalTree(child, pid, 'SIGKILL', isolatedGroup);
    try {
      onEscalation?.();
    } catch {
      /* observers must never break the kill path */
    }
  }, graceMs);

  // A pending escalation must not keep the process alive on its own.
  (timer as unknown as { unref?: () => void }).unref?.();

  return {
    delivered,
    cancelEscalation: () => clearTimeout(timer),
  };
}
