import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerTaskCommands } from '../src/commands/task.js';
import * as apiClient from '../src/api-client.js';
import { ApiError } from '../src/api-client.js';
import { setGlobalJson } from '../src/output.js';
import { CLI_EXIT_CODES } from '@markus/shared';

describe('task command', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let mockGet: ReturnType<typeof vi.fn>;
  let mockPost: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    mockGet = vi.fn();
    mockPost = vi.fn();
    setGlobalJson(false);
    vi.spyOn(apiClient, 'createClient').mockReturnValue({
      get: mockGet,
      post: mockPost,
    } as unknown as apiClient.ApiClient);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
    setGlobalJson(false);
    vi.restoreAllMocks();
  });

  function createProgram(json = false) {
    const program = new Command();
    program
      .option('--json')
      .hook('preAction', (_cmd, actionCmd) => {
        if (actionCmd.optsWithGlobals().json) setGlobalJson(true);
      });
    program.exitOverride();
    registerTaskCommands(program);
    return program;
  }

  function runTask(args: string[], json = false): Promise<void> {
    const program = createProgram(json);
    const argv = ['node', 'markus', ...(json ? ['--json'] : []), 'task', ...args];
    return program.parseAsync(argv);
  }

  it('list fetches /tasks and prints table', async () => {
    mockGet.mockResolvedValue({
      tasks: [{
        id: 't1',
        title: 'Fix bug',
        status: 'pending',
        priority: 'high',
        assignedAgentId: 'a1',
      }],
      total: 1,
    });
    await runTask(['list']);
    expect(mockGet).toHaveBeenCalledWith('/tasks', expect.objectContaining({
      page: '1',
      pageSize: '20',
    }));
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Tasks (1 total)');
    expect(output).toContain('t1');
    expect(output).toContain('Fix bug');
    expect(output).toContain('pending');
    expect(output).toContain('high');
    expect(output).toContain('a1');
  });

  it('list --status in_progress passes query param', async () => {
    mockGet.mockResolvedValue({ tasks: [], total: 0 });
    await runTask(['list', '--status', 'in_progress']);
    expect(mockGet).toHaveBeenCalledWith('/tasks', expect.objectContaining({
      status: 'in_progress',
    }));
  });

  it('list --json outputs JSON array', async () => {
    const tasks = [{ id: 't1', title: 'Task 1', status: 'pending', priority: 'low', assignedAgentId: 'a1' }];
    mockGet.mockResolvedValue({ tasks, total: 1 });
    await runTask(['list'], true);
    const output = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(output).toEqual(tasks);
  });

  it('show fetches /tasks/:id and prints detail', async () => {
    mockGet.mockResolvedValue({
      id: 't1',
      title: 'Fix bug',
      status: 'in_progress',
      priority: 'high',
    });
    await runTask(['show', 't1']);
    expect(mockGet).toHaveBeenCalledWith('/tasks/t1');
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Task: Fix bug');
    expect(output).toContain('in_progress');
  });

  it('show --json outputs JSON', async () => {
    const task = { id: 't1', title: 'Fix bug', status: 'pending' };
    mockGet.mockResolvedValue(task);
    await runTask(['show', 't1'], true);
    const output = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(output).toEqual(task);
  });

  it('deps fetches /tasks/:id/dependents and shows upstream/downstream', async () => {
    mockGet.mockResolvedValue({
      upstream: [{ id: 't0', title: 'Blocker', status: 'completed' }],
      downstream: [{ id: 't2', title: 'Blocked task', status: 'blocked' }],
    });
    await runTask(['deps', 't1']);
    expect(mockGet).toHaveBeenCalledWith('/tasks/t1/dependents');
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Upstream (blocked by)');
    expect(output).toContain('t0');
    expect(output).toContain('Blocker');
    expect(output).toContain('Downstream (blocks)');
    expect(output).toContain('t2');
    expect(output).toContain('Blocked task');
  });

  it('deps shows success when no dependencies', async () => {
    mockGet.mockResolvedValue({ upstream: [], downstream: [] });
    await runTask(['deps', 't1']);
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('No dependencies found');
  });

  it('context fetches /tasks/:id/context and shows composite data', async () => {
    const context = {
      task: { id: 't1', title: 'Fix bug' },
      requirement: { id: 'r1', title: 'Req 1' },
      project: { id: 'p1', name: 'Project 1' },
      dependencies: { upstream: [], downstream: [] },
    };
    mockGet.mockResolvedValue(context);
    await runTask(['context', 't1']);
    expect(mockGet).toHaveBeenCalledWith('/tasks/t1/context');
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Task Context');
    expect(output).toContain('Fix bug');
  });

  it('note posts to /tasks/:id/comments', async () => {
    mockPost.mockResolvedValue({ id: 'c1' });
    await runTask(['note', 't1', '--text', 'A note']);
    expect(mockPost).toHaveBeenCalledWith('/tasks/t1/comments', { content: 'A note' });
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Note added to task t1');
  });

  it('note includes author when provided', async () => {
    mockPost.mockResolvedValue({ id: 'c1' });
    await runTask(['note', 't1', '--text', 'A note', '--author', 'Alice']);
    expect(mockPost).toHaveBeenCalledWith('/tasks/t1/comments', {
      content: 'A note',
      authorName: 'Alice',
    });
  });

  it('comment is alias for note', async () => {
    mockPost.mockResolvedValue({ id: 'c1' });
    await runTask(['comment', 't1', '--text', 'A comment']);
    expect(mockPost).toHaveBeenCalledWith('/tasks/t1/comments', { content: 'A comment' });
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Comment added to task t1');
  });

  it('progress posts progress note with prefix', async () => {
    mockPost.mockResolvedValue({ id: 'c1' });
    await runTask(['progress', 't1', '--text', '50% done']);
    expect(mockPost).toHaveBeenCalledWith('/tasks/t1/comments', {
      content: '[Progress] 50% done',
    });
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Progress reported for task t1');
  });

  it('progress includes percent when provided', async () => {
    mockPost.mockResolvedValue({ id: 'c1' });
    await runTask(['progress', 't1', '--text', 'halfway', '--percent', '50']);
    expect(mockPost).toHaveBeenCalledWith('/tasks/t1/comments', {
      content: '[Progress 50%] halfway',
    });
  });

  it('show handles 404 with proper error', async () => {
    setGlobalJson(true);
    mockGet.mockRejectedValue(new ApiError(404, { error: 'Task not found' }));
    await runTask(['show', 'missing-id'], true);
    expect(exitSpy).toHaveBeenCalledWith(CLI_EXIT_CODES.SERVER_ERROR);
    const output = JSON.parse(String(errorSpy.mock.calls[0][0]));
    expect(output.ok).toBe(false);
    expect(output.code).toBe('NOT_FOUND');
    expect(output.error).toContain('Task not found');
  });

  it('list handles network error with exit code 3', async () => {
    setGlobalJson(true);
    mockGet.mockRejectedValue(
      new Error('Cannot connect to Markus server at http://localhost:8056. Is it running? (ECONNREFUSED)'),
    );
    await runTask(['list'], true);
    expect(exitSpy).toHaveBeenCalledWith(CLI_EXIT_CODES.NETWORK_ERROR);
    const output = JSON.parse(String(errorSpy.mock.calls[0][0]));
    expect(output.ok).toBe(false);
    expect(output.code).toBe('NETWORK_ERROR');
    expect(output.error).toContain('Cannot connect');
  });
});
