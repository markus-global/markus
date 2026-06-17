import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ShellSessionManager } from '../src/tools/shell-session.js';
import { SHELL_SESSION_IDLE_TIMEOUT_MS } from '@markus/shared';

describe('ShellSessionManager', () => {
  let manager: ShellSessionManager;
  let originalShell: string | undefined;

  beforeEach(() => {
    originalShell = process.env['SHELL'];
    process.env['SHELL'] = '/bin/sh';
    manager = new ShellSessionManager();
  });

  afterEach(() => {
    manager.destroyAll();
    if (originalShell === undefined) {
      delete process.env['SHELL'];
    } else {
      process.env['SHELL'] = originalShell;
    }
  });

  it('creates default session for agent lazily on execute', async () => {
    const result = await manager.execute('agent-1', 'echo session-test');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('session-test');

    const sessions = manager.listForAgent('agent-1');
    expect(sessions.length).toBe(1);
    expect(sessions[0].alive).toBe(true);
  });

  it('persists shell state across commands in same session', async () => {
    await manager.execute('agent-2', 'export MARKUS_TEST=hello');
    const result = await manager.execute('agent-2', 'echo $MARKUS_TEST');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
  });

  it('creates named session via create()', async () => {
    const session = manager.create('agent-3', 'build');
    expect(session).not.toBeNull();
    expect(session!.alive).toBe(true);

    const result = await manager.execute('agent-3', 'echo named-session', {
      sessionId: 'agent-3:build',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('named-session');
  });

  it('returns null when max sessions per agent exceeded', async () => {
    manager.create('agent-4', 's1');
    manager.create('agent-4', 's2');
    manager.create('agent-4', 's3');
    const fourth = manager.create('agent-4', 's4');
    expect(fourth).toBeNull();
  });

  it('returns error for unknown session id', async () => {
    const result = await manager.execute('agent-5', 'echo x', {
      sessionId: 'agent-5:nonexistent',
    });
    expect(result.exitCode).toBe(-1);
    expect(result.stdout).toContain('not found');
  });

  it('returns busy message when session has pending command', async () => {
    const session = manager.getOrCreateDefault('agent-6');
    const slowPromise = session.execute('sleep 2 && echo slow', 5000);
    const busyResult = await session.execute('echo fast', 1000);
    expect(busyResult.exitCode).toBe(-1);
    expect(busyResult.stdout).toContain('busy');
    await slowPromise;
  });

  it('kills session and removes from registry', async () => {
    await manager.execute('agent-7', 'echo before-kill');
    const sessions = manager.listForAgent('agent-7');
    expect(sessions.length).toBe(1);

    const killed = manager.killSession(`${sessions[0].id}`);
    expect(killed).toBe(true);
    expect(manager.listForAgent('agent-7')).toHaveLength(0);
  });

  it('killAllForAgent removes all agent sessions', async () => {
    manager.create('agent-8', 'a');
    manager.create('agent-8', 'b');
    expect(manager.listForAgent('agent-8').length).toBe(2);

    manager.killAllForAgent('agent-8');
    expect(manager.listForAgent('agent-8')).toHaveLength(0);
  });

  it('destroyAll cleans up all sessions', async () => {
    await manager.execute('agent-9', 'echo one');
    manager.create('agent-10', 'x');
    manager.destroyAll();
    expect(manager.listForAgent('agent-9')).toHaveLength(0);
    expect(manager.listForAgent('agent-10')).toHaveLength(0);
  });

  it('handles cd to invalid directory', async () => {
    const result = await manager.execute('agent-11', 'echo fail', {
      cwd: '/nonexistent/path/xyz123',
    });
    expect(result.exitCode).toBe(-1);
    expect(result.stdout).toContain('Failed to cd');
  });

  it('times out long-running commands', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const execPromise = manager.execute('agent-12', 'sleep 30', { timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(600);
    const result = await execPromise;
    expect(result.exitCode).toBe(-1);
    expect(result.stdout).toContain('timed out');
    vi.useRealTimers();
  }, 15000);

  it('cleans up dead sessions on get()', async () => {
    const session = manager.getOrCreateDefault('agent-13');
    session.kill();
    const retrieved = manager.get('agent-13:default');
    expect(retrieved).toBeUndefined();
  });

  it('kills idle sessions after timeout', async () => {
    vi.useFakeTimers();
    await manager.execute('agent-14', 'echo idle-test');
    expect(manager.listForAgent('agent-14')).toHaveLength(1);

    vi.advanceTimersByTime(SHELL_SESSION_IDLE_TIMEOUT_MS + 1000);
    await vi.runAllTimersAsync();

    expect(manager.listForAgent('agent-14')).toHaveLength(0);
    vi.useRealTimers();
  });
});
