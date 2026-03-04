import { describe, it, expect } from 'vitest';
import { createBackgroundExecTool, createProcessTool } from '../src/tools/process-manager.js';

describe('Background Process Manager', () => {
  const bgExec = createBackgroundExecTool();
  const proc = createProcessTool();

  it('should start a background process and return session ID', async () => {
    const result = await bgExec.execute({ command: 'echo hello && sleep 0.1' });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('running');
    expect(parsed.sessionId).toBeDefined();
    expect(parsed.pid).toBeGreaterThan(0);
  });

  it('should list running sessions', async () => {
    // Start a process
    const startResult = JSON.parse(await bgExec.execute({ command: 'sleep 2' }));
    expect(startResult.status).toBe('running');

    const listResult = JSON.parse(await proc.execute({ action: 'list' }));
    expect(listResult.status).toBe('success');
    expect(listResult.sessions.length).toBeGreaterThan(0);

    const session = listResult.sessions.find((s: { id: string }) => s.id === startResult.sessionId);
    expect(session).toBeDefined();
    expect(session.running).toBe(true);

    // Cleanup: kill it
    await proc.execute({ action: 'kill', sessionId: startResult.sessionId });
  });

  it('should poll for process output', async () => {
    const startResult = JSON.parse(await bgExec.execute({ command: 'echo "test output" && sleep 0.2' }));

    // Wait for output
    await new Promise(r => setTimeout(r, 500));

    const pollResult = JSON.parse(await proc.execute({ action: 'poll', sessionId: startResult.sessionId }));
    expect(pollResult.status).toBe('success');
    expect(pollResult.stdout).toContain('test output');
  });

  it('should kill a running process', async () => {
    const startResult = JSON.parse(await bgExec.execute({ command: 'sleep 30' }));

    const killResult = JSON.parse(await proc.execute({ action: 'kill', sessionId: startResult.sessionId }));
    expect(killResult.status).toBe('success');
    expect(killResult.message).toContain('PID');

    // Wait for process to die
    await new Promise(r => setTimeout(r, 500));

    const pollResult = JSON.parse(await proc.execute({ action: 'poll', sessionId: startResult.sessionId }));
    expect(pollResult.running).toBe(false);
  });

  it('should clear finished sessions', async () => {
    const startResult = JSON.parse(await bgExec.execute({ command: 'echo done' }));
    await new Promise(r => setTimeout(r, 500));

    const clearResult = JSON.parse(await proc.execute({ action: 'clear' }));
    expect(clearResult.status).toBe('success');
    expect(clearResult.cleared).toBeGreaterThanOrEqual(1);
  });

  it('should return error for missing sessionId', async () => {
    const result = JSON.parse(await proc.execute({ action: 'poll' }));
    expect(result.status).toBe('error');
    expect(result.error).toContain('sessionId required');
  });

  it('should enforce workspace isolation', async () => {
    const tool = createBackgroundExecTool('/tmp/workspace');
    const result = JSON.parse(await tool.execute({ command: 'ls', cwd: '/etc' }));
    expect(result.status).toBe('denied');
  });
});
