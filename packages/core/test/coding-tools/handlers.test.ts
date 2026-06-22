import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskContextResponse, ToolAdapter } from '@markus/shared';

const { mockGetAdapter, mockRuntimeExecute } = vi.hoisted(() => ({
  mockGetAdapter: vi.fn(),
  mockRuntimeExecute: vi.fn(),
}));

vi.mock('../../src/coding-tools/adapters/index.js', () => ({
  getAdapter: (...args: unknown[]) => mockGetAdapter(...args),
}));

vi.mock('../../src/coding-tools/runtime.js', () => ({
  CodingToolRuntime: vi.fn().mockImplementation(function MockCodingToolRuntime(this: { execute: typeof mockRuntimeExecute }) {
    this.execute = (...args: unknown[]) => mockRuntimeExecute(...args);
  }),
}));

const { mockExecFileSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

function makeTaskContext(overrides?: Partial<TaskContextResponse['task']>): TaskContextResponse {
  return {
    task: {
      id: 'task-123',
      title: 'Implement login',
      description: 'Add user login feature',
      status: 'in_progress',
      priority: 'high',
      subtasks: [],
      assignedAgentId: 'agent-1',
      reviewerId: 'agent-2',
      executionRound: 1,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      ...overrides,
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
    detect: vi.fn().mockResolvedValue({ available: true }),
    buildArgs: vi.fn(() => ({ args: [], env: {} })),
    listModels: vi.fn().mockResolvedValue([]),
    parseOutput: vi.fn(() => null),
    extractCost: vi.fn(() => null),
    ...overrides,
  };
}

describe('invoke_coding_tool handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRuntimeExecute.mockReset();
    mockGetAdapter.mockReset();
    mockExecFileSync.mockReset();
  });

  it('returns error for unknown tool name', async () => {
    const { createInvokeCodingToolHandler } = await import('../../src/coding-tools/handlers.js');
    const handler = createInvokeCodingToolHandler();

    const result = JSON.parse(
      await handler.execute({
        tool: 'copilot',
        prompt: 'Do something',
        workdir: '/tmp/repo',
      }),
    );

    expect(result.error).toContain('Unknown coding tool');
    expect(mockGetAdapter).not.toHaveBeenCalled();
  });

  it('returns error when tool not installed', async () => {
    const adapter = createMockAdapter({
      detect: vi.fn().mockResolvedValue({
        available: false,
        installHint: 'Run npm install -g @anthropic-ai/claude-code',
      }),
    });
    mockGetAdapter.mockReturnValue(adapter);

    const { createInvokeCodingToolHandler } = await import('../../src/coding-tools/handlers.js');
    const handler = createInvokeCodingToolHandler();

    const result = JSON.parse(
      await handler.execute({
        tool: 'claude-code',
        prompt: 'Fix bug',
        workdir: '/tmp/repo',
      }),
    );

    expect(result.error).toContain('Claude Code is not installed');
    expect(result.installHint).toContain('claude-code');
    expect(mockRuntimeExecute).not.toHaveBeenCalled();
  });

  it('invokes runtime and returns success result', async () => {
    const adapter = createMockAdapter();
    mockGetAdapter.mockReturnValue(adapter);
    mockRuntimeExecute.mockResolvedValue({
      id: 'session-abc',
      taskId: 'task-123',
      tool: 'claude-code',
      status: 'completed',
      prompt: 'Implement login',
      createdAt: '2026-01-01T00:00:00Z',
      result: { success: true, summary: 'Done' },
      cost: { inputTokens: 100, outputTokens: 50, source: 'tool_output' },
    });

    const { createInvokeCodingToolHandler } = await import('../../src/coding-tools/handlers.js');
    const handler = createInvokeCodingToolHandler();

    const result = JSON.parse(
      await handler.execute({
        tool: 'claude-code',
        prompt: 'Implement login',
        workdir: '/tmp/repo',
        task_id: 'task-123',
      }),
    );

    expect(result.status).toBe('success');
    expect(result.sessionId).toBe('session-abc');
    expect(result.tool).toBe('claude-code');
    expect(result.result).toEqual({ success: true, summary: 'Done' });
    expect(result.cost).toEqual({ inputTokens: 100, outputTokens: 50, source: 'tool_output' });
    expect(mockRuntimeExecute).toHaveBeenCalledWith(
      'Implement login',
      expect.objectContaining({
        adapter,
        repoPath: '/tmp/repo',
      }),
    );
  });

  it('invokes runtime and returns failure result', async () => {
    const adapter = createMockAdapter();
    mockGetAdapter.mockReturnValue(adapter);
    mockRuntimeExecute.mockResolvedValue({
      id: 'session-fail',
      taskId: 'unknown',
      tool: 'claude-code',
      status: 'failed',
      prompt: 'Broken task',
      createdAt: '2026-01-01T00:00:00Z',
      result: { success: false, summary: 'Tool failed', error: 'Exit code 1' },
    });

    const { createInvokeCodingToolHandler } = await import('../../src/coding-tools/handlers.js');
    const handler = createInvokeCodingToolHandler();

    const result = JSON.parse(
      await handler.execute({
        tool: 'claude-code',
        prompt: 'Broken task',
        workdir: '/tmp/repo',
      }),
    );

    expect(result.status).toBe('error');
    expect(result.sessionId).toBe('session-fail');
    expect(result.result?.success).toBe(false);
  });

  it('streams progress events via onOutput', async () => {
    const adapter = createMockAdapter({ displayName: 'Claude Code' });
    mockGetAdapter.mockReturnValue(adapter);
    mockRuntimeExecute.mockImplementation(async (_prompt, options) => {
      options?.onEvent?.({ type: 'progress', content: 'Working on file.ts', timestamp: '2026-01-01T00:00:00Z' });
      options?.onEvent?.({ type: 'file_edit', content: 'Edited src/index.ts', timestamp: '2026-01-01T00:00:01Z' });
      options?.onEvent?.({ type: 'error', content: 'ignored', timestamp: '2026-01-01T00:00:02Z' });
      return {
        id: 'session-stream',
        taskId: 'unknown',
        tool: 'claude-code',
        status: 'completed',
        prompt: 'Stream test',
        createdAt: '2026-01-01T00:00:00Z',
        result: { success: true, summary: 'Done' },
      };
    });

    const { createInvokeCodingToolHandler } = await import('../../src/coding-tools/handlers.js');
    const handler = createInvokeCodingToolHandler();
    const chunks: string[] = [];

    await handler.execute(
      { tool: 'claude-code', prompt: 'Stream test', workdir: '/tmp/repo' },
      (chunk) => chunks.push(chunk),
    );

    expect(chunks.some((c) => c.includes('Starting Claude Code'))).toBe(true);
    expect(chunks.some((c) => c.includes('[Claude Code] Working on file.ts'))).toBe(true);
    expect(chunks.some((c) => c.includes('[Claude Code] Edited src/index.ts'))).toBe(true);
    expect(chunks.some((c) => c.includes('ignored'))).toBe(false);
  });

  it('handles runtime exceptions gracefully', async () => {
    const adapter = createMockAdapter();
    mockGetAdapter.mockReturnValue(adapter);
    mockRuntimeExecute.mockRejectedValue(new Error('Spawn failed'));

    const { createInvokeCodingToolHandler } = await import('../../src/coding-tools/handlers.js');
    const handler = createInvokeCodingToolHandler();

    const result = JSON.parse(
      await handler.execute({
        tool: 'claude-code',
        prompt: 'Crash',
        workdir: '/tmp/repo',
      }),
    );

    expect(result.error).toBe('Spawn failed');
  });

  it('enforces approvalRequired when config has it enabled', async () => {
    const adapter = createMockAdapter();
    mockGetAdapter.mockReturnValue(adapter);

    const { createInvokeCodingToolHandler } = await import('../../src/coding-tools/handlers.js');
    const handler = createInvokeCodingToolHandler({
      configs: { 'claude-code': { tool: 'claude-code', enabled: true, approvalRequired: true } },
    });

    const result = JSON.parse(
      await handler.execute({
        tool: 'claude-code',
        prompt: 'Do something',
        workdir: '/tmp/repo',
      }),
    );

    expect(result.error).toBe('approval_required');
    expect(result.message).toContain('request_user_approval');
    expect(mockRuntimeExecute).not.toHaveBeenCalled();
  });

  it('allows execution when approved=true despite approvalRequired', async () => {
    const adapter = createMockAdapter();
    mockGetAdapter.mockReturnValue(adapter);
    mockRuntimeExecute.mockResolvedValue({
      id: 'session-approved',
      taskId: 'unknown',
      tool: 'claude-code',
      status: 'completed',
      prompt: 'Approved task',
      createdAt: '2026-01-01T00:00:00Z',
      result: { success: true, summary: 'Done' },
    });

    const { createInvokeCodingToolHandler } = await import('../../src/coding-tools/handlers.js');
    const handler = createInvokeCodingToolHandler({
      configs: { 'claude-code': { tool: 'claude-code', enabled: true, approvalRequired: true } },
    });

    const result = JSON.parse(
      await handler.execute({
        tool: 'claude-code',
        prompt: 'Approved task',
        workdir: '/tmp/repo',
        approved: true,
      }),
    );

    expect(result.status).toBe('success');
    expect(mockRuntimeExecute).toHaveBeenCalled();
  });

  it('passes model override through to runtime options', async () => {
    const adapter = createMockAdapter();
    mockGetAdapter.mockReturnValue(adapter);
    mockRuntimeExecute.mockResolvedValue({
      id: 'session-model',
      taskId: 'unknown',
      tool: 'claude-code',
      status: 'completed',
      prompt: 'Model test',
      createdAt: '2026-01-01T00:00:00Z',
      result: { success: true, summary: 'Done' },
    });

    const { createInvokeCodingToolHandler } = await import('../../src/coding-tools/handlers.js');
    const handler = createInvokeCodingToolHandler();

    const result = JSON.parse(
      await handler.execute({
        tool: 'claude-code',
        prompt: 'Model test',
        workdir: '/tmp/repo',
        model: 'opus',
        mode: 'plan',
        effort: 'high',
      }),
    );

    expect(result.status).toBe('success');
    expect(result.model).toBe('opus');
    expect(result.mode).toBe('plan');
    expect(mockRuntimeExecute).toHaveBeenCalledWith(
      'Model test',
      expect.objectContaining({
        model: 'opus',
        mode: 'plan',
        effort: 'high',
      }),
    );
  });

  it('resolves model from config.defaultModel when no override', async () => {
    const adapter = createMockAdapter();
    mockGetAdapter.mockReturnValue(adapter);
    mockRuntimeExecute.mockResolvedValue({
      id: 'session-default-model',
      taskId: 'unknown',
      tool: 'claude-code',
      status: 'completed',
      prompt: 'Default model test',
      createdAt: '2026-01-01T00:00:00Z',
      result: { success: true, summary: 'Done' },
    });

    const { createInvokeCodingToolHandler } = await import('../../src/coding-tools/handlers.js');
    const handler = createInvokeCodingToolHandler({
      configs: { 'claude-code': { tool: 'claude-code', enabled: true, defaultModel: 'haiku' } },
    });

    const result = JSON.parse(
      await handler.execute({
        tool: 'claude-code',
        prompt: 'Default model test',
        workdir: '/tmp/repo',
      }),
    );

    expect(result.model).toBe('haiku');
    expect(mockRuntimeExecute).toHaveBeenCalledWith(
      'Default model test',
      expect.objectContaining({ model: 'haiku' }),
    );
  });

  it('passes maxBudgetUsd for claude-code from config', async () => {
    const adapter = createMockAdapter();
    mockGetAdapter.mockReturnValue(adapter);
    mockRuntimeExecute.mockResolvedValue({
      id: 'session-budget',
      taskId: 'unknown',
      tool: 'claude-code',
      status: 'completed',
      prompt: 'Budget test',
      createdAt: '2026-01-01T00:00:00Z',
      result: { success: true, summary: 'Done' },
    });

    const { createInvokeCodingToolHandler } = await import('../../src/coding-tools/handlers.js');
    const handler = createInvokeCodingToolHandler({
      configs: { 'claude-code': { tool: 'claude-code', enabled: true, maxBudgetPerSessionUsd: 5.0 } },
    });

    await handler.execute({
      tool: 'claude-code',
      prompt: 'Budget test',
      workdir: '/tmp/repo',
    });

    expect(mockRuntimeExecute).toHaveBeenCalledWith(
      'Budget test',
      expect.objectContaining({ maxBudgetUsd: 5.0 }),
    );
  });

  it('does not pass maxBudgetUsd for non-claude-code tools', async () => {
    const adapter = createMockAdapter({ name: 'codex' as any, displayName: 'Codex', binaryName: 'codex' });
    mockGetAdapter.mockReturnValue(adapter);
    mockRuntimeExecute.mockResolvedValue({
      id: 'session-no-budget',
      taskId: 'unknown',
      tool: 'codex',
      status: 'completed',
      prompt: 'No budget test',
      createdAt: '2026-01-01T00:00:00Z',
      result: { success: true, summary: 'Done' },
    });

    const { createInvokeCodingToolHandler } = await import('../../src/coding-tools/handlers.js');
    const handler = createInvokeCodingToolHandler({
      configs: { codex: { tool: 'codex', enabled: true, maxBudgetPerSessionUsd: 5.0 } },
    });

    await handler.execute({
      tool: 'codex',
      prompt: 'No budget test',
      workdir: '/tmp/repo',
    });

    expect(mockRuntimeExecute).toHaveBeenCalledWith(
      'No budget test',
      expect.objectContaining({ maxBudgetUsd: undefined }),
    );
  });

  it('fetches task context when task_id provided', async () => {
    const adapter = createMockAdapter();
    mockGetAdapter.mockReturnValue(adapter);
    const taskContext = makeTaskContext();
    const getTaskContext = vi.fn().mockResolvedValue(taskContext);
    mockRuntimeExecute.mockResolvedValue({
      id: 'session-ctx',
      taskId: 'task-123',
      tool: 'claude-code',
      status: 'completed',
      prompt: 'With context',
      createdAt: '2026-01-01T00:00:00Z',
      result: { success: true, summary: 'Done' },
    });

    const { createInvokeCodingToolHandler } = await import('../../src/coding-tools/handlers.js');
    const handler = createInvokeCodingToolHandler({ getTaskContext });

    await handler.execute({
      tool: 'claude-code',
      prompt: 'With context',
      workdir: '/tmp/repo',
      task_id: 'task-123',
    });

    expect(getTaskContext).toHaveBeenCalledWith('task-123');
    expect(mockRuntimeExecute).toHaveBeenCalledWith(
      'With context',
      expect.objectContaining({ taskContext }),
    );
  });
});

