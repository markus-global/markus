import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerInstallAgentCommands } from '../src/commands/install-agent.js';
import * as apiClient from '../src/api-client.js';
import * as connectorService from '../src/connector-service.js';

const execSyncMock = vi.hoisted(() => vi.fn(() => Buffer.from('')));

vi.mock('node:child_process', () => ({ execSync: execSyncMock }));

describe('install agent command', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let mockPost: ReturnType<typeof vi.fn>;
  let mockGet: ReturnType<typeof vi.fn>;

  const mockConnector = {
    platform: 'openclaw',
    displayName: 'OpenClaw',
    defaultAgentName: 'OpenClaw Agent',
    defaultCapabilities: ['chat'],
    installation: {
      installCommand: 'echo install',
      initCommand: 'echo init',
      startCommand: 'openclaw start',
    },
    integration: { configPath: '~/.openclaw/openclaw.json' },
  };

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockPost = vi.fn();
    mockGet = vi.fn();
    execSyncMock.mockClear();

    vi.spyOn(apiClient, 'createClient').mockReturnValue({
      get: mockGet,
      post: mockPost,
    } as unknown as apiClient.ApiClient);

    vi.spyOn(connectorService, 'findConnector').mockImplementation((platform) =>
      platform === 'openclaw' ? (mockConnector as never) : undefined,
    );
    vi.spyOn(connectorService, 'loadConnectors').mockReturnValue([mockConnector as never]);
    vi.spyOn(connectorService, 'scanInstalledPlatforms').mockReturnValue([
      { platform: 'openclaw', displayName: 'OpenClaw', installed: true, binaryFound: true, running: false },
    ]);
    vi.spyOn(connectorService, 'writePlatformConfig').mockReturnValue(true);
    vi.spyOn(connectorService, 'installSkillTemplate').mockReturnValue(true);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    vi.restoreAllMocks();
  });

  function runInstall(args: string[]): Promise<void> {
    const program = new Command();
    program.exitOverride();
    registerInstallAgentCommands(program);
    return program.parseAsync(['node', 'markus', 'install', ...args]);
  }

  it('fails for unknown platform', async () => {
    vi.spyOn(connectorService, 'findConnector').mockReturnValue(undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    await runInstall(['unknown-platform']).catch(() => {});
    const output = [
      ...logSpy.mock.calls.map(c => String(c[0])),
      ...errorSpy.mock.calls.map(c => String(c[0])),
    ].join('\n');
    expect(output).toContain('Unknown platform');
    exitSpy.mockRestore();
  });

  it('skip-connect completes without API calls', async () => {
    await runInstall(['openclaw', '--skip-connect']);
    expect(mockPost).not.toHaveBeenCalled();
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Connection skipped');
    expect(output).toContain('installed');
  });

  it('registers agent and writes config on success', async () => {
    mockPost.mockImplementation(async (path: string) => {
      if (path === '/gateway/register') return { markusAgentId: 'markus-123' };
      if (path === '/gateway/auth') return { token: 'tok_abc' };
      return {};
    });
    mockGet.mockResolvedValue({ orgSecretFull: 'secret123' });

    await runInstall(['openclaw', '--skip-install', '--skip-init']);
    expect(mockPost).toHaveBeenCalledWith(
      '/gateway/register',
      expect.objectContaining({ platform: 'openclaw', orgId: 'default' }),
    );
    expect(connectorService.writePlatformConfig).toHaveBeenCalled();
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Complete');
  });

  it('handles API connection failure gracefully', async () => {
    mockPost.mockRejectedValue(new apiClient.ApiError('Server unavailable', 503));
    await runInstall(['openclaw', '--skip-install', '--skip-init']);
    expect(errorSpy).toHaveBeenCalled();
    const output = [
      ...logSpy.mock.calls.map(c => String(c[0])),
      ...errorSpy.mock.calls.map(c => String(c[0])),
    ].join('\n');
    expect(output).toContain('Connection failed');
  });

  it('continues when init command fails', async () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (String(cmd).includes('init')) throw new Error('init failed');
      return Buffer.from('');
    });
    mockPost.mockResolvedValue({ markusAgentId: 'markus-123' });
    mockGet.mockResolvedValue({ orgSecretFull: 'secret123' });

    await runInstall(['openclaw', '--skip-install']);
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/Warning: init command failed|Complete/i);
  });

  it('reports already installed when platform is detected', async () => {
    vi.spyOn(connectorService, 'scanInstalledPlatforms').mockReturnValue([
      {
        platform: 'openclaw',
        displayName: 'OpenClaw',
        installed: true,
        binaryFound: true,
        running: false,
        configPath: '/tmp/openclaw.json',
      },
    ]);

    await runInstall(['openclaw', '--skip-connect']);
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('already installed');
  });
});
