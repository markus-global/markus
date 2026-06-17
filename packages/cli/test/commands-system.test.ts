import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';
import { registerSystemCommands } from '../src/commands/system.js';
import * as apiClient from '../src/api-client.js';
import * as shared from '@markus/shared';

describe('system command', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let mockGet: ReturnType<typeof vi.fn>;
  let mockPost: ReturnType<typeof vi.fn>;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'markus-system-cmd-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockGet = vi.fn();
    mockPost = vi.fn();
    vi.spyOn(apiClient, 'createClient').mockReturnValue({
      get: mockGet,
      post: mockPost,
    } as unknown as apiClient.ApiClient);

    vi.spyOn(shared, 'checkForUpdate').mockResolvedValue({
      currentVersion: '0.8.3',
      latestVersion: '0.8.3',
      updateAvailable: false,
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function runSystem(args: string[]): Promise<void> {
    const program = new Command();
    program.exitOverride();
    registerSystemCommands(program);
    return program.parseAsync(['node', 'markus', 'system', ...args]);
  }

  it('status fetches system status and health', async () => {
    mockGet.mockImplementation(async (path: string) => {
      if (path === '/system/status') return { uptime: 100 };
      if (path === '/health') return { ok: true };
      return {};
    });
    await runSystem(['status']);
    expect(mockGet).toHaveBeenCalledWith('/system/status');
    expect(mockGet).toHaveBeenCalledWith('/health');
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('System status');
  });

  it('status outputs JSON when --json global option set', async () => {
    mockGet.mockImplementation(async (path: string) => {
      if (path === '/system/status') return { uptime: 50 };
      return { ok: true };
    });
    const program = new Command();
    program.option('--json');
    program.exitOverride();
    registerSystemCommands(program);
    await program.parseAsync(['node', 'markus', '--json', 'system', 'status']);
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    const parsed = JSON.parse(output);
    expect(parsed.status.uptime).toBe(50);
    expect(parsed.health.ok).toBe(true);
  });

  it('emergency-stop posts to API', async () => {
    mockPost.mockResolvedValue({ stopped: 3 });
    await runSystem(['emergency-stop']);
    expect(mockPost).toHaveBeenCalledWith('/system/emergency-stop');
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Emergency stop');
  });

  it('version shows version info', async () => {
    await runSystem(['version']);
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Markus Version');
    expect(output).toContain('0.8.3');
  });

  it('update prints git pull steps in dry-run mode', async () => {
    await runSystem(['update', '--dry-run']);
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('DRY RUN');
    expect(output).toContain('git pull');
    expect(output).toContain('pnpm install');
    expect(output).toContain('pnpm build');
  });

  it('version reports npm update when newer version available', async () => {
    vi.spyOn(shared, 'checkForUpdate').mockResolvedValue({
      currentVersion: '0.8.3',
      latestVersion: '0.9.0',
      updateAvailable: true,
    });
    await runSystem(['version']);
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('0.9.0');
    expect(output).toMatch(/New version available|upgrade/i);
  }, 30000);
});
