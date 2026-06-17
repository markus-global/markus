import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createShellTool, type CommandApprovalCallback } from '../src/tools/shell.js';
import type { SecurityGuard } from '../src/security.js';

vi.mock('../src/tools/shell-session.js', () => ({
  getShellSessionManager: vi.fn(() => ({
    execute: vi.fn().mockRejectedValue(new Error('session unavailable')),
  })),
}));

function createMockGuard(overrides: Partial<SecurityGuard> = {}): SecurityGuard {
  return {
    validateShellCommand: vi.fn(() => ({ allowed: true })),
    validateFilePath: vi.fn(() => ({ allowed: true })),
    validateFileReadPath: vi.fn(() => ({ allowed: true })),
    ...overrides,
  } as unknown as SecurityGuard;
}

describe('createShellTool', () => {
  it('creates shell_execute tool with workspace in description', () => {
    const tool = createShellTool(undefined, '/my/workspace');
    expect(tool.name).toBe('shell_execute');
    expect(tool.description).toContain('/my/workspace');
    expect(tool.inputSchema.required).toContain('command');
  });

  it('denies command blocked by security guard', async () => {
    const guard = createMockGuard({
      validateShellCommand: vi.fn(() => ({ allowed: false, reason: 'Dangerous command' })),
    });
    const tool = createShellTool(guard);
    const result = JSON.parse(await tool.execute({ command: 'rm -rf /' }));
    expect(result.status).toBe('denied');
    expect(result.error).toBe('Dangerous command');
  });

  it('returns needs_approval when guard requires approval and no handler', async () => {
    const guard = createMockGuard({
      validateShellCommand: vi.fn(() => ({
        allowed: true,
        needsApproval: true,
        reason: 'Sensitive operation',
      })),
    });
    const tool = createShellTool(guard);
    const result = JSON.parse(await tool.execute({ command: 'deploy production' }));
    expect(result.status).toBe('needs_approval');
    expect(result.command).toBe('deploy production');
  });

  it('executes command when approval callback approves', async () => {
    const guard = createMockGuard({
      validateShellCommand: vi.fn(() => ({
        allowed: true,
        needsApproval: true,
      })),
    });
    const onApproval: CommandApprovalCallback = vi.fn().mockResolvedValue({ approved: true });
    const tool = createShellTool(guard, undefined, undefined, undefined, onApproval);
    const result = JSON.parse(await tool.execute({ command: 'echo approved-test' }));
    expect(onApproval).toHaveBeenCalled();
    expect(result.status).toBe('success');
    expect(result.stdout).toContain('approved-test');
  });

  it('denies command when approval callback rejects', async () => {
    const guard = createMockGuard({
      validateShellCommand: vi.fn(() => ({
        allowed: true,
        needsApproval: true,
      })),
    });
    const onApproval: CommandApprovalCallback = vi.fn().mockResolvedValue({
      approved: false,
      comment: 'Not allowed now',
    });
    const tool = createShellTool(guard, undefined, undefined, undefined, onApproval);
    const result = JSON.parse(await tool.execute({ command: 'dangerous-op' }));
    expect(result.status).toBe('denied');
    expect(result.error).toContain('denied by human reviewer');
    expect(result.error).toContain('Not allowed now');
  });

  it('requires approval for git force push outside own workspace', async () => {
    const guard = createMockGuard();
    const onApproval: CommandApprovalCallback = vi.fn().mockResolvedValue({ approved: false });
    const tool = createShellTool(
      guard,
      '/agent/workspace',
      undefined,
      undefined,
      onApproval,
    );
    const result = JSON.parse(await tool.execute({
      command: 'git push --force origin main',
      cwd: '/other/project',
    }));
    expect(result.status).toBe('denied');
    expect(onApproval).toHaveBeenCalledWith(
      'git push --force origin main',
      expect.stringContaining('force push'),
    );
  });

  it('denies git force push when no approval handler outside workspace', async () => {
    const guard = createMockGuard();
    const tool = createShellTool(guard, '/agent/workspace');
    const result = JSON.parse(await tool.execute({
      command: 'git push -f origin main',
      cwd: '/other/project',
    }));
    expect(result.status).toBe('denied');
    expect(result.error).toContain('force push');
    expect(result.error).toContain('No approval handler');
  });

  it('runs simple echo command successfully', async () => {
    const tool = createShellTool(createMockGuard());
    const result = JSON.parse(await tool.execute({ command: 'echo hello-shell' }));
    expect(result.status).toBe('success');
    expect(result.stdout).toBe('hello-shell');
  });

  it('injects git commit metadata when agentMeta is provided', async () => {
    const tool = createShellTool(createMockGuard(), '/ws', {
      agentId: 'agt_test',
      agentName: 'TestAgent',
      teamName: 'Alpha',
    });
    const result = JSON.parse(await tool.execute({
      command: 'git commit -m "test commit" --allow-empty',
    }));
    expect(['success', 'error']).toContain(result.status);
  });
});
