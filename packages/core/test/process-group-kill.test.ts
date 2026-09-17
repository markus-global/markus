/**
 * Regression tests for the process-group leak.
 *
 * Real-world failure this reproduces:
 *   `background_exec("pnpm test")` timed out → the `sh -c` wrapper was
 *   SIGTERM'd → the wrapper died but `vitest` + its fork workers survived,
 *   reparented to PID 1, and kept burning 100% CPU / 3.4 GB for 38+ minutes
 *   with no way to reach them again.
 *
 * A stub "grandchild that ignores SIGTERM" is used so the SIGKILL escalation
 * is exercised as well.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createBackgroundExecTool, createProcessTool } from '../src/tools/process-manager.js';

/** A grandchild that refuses to die on SIGTERM (the shape of a stuck worker). */
const STUB = `node -e "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"`;

const bgExec = createBackgroundExecTool();
const proc = createProcessTool();

const tracked: number[] = [];
const cleanup: Array<() => void> = [];

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** SIGKILL a pid and its process group — best effort, never throws. */
function hardKill(pid: number): void {
  for (const sig of ['SIGKILL'] as const) {
    try { process.kill(-pid, sig); } catch { /* group gone */ }
    try { process.kill(pid, sig); } catch { /* already dead */ }
  }
}

async function grandchildPid(sessionId: string, marker: string): Promise<number> {
  for (let i = 0; i < 40; i++) {
    const res = JSON.parse(await proc.execute({ action: 'poll', sessionId, tail: 100 }));
    const match = String(res.stdout ?? '').match(new RegExp(`${marker}=(\\d+)`));
    if (match) return Number(match[1]);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`marker ${marker} never appeared in session ${sessionId}`);
}

async function waitUntilDead(pid: number, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

afterEach(async () => {
  // Never leak test processes onto the developer machine.
  try {
    const list = JSON.parse(await proc.execute({ action: 'list' }));
    for (const s of list.sessions ?? []) {
      await proc.execute({ action: 'kill', sessionId: s.id });
      if (s.pid) hardKill(s.pid);
    }
    await proc.execute({ action: 'clear' });
  } catch { /* ignore */ }
  for (const pid of tracked) hardKill(pid);
  for (const fn of cleanup.splice(0)) {
    try { fn(); } catch { /* ignore */ }
  }
  tracked.length = 0;
});

describe('background_exec process-group isolation', () => {
  it('runs the wrapper in its own process group, not Markus\' own group', async () => {
    const res = JSON.parse(await bgExec.execute({ command: 'sleep 1', timeout_seconds: 30 }));
    expect(res.status).toBe('running');
    expect(res.killsProcessTree).toBe(true);
  });

  it('process kill reaps a grandchild that ignores SIGTERM (SIGKILL escalation)', async () => {
    const start = JSON.parse(
      await bgExec.execute({ command: `${STUB} &\necho STUB_PID=$!\nwait`, timeout_seconds: 60 }),
    );
    const stubPid = await grandchildPid(start.sessionId, 'STUB_PID');
    tracked.push(stubPid);
    expect(isAlive(stubPid)).toBe(true);

    const kill = JSON.parse(await proc.execute({ action: 'kill', sessionId: start.sessionId }));
    expect(kill.status).toBe('success');
    expect(kill.message).toContain('PID');

    // SIGTERM is ignored → the SIGKILL grace period must finish the job.
    await waitUntilDead(stubPid, 6000);
    expect(isAlive(stubPid)).toBe(false);
  });

  it('the auto-kill timeout reaps the whole tree, not just the wrapper', async () => {
    const start = JSON.parse(
      await bgExec.execute({ command: `${STUB} &\necho STUB_PID=$!\nwait`, timeout_seconds: 1 }),
    );
    const stubPid = await grandchildPid(start.sessionId, 'STUB_PID');
    tracked.push(stubPid);

    // Timeout fires at 1s (SIGTERM), escalation at +2s (SIGKILL).
    await waitUntilDead(stubPid, 8000);
    expect(isAlive(stubPid)).toBe(false);

    const poll = JSON.parse(await proc.execute({ action: 'poll', sessionId: start.sessionId }));
    expect(poll.running).toBe(false);
  });

  it('flags leaked descendants after the wrapper exits and can still reap them', async () => {
    // The production shape: the wrapper returns immediately, the real work is
    // left behind in the same (now leaderless) process group.
    const start = JSON.parse(
      await bgExec.execute({ command: `${STUB} &\necho ORPHAN_PID=$!`, timeout_seconds: 60 }),
    );
    const orphanPid = await grandchildPid(start.sessionId, 'ORPHAN_PID');
    tracked.push(orphanPid);

    await new Promise((r) => setTimeout(r, 600));
    const list = JSON.parse(await proc.execute({ action: 'list' }));
    const session = list.sessions.find((s: { id: string }) => s.id === start.sessionId);
    expect(session.running).toBe(false);
    expect(session.orphanedDescendants).toBe(true);

    const reap = JSON.parse(await proc.execute({ action: 'kill', sessionId: start.sessionId }));
    expect(reap.status).toBe('success');
    expect(reap.reaped).toBe(true);

    await waitUntilDead(orphanPid, 6000);
    expect(isAlive(orphanPid)).toBe(false);
  });

  it('reports a clean exit as already-exited instead of a fake reap', async () => {
    const start = JSON.parse(await bgExec.execute({ command: 'echo done' }));
    await new Promise((r) => setTimeout(r, 500));
    const kill = JSON.parse(await proc.execute({ action: 'kill', sessionId: start.sessionId }));
    expect(kill.status).toBe('success');
    expect(kill.message).toContain('already exited');
  });
});
