import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('cli index entry', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  const originalArgv = process.argv;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    logSpy.mockRestore();
    exitSpy.mockRestore();
    process.argv = originalArgv;
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('handles -v flag with update check before exiting', async () => {
    process.argv = ['node', 'markus', '-v'];
    const shared = await import('@markus/shared');
    vi.spyOn(shared, 'checkForUpdate').mockResolvedValue({
      currentVersion: '1.0.0',
      latestVersion: '1.1.0',
      updateAvailable: true,
    });

    await import('../src/index.js');
    await new Promise(r => setTimeout(r, 100));

    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toMatch(/v0\.8\.3|Update available/);
    expect(output).toMatch(/1\.1\.0/);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('loads .env variables from project root when present', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const tmp = mkdtempSync(join(tmpdir(), 'markus-index-env-'));
    const originalCwd = process.cwd();
    const envKey = `MARKUS_CLI_TEST_${Date.now()}`;
    delete process.env[envKey];

    try {
      process.chdir(tmp);
      writeFileSync(join(tmp, '.env'), `${envKey}=loaded-from-dotenv\n`);
      process.argv = ['node', 'markus', '-v'];
      const shared = await import('@markus/shared');
      vi.spyOn(shared, 'checkForUpdate').mockResolvedValue({
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
        updateAvailable: false,
      });

      vi.resetModules();
      await import('../src/index.js');
      await new Promise(r => setTimeout(r, 50));

      expect(process.env[envKey]).toBe('loaded-from-dotenv');
    } finally {
      process.chdir(originalCwd);
      rmSync(tmp, { recursive: true, force: true });
      delete process.env[envKey];
    }
  });
});
