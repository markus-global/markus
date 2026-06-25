import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExecFileSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

function matchGitArgs(cmd: string, args: string[], target: string, targetArgs?: string[]): boolean {
  if (cmd !== 'git') return false;
  if (targetArgs) return JSON.stringify(args) === JSON.stringify(targetArgs);
  return args[0] === target;
}

describe('coding_tool_apply handler (detailed)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileSync.mockReset();
  });

  it('stages and commits when only diff stats are present', async () => {
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (matchGitArgs(cmd, args, 'diff')) return ' README.md | 1 +\n 1 file changed, 1 insertion';
      if (matchGitArgs(cmd, args, 'status')) return '';
      if (matchGitArgs(cmd, args, 'add')) return '';
      if (matchGitArgs(cmd, args, 'commit')) return '';
      if (matchGitArgs(cmd, args, 'log')) return 'commit def456\n README.md | 1 +';
      throw new Error(`Unexpected command: ${cmd} ${args.join(' ')}`);
    });

    const { createCodingToolApplyHandler } = await import('../../src/coding-tools/handlers.js');
    const handler = createCodingToolApplyHandler();

    const result = JSON.parse(
      await handler.execute({
        session_id: 'session-diff-only',
        workdir: '/tmp/worktree',
      }),
    );

    expect(result.status).toBe('success');
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git', ['add', '-A'],
      expect.objectContaining({ cwd: '/tmp/worktree', timeout: 10_000 }),
    );
  });

  it('uses custom commit message when provided', async () => {
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (matchGitArgs(cmd, args, 'diff')) return '';
      if (matchGitArgs(cmd, args, 'status')) return '?? new-file.ts';
      if (matchGitArgs(cmd, args, 'add')) return '';
      if (matchGitArgs(cmd, args, 'commit')) return '';
      if (matchGitArgs(cmd, args, 'log')) return 'commit custom\n new-file.ts | 10 ++++++++++';
      throw new Error(`Unexpected command: ${cmd} ${args.join(' ')}`);
    });

    const { createCodingToolApplyHandler } = await import('../../src/coding-tools/handlers.js');
    const handler = createCodingToolApplyHandler();

    const result = JSON.parse(
      await handler.execute({
        session_id: 'session-custom-msg',
        workdir: '/tmp/worktree',
        commit_message: 'feat: add login flow',
      }),
    );

    expect(result.status).toBe('success');
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git', ['commit', '-m', 'feat: add login flow'],
      expect.objectContaining({ cwd: '/tmp/worktree', encoding: 'utf-8', timeout: 10_000 }),
    );
  });

  it('passes commit message with quotes as-is (no shell escaping needed)', async () => {
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (matchGitArgs(cmd, args, 'diff')) return '';
      if (matchGitArgs(cmd, args, 'status')) return ' M file.ts';
      if (matchGitArgs(cmd, args, 'add')) return '';
      if (matchGitArgs(cmd, args, 'commit')) return '';
      if (matchGitArgs(cmd, args, 'log')) return 'commit quoted';
      throw new Error(`Unexpected command: ${cmd} ${args.join(' ')}`);
    });

    const { createCodingToolApplyHandler } = await import('../../src/coding-tools/handlers.js');
    const handler = createCodingToolApplyHandler();

    await handler.execute({
      session_id: 'session-quote',
      workdir: '/tmp/worktree',
      commit_message: 'fix: handle "edge" case',
    });

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git', ['commit', '-m', 'fix: handle "edge" case'],
      expect.objectContaining({ cwd: '/tmp/worktree', encoding: 'utf-8', timeout: 10_000 }),
    );
  });

  it('handles conflict scenarios when commit fails', async () => {
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (matchGitArgs(cmd, args, 'diff')) return ' both.ts | 4 ++--';
      if (matchGitArgs(cmd, args, 'status')) return 'UU both.ts';
      if (matchGitArgs(cmd, args, 'add')) return '';
      if (matchGitArgs(cmd, args, 'commit')) {
        throw new Error('error: Committing is not possible because you have unmerged files.');
      }
      throw new Error(`Unexpected command: ${cmd} ${args.join(' ')}`);
    });

    const { createCodingToolApplyHandler } = await import('../../src/coding-tools/handlers.js');
    const handler = createCodingToolApplyHandler();

    const result = JSON.parse(
      await handler.execute({
        session_id: 'session-conflict',
        workdir: '/tmp/worktree',
      }),
    );

    expect(result.error).toContain('Failed to apply changes');
    expect(result.error).toContain('unmerged files');
  });
});
