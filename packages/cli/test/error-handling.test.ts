import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerAgentCommands } from '../src/commands/agent.js';
import * as apiClient from '../src/api-client.js';
import { ApiError } from '../src/api-client.js';
import { setGlobalJson } from '../src/output.js';
import { CLI_EXIT_CODES } from '@markus/shared';

describe('command error handling', () => {
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

  function runAgent(args: string[], json = false): Promise<void> {
    const program = new Command();
    program
      .option('--json')
      .hook('preAction', (_cmd, actionCmd) => {
        if (actionCmd.optsWithGlobals().json) setGlobalJson(true);
      });
    program.exitOverride();
    registerAgentCommands(program);
    const argv = ['node', 'markus', ...(json ? ['--json'] : []), 'agent', ...args];
    return program.parseAsync(argv);
  }

  it('agent list handles API errors gracefully with exit code 2', async () => {
    setGlobalJson(true);
    mockGet.mockRejectedValue(new ApiError(500, { error: 'Internal server error' }));

    await runAgent(['list'], true);

    expect(exitSpy).toHaveBeenCalledWith(CLI_EXIT_CODES.SERVER_ERROR);
    const output = JSON.parse(String(errorSpy.mock.calls[0][0]));
    expect(output).toEqual({
      ok: false,
      error: expect.stringContaining('API 500'),
      code: 'API_500',
    });
  });

  it('agent get handles 404 with proper exit code', async () => {
    setGlobalJson(true);
    mockGet.mockRejectedValue(new ApiError(404, { error: 'Agent not found' }));

    await runAgent(['get', 'missing-id'], true);

    expect(exitSpy).toHaveBeenCalledWith(CLI_EXIT_CODES.SERVER_ERROR);
    const output = JSON.parse(String(errorSpy.mock.calls[0][0]));
    expect(output.ok).toBe(false);
    expect(output.code).toBe('NOT_FOUND');
    expect(output.error).toContain('Agent not found');
  });

  it('network errors produce exit code 3', async () => {
    setGlobalJson(true);
    mockGet.mockRejectedValue(
      new Error('Cannot connect to Markus server at http://localhost:8056. Is it running? (ECONNREFUSED)'),
    );

    await runAgent(['list'], true);

    expect(exitSpy).toHaveBeenCalledWith(CLI_EXIT_CODES.NETWORK_ERROR);
    const output = JSON.parse(String(errorSpy.mock.calls[0][0]));
    expect(output.ok).toBe(false);
    expect(output.code).toBe('NETWORK_ERROR');
    expect(output.error).toContain('Cannot connect');
  });
});