describe('coding_tool_apply handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileSync.mockReset();
  });

  it('handles no changes case', async () => {
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'diff') return '';
      if (cmd === 'git' && args[0] === 'status') return '';
      throw new Error(`Unexpected: ${cmd} ${args.join(' ')}`);
    });

    const { createCodingToolApplyHandler } = await import('../../src/coding-tools/handlers.js');
    const handler = createCodingToolApplyHandler();

    const result = JSON.parse(
      await handler.execute({
        session_id: 'session-1',
        workdir: '/tmp/repo',
      }),
    );

    expect(result.status).toBe('success');
    expect(result.message).toBe('No changes to apply');
    expect(result.filesChanged).toBe(0);
  });

  it('commits changes successfully', async () => {
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'diff') return ' src/foo.ts | 2 ++\n 1 file changed, 2 insertions';
      if (cmd === 'git' && args[0] === 'status') return ' M src/foo.ts';
      if (cmd === 'git' && args[0] === 'add') return '';
      if (cmd === 'git' && args[0] === 'commit') return '';
      if (cmd === 'git' && args[0] === 'log') return 'commit abc123\nAuthor: Test\n\n src/foo.ts | 2 ++';
      throw new Error(`Unexpected: ${cmd} ${args.join(' ')}`);
    });

    const { createCodingToolApplyHandler } = await import('../../src/coding-tools/handlers.js');
    const handler = createCodingToolApplyHandler();

    const result = JSON.parse(
      await handler.execute({
        session_id: 'session-1',
        workdir: '/tmp/repo',
      }),
    );

    expect(result.status).toBe('success');
    expect(result.message).toBe('Changes committed successfully');
    expect(result.commitLog).toContain('src/foo.ts');
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git', ['add', '-A'],
      expect.objectContaining({ cwd: '/tmp/repo', timeout: 10_000 }),
    );
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git', ['commit', '-m', 'Apply coding tool changes'],
      expect.objectContaining({ cwd: '/tmp/repo', encoding: 'utf-8', timeout: 10_000 }),
    );
  });

  it('handles git errors gracefully', async () => {
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'diff') return ' src/foo.ts | 1 +';
      if (cmd === 'git' && args[0] === 'status') return ' M src/foo.ts';
      if (cmd === 'git' && args[0] === 'add') return '';
      if (cmd === 'git' && args[0] === 'commit') throw new Error('nothing to commit');
      throw new Error(`Unexpected: ${cmd} ${args.join(' ')}`);
    });

    const { createCodingToolApplyHandler } = await import('../../src/coding-tools/handlers.js');
    const handler = createCodingToolApplyHandler();

    const result = JSON.parse(
      await handler.execute({
        session_id: 'session-1',
        workdir: '/tmp/repo',
      }),
    );

    expect(result.error).toContain('Failed to apply changes');
    expect(result.error).toContain('nothing to commit');
  });
});

describe('createCodingTools', () => {
  it('returns both handlers', async () => {
    const { createCodingTools } = await import('../../src/coding-tools/index.js');
    const handlers = createCodingTools();

    expect(handlers).toHaveLength(2);
    expect(handlers.map((h) => h.name)).toEqual(['invoke_coding_tool', 'coding_tool_apply']);
    expect(handlers[0].inputSchema).toHaveProperty('properties.tool');
    expect(handlers[1].inputSchema).toHaveProperty('properties.session_id');
  });
});
