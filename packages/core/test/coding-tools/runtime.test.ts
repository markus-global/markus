import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { TaskContextResponse, ToolAdapter } from '@markus/shared';

const { mockSpawn, mockInjectContext } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockInjectContext: vi.fn(() => ({ filesCreated: [] as string[], envVars: {} as Record<string, string> })),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: (...args: unknown[]) => mockSpawn(...args) };
});

vi.mock('../../src/coding-tools/context-injector.js', () => ({
  injectContext: (...args: unknown[]) => mockInjectContext(...args),
}));

vi.mock('@markus/shared', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveBinary: (name: string, path?: string) => path ?? name,
    isWindows: () => false,
  };
});

type RuntimeModule = typeof import('../../src/coding-tools/runtime.js');
let CodingToolRuntime: RuntimeModule['CodingToolRuntime'];

function makeTaskContext(): TaskContextResponse {
  return {
    task: {
      id: 'task-001',
      title: 'Fix bug',
      description: 'Fix the login bug',
      status: 'in_progress',
      priority: 'high',
      subtasks: [],
      assignedAgentId: 'agent-1',
      reviewerId: 'agent-2',
      executionRound: 1,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
    upstream: [],
    downstream: [],
  };
}

function createMockAdapter(overrides?: Partial<ToolAdapter>): ToolAdapter {
  return {
    name: 'claude-code',
    displayName: 'Claude Code',
    binaryName: 'claude',
    detect: vi.fn(),
    buildArgs: vi.fn(() => ({ args: ['--print', 'test'], env: {} })),
    parseOutput: vi.fn((line: string) =>
      line.trim()
        ? { type: 'progress' as const, content: line.trim(), timestamp: new Date().toISOString() }
        : null,
    ),
    extractCost: vi.fn(() => null),
    ...overrides,
  };
}

function createMockProcess(exitCode = 0, stdout = '', stderr = '') {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.killed = false;
  proc.kill = vi.fn(() => {
    proc.killed = true;
  });

  setTimeout(() => {
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
    if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
    proc.emit('close', exitCode);
  }, 50);

  return proc;
}

describe('CodingToolRuntime', () => {
  beforeEach(async () => {
    vi.resetModules();
    mockSpawn.mockReset();
    mockInjectContext.mockReset();
    mockInjectContext.mockReturnValue({ filesCreated: [], envVars: {} });
    const mod = await import('../../src/coding-tools/runtime.js');
    CodingToolRuntime = mod.CodingToolRuntime;
  });

  it('session lifecycle: created → context_injected → running → completed', async () => {
    mockSpawn.mockReturnValue(createMockProcess(0, 'Working...\nDone\n'));

    const runtime = new CodingToolRuntime();
    const adapter = createMockAdapter();
    const statusHistory: string[] = [];

    const session = await runtime.execute('Fix the bug', {
      adapter,
      repoPath: '/tmp/repo',
      taskContext: makeTaskContext(),
      onStatusChange: (s) => statusHistory.push(s.status),
    });

    expect(statusHistory).toEqual(['created', 'context_injected', 'running', 'completed']);
    expect(session.status).toBe('completed');
    expect(session.result?.success).toBe(true);
    expect(session.worktreePath).toBe('/tmp/repo');
    expect(mockInjectContext).toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      ['--print', 'test'],
      expect.objectContaining({ cwd: '/tmp/repo' }),
    );
  });

  it('session lifecycle: failed when tool exits non-zero', async () => {
    mockSpawn.mockReturnValue(createMockProcess(1, '', 'Something went wrong'));

    const runtime = new CodingToolRuntime();
    const adapter = createMockAdapter();

    const session = await runtime.execute('Fix the bug', {
      adapter,
      repoPath: '/tmp/repo',
      taskContext: makeTaskContext(),
    });

    expect(session.status).toBe('failed');
    expect(session.result?.success).toBe(false);
    expect(session.result?.exitCode).toBe(1);
    expect(session.result?.error).toContain('Something went wrong');
  });

  it('streams progress events and updates progressMessage', async () => {
    mockSpawn.mockReturnValue(createMockProcess(0, 'Step 1\nStep 2\n'));

    const runtime = new CodingToolRuntime();
    const adapter = createMockAdapter();
    const events: string[] = [];

    const session = await runtime.execute('Do work', {
      adapter,
      repoPath: '/tmp/repo',
      taskContext: makeTaskContext(),
      onEvent: (e) => events.push(e.content),
    });

    expect(events).toContain('Step 1');
    expect(events).toContain('Step 2');
    expect(session.progressMessage).toBe('Step 2');
  });

  it('handles timeout: session status becomes timeout', async () => {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
      killed: boolean;
      kill: ReturnType<typeof vi.fn>;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write: vi.fn(), end: vi.fn() };
    proc.killed = false;
    proc.kill = vi.fn(() => {
      proc.killed = true;
    });
    mockSpawn.mockReturnValue(proc);

    const runtime = new CodingToolRuntime();
    const adapter = createMockAdapter();

    const session = await runtime.execute('Slow task', {
      adapter,
      repoPath: '/tmp/repo',
      taskContext: makeTaskContext(),
      config: { tool: 'claude-code', enabled: true, timeoutMs: 50 },
    });

    expect(session.status).toBe('failed');
    expect(session.result?.error).toContain('timed out');
    expect(proc.kill).toHaveBeenCalled();
  });

  it('cancel: running session can be cancelled', async () => {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
      killed: boolean;
      kill: ReturnType<typeof vi.fn>;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write: vi.fn(), end: vi.fn() };
    proc.killed = false;
    proc.kill = vi.fn(() => {
      proc.killed = true;
      proc.emit('close', null);
    });
    mockSpawn.mockReturnValue(proc);

    const runtime = new CodingToolRuntime();
    const adapter = createMockAdapter();
    let sessionId = '';

    const executePromise = runtime.execute('Long task', {
      adapter,
      repoPath: '/tmp/repo',
      taskContext: makeTaskContext(),
      onStatusChange: (s) => {
        if (s.status === 'running') sessionId = s.id;
      },
    });

    await new Promise((r) => setTimeout(r, 30));
    runtime.cancel(sessionId);
    const session = await executePromise;

    expect(proc.kill).toHaveBeenCalled();
    expect(session.status).toBe('cancelled');
  });

  it('handles spawn errors gracefully', async () => {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
      killed: boolean;
      kill: ReturnType<typeof vi.fn>;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write: vi.fn(), end: vi.fn() };
    proc.killed = false;
    proc.kill = vi.fn();
    mockSpawn.mockReturnValue(proc);

    setTimeout(() => proc.emit('error', new Error('ENOENT: claude not found')), 10);

    const runtime = new CodingToolRuntime();
    const adapter = createMockAdapter();

    const session = await runtime.execute('Fix bug', {
      adapter,
      repoPath: '/tmp/repo',
      taskContext: makeTaskContext(),
    });

    expect(session.status).toBe('failed');
    expect(session.result?.error).toContain('ENOENT');
    expect(session.result?.exitCode).toBe(-1);
  });

  it('getSession() returns session or undefined', async () => {
    mockSpawn.mockReturnValue(createMockProcess(0));

    const runtime = new CodingToolRuntime();
    const adapter = createMockAdapter();

    expect(runtime.getSession('nonexistent')).toBeUndefined();

    const session = await runtime.execute('Task', {
      adapter,
      repoPath: '/tmp/repo',
      taskContext: makeTaskContext(),
    });

    expect(runtime.getSession(session.id)).toBe(session);
  });

  it('extracts cost from adapter on completion', async () => {
    mockSpawn.mockReturnValue(createMockProcess(0, 'output with cost'));

    const runtime = new CodingToolRuntime();
    const cost = { inputTokens: 100, outputTokens: 50, source: 'tool_output' as const };
    const adapter = createMockAdapter({
      extractCost: vi.fn(() => cost),
    });

    const session = await runtime.execute('Task', {
      adapter,
      repoPath: '/tmp/repo',
      taskContext: makeTaskContext(),
    });

    expect(session.cost).toEqual(cost);
    expect(adapter.extractCost).toHaveBeenCalledWith('output with cost');
  });
});
