/**
 * Regression: a command that exceeds its timeout must be TERMINATED, and every
 * descendant must die with it.
 *
 * Two independent defects made this leak (both fixed in this change):
 *  1. The timeout timer only *resolved* the promise — it never force-terminated
 *     the command, so the process kept running (and burning CPU) forever.
 *  2. Even once the timeout fired, the process-group kill missed the children:
 *     - `isIsolatedProcessGroup()` probed `ps` immediately after `spawn()`, but
 *       the child has not called `setsid()` yet at that instant (racy). The probe
 *       reported "not isolated", so the kill degraded to "kill the wrapper only";
 *     - `bash -i` enables job control (`set -m`), which puts every command in its
 *       OWN process group, so the session's group no longer contains the work.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { ShellSessionManager } from '../src/tools/shell-session.js';

/** Unique to this file so the assertion can never match another test's process. */
const MARKER = 'sleep 37';
const KILL_GRACE_MS = 2000;

function survivingChildren(): string[] {
  const res = spawnSync('pgrep', ['-f', MARKER], { encoding: 'utf8' });
  return (res.stdout || '').split('\n').filter((line) => line.trim() !== '');
}

describe('shell session timeout terminates descendants', () => {
  let manager: ShellSessionManager | undefined;

  afterEach(() => {
    manager?.destroyAll();
    // Safety net: never leave stray sandbox processes behind.
    spawnSync('pkill', ['-f', MARKER]);
  });

  it(
    'kills the command AND its children when the timeout fires',
    async () => {
      manager = new ShellSessionManager();
      const session = manager.create('agent-timeout', 'kill-test');

      const startedAt = Date.now();
      // A background job AND a foreground one: both must die with the timeout.
      const result = await session.execute(`${MARKER} & ${MARKER}`, 1000);
      const elapsed = Date.now() - startedAt;

      // Defect #1: the timeout must actually take effect (37s of work else).
      expect(elapsed).toBeLessThan(3000);
      expect(result.exitCode).not.toBe(0);

      // Defect #2: nothing may survive the kill, background jobs included.
      await new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS + 300));
      expect(survivingChildren()).toEqual([]);

      // The agent must self-heal so the next command still works. (Ask the
      // manager — a reset session is replaced lazily; the old handle is dead.)
      const after = await manager.execute('agent-timeout', 'echo OK_AFTER', { timeoutMs: 3000 });
      expect(after.exitCode).toBe(0);
      expect(after.stdout).toContain('OK_AFTER');
    },
    20000,
  );
});
