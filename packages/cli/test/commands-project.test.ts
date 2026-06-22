import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerProjectCommands } from '../src/commands/project.js';
import * as apiClient from '../src/api-client.js';
import { setGlobalJson } from '../src/output.js';

describe('project command', () => {
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

  function runProject(args: string[], json = false): Promise<void> {
    const program = new Command();
    program
      .option('--json')
      .hook('preAction', (_cmd, actionCmd) => {
        if (actionCmd.optsWithGlobals().json) setGlobalJson(true);
      });
    program.exitOverride();
    registerProjectCommands(program);
    const argv = ['node', 'markus', ...(json ? ['--json'] : []), 'project', ...args];
    return program.parseAsync(argv);
  }

  it('list fetches /projects and prints table', async () => {
    mockGet.mockResolvedValue({
      projects: [{
        id: 'p1',
        name: 'Markus CLI',
        status: 'active',
        description: 'CLI tooling',
      }],
    });
    await runProject(['list']);
    expect(mockGet).toHaveBeenCalledWith('/projects');
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Projects');
    expect(output).toContain('p1');
    expect(output).toContain('Markus CLI');
    expect(output).toContain('active');
    expect(output).toContain('CLI tooling');
  });

  it('show fetches /projects/:id and prints detail', async () => {
    mockGet.mockResolvedValue({
      id: 'p1',
      name: 'Markus CLI',
      status: 'active',
      description: 'CLI tooling',
    });
    await runProject(['show', 'p1']);
    expect(mockGet).toHaveBeenCalledWith('/projects/p1');
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Project: Markus CLI');
    expect(output).toContain('active');
  });

  it('show --json outputs JSON', async () => {
    const project = { id: 'p1', name: 'Markus CLI', status: 'active' };
    mockGet.mockResolvedValue(project);
    await runProject(['show', 'p1'], true);
    const output = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(output).toEqual(project);
  });
});
