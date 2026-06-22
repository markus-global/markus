import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { setGlobalJson } from '../src/output.js';
import { registerAgentCommands } from '../src/commands/agent.js';
import * as apiClient from '../src/api-client.js';

describe('global options', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let mockGet: ReturnType<typeof vi.fn>;
  let mockPost: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    mockGet = vi.fn();
    mockPost = vi.fn();
    vi.spyOn(apiClient, 'createClient').mockReturnValue({
      get: mockGet,
      post: mockPost,
    } as unknown as apiClient.ApiClient);
    setGlobalJson(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setGlobalJson(false);
  });

  function createProgram() {
    const program = new Command();
    program
      .option('-s, --server <url>', 'API server URL', 'http://localhost:8056')
      .option('-k, --api-key <key>', 'API key')
      .option('--json', 'JSON output')
      .option('-c, --config <path>', 'Config file')
      .hook('preAction', (_cmd, actionCmd) => {
        if (actionCmd.optsWithGlobals().json) setGlobalJson(true);
      });
    program.exitOverride();
    registerAgentCommands(program);
    return program;
  }

  it('--json flag activates JSON mode for agent list', async () => {
    mockGet.mockResolvedValue({ agents: [] });
    const program = createProgram();
    await program.parseAsync(['node', 'markus', '--json', 'agent', 'list']);
    const output = logSpy.mock.calls[0]?.[0];
    expect(output).toBeDefined();
    const parsed = JSON.parse(String(output));
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('--server option is passed to createClient', async () => {
    mockGet.mockResolvedValue({ agents: [] });
    const program = createProgram();
    await program.parseAsync(['node', 'markus', '--server', 'http://custom:9000', 'agent', 'list']);
    expect(apiClient.createClient).toHaveBeenCalledWith(
      expect.objectContaining({ server: 'http://custom:9000' }),
    );
  });

  it('default server URL is http://localhost:8056', async () => {
    mockGet.mockResolvedValue({ agents: [] });
    const program = createProgram();
    await program.parseAsync(['node', 'markus', 'agent', 'list']);
    expect(apiClient.createClient).toHaveBeenCalledWith(
      expect.objectContaining({ server: 'http://localhost:8056' }),
    );
  });

  it('--config option is available', async () => {
    mockGet.mockResolvedValue({ agents: [] });
    const program = createProgram();
    await program.parseAsync(['node', 'markus', '--config', '/tmp/custom.json', 'agent', 'list']);
    const opts = program.opts();
    expect(opts.config).toBe('/tmp/custom.json');
  });

  it('--api-key option is available', async () => {
    mockGet.mockResolvedValue({ agents: [] });
    const program = createProgram();
    await program.parseAsync(['node', 'markus', '--api-key', 'secret123', 'agent', 'list']);
    expect(apiClient.createClient).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'secret123' }),
    );
  });
});
