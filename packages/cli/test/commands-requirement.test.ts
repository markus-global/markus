import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerRequirementCommands } from '../src/commands/requirement.js';
import * as apiClient from '../src/api-client.js';
import { setGlobalJson } from '../src/output.js';

describe('requirement command', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let mockGet: ReturnType<typeof vi.fn>;
  let mockPost: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
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
    setGlobalJson(false);
    vi.restoreAllMocks();
  });

  function runRequirement(args: string[], json = false): Promise<void> {
    const program = new Command();
    program
      .option('--json')
      .hook('preAction', (_cmd, actionCmd) => {
        if (actionCmd.optsWithGlobals().json) setGlobalJson(true);
      });
    program.exitOverride();
    registerRequirementCommands(program);
    const argv = ['node', 'markus', ...(json ? ['--json'] : []), 'requirement', ...args];
    return program.parseAsync(argv);
  }

  it('list fetches /requirements and prints table', async () => {
    mockGet.mockResolvedValue({
      requirements: [{
        id: 'r1',
        title: 'User auth',
        status: 'approved',
        priority: 'high',
        source: 'user',
      }],
    });
    await runRequirement(['list']);
    expect(mockGet).toHaveBeenCalledWith('/requirements', expect.objectContaining({}));
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Requirements');
    expect(output).toContain('r1');
    expect(output).toContain('User auth');
    expect(output).toContain('approved');
    expect(output).toContain('user');
  });

  it('list --status approved passes query param', async () => {
    mockGet.mockResolvedValue({ requirements: [] });
    await runRequirement(['list', '--status', 'approved']);
    expect(mockGet).toHaveBeenCalledWith('/requirements', expect.objectContaining({
      status: 'approved',
    }));
  });

  it('show fetches /requirements/:id and prints detail', async () => {
    mockGet.mockResolvedValue({
      id: 'r1',
      title: 'User auth',
      status: 'approved',
      priority: 'high',
    });
    await runRequirement(['show', 'r1']);
    expect(mockGet).toHaveBeenCalledWith('/requirements/r1');
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Requirement: User auth');
    expect(output).toContain('approved');
  });

  it('show --json outputs JSON', async () => {
    const req = { id: 'r1', title: 'User auth', status: 'approved' };
    mockGet.mockResolvedValue(req);
    await runRequirement(['show', 'r1'], true);
    const output = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(output).toEqual(req);
  });

  it('req alias works for list', async () => {
    mockGet.mockResolvedValue({ requirements: [] });
    const program = new Command();
    program
      .option('--json')
      .hook('preAction', (_cmd, actionCmd) => {
        if (actionCmd.optsWithGlobals().json) setGlobalJson(true);
      });
    program.exitOverride();
    registerRequirementCommands(program);
    await program.parseAsync(['node', 'markus', 'req', 'list']);
    expect(mockGet).toHaveBeenCalledWith('/requirements', expect.any(Object));
  });
});
