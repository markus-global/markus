import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as child_process from 'node:child_process';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, platform: vi.fn(() => 'darwin') };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof child_process>();
  return {
    ...actual,
    execSync: vi.fn(),
    execFileSync: vi.fn(),
  };
});

describe('platform utilities', () => {
  const mockedPlatform = vi.mocked(os.platform);
  const mockedExecSync = vi.mocked(child_process.execSync);
  const mockedExecFileSync = vi.mocked(child_process.execFileSync);

  beforeEach(() => {
    vi.resetModules();
    mockedPlatform.mockReturnValue('darwin');
    mockedExecSync.mockReset();
    mockedExecFileSync.mockReset();
  });

  describe('resolveWhich', () => {
    it('uses `which` on macOS/Linux and returns the path', async () => {
      mockedPlatform.mockReturnValue('darwin');
      mockedExecSync.mockReturnValue('/usr/local/bin/claude\n' as any);

      const { resolveWhich } = await import('../src/utils/platform.js');
      const result = resolveWhich('claude');

      expect(mockedExecSync).toHaveBeenCalledWith(
        'which claude',
        expect.objectContaining({ encoding: 'utf-8', timeout: 5000 }),
      );
      expect(result).toBe('/usr/local/bin/claude');
    });

    it('uses `where` on Windows and takes the first line', async () => {
      mockedPlatform.mockReturnValue('win32');
      mockedExecSync.mockReturnValue('C:\\Users\\user\\AppData\\Local\\Programs\\claude\\claude.cmd\r\nC:\\Program Files\\claude\\claude.cmd\r\n' as any);

      const { resolveWhich } = await import('../src/utils/platform.js');
      const result = resolveWhich('claude');

      expect(mockedExecSync).toHaveBeenCalledWith(
        'where claude',
        expect.objectContaining({ encoding: 'utf-8' }),
      );
      expect(result).toBe('C:\\Users\\user\\AppData\\Local\\Programs\\claude\\claude.cmd');
    });

    it('returns null when binary is not found', async () => {
      mockedExecSync.mockImplementation(() => { throw new Error('not found'); });

      const { resolveWhich } = await import('../src/utils/platform.js');
      expect(resolveWhich('nonexistent')).toBeNull();
    });
  });

  describe('execSafeSync', () => {
    it('returns stdout and exitCode 0 on success', async () => {
      mockedExecFileSync.mockReturnValue('1.2.3\n' as any);

      const { execSafeSync } = await import('../src/utils/platform.js');
      const result = execSafeSync('/usr/local/bin/claude', ['--version']);

      expect(result).toEqual({ stdout: '1.2.3', exitCode: 0 });
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        ['--version'],
        expect.objectContaining({
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
      );
    });

    it('returns captured stdout and exit code on failure', async () => {
      const err = Object.assign(new Error('fail'), { stdout: 'partial output\n', status: 2 });
      mockedExecFileSync.mockImplementation(() => { throw err; });

      const { execSafeSync } = await import('../src/utils/platform.js');
      const result = execSafeSync('/usr/local/bin/claude', ['api-key-status']);

      expect(result).toEqual({ stdout: 'partial output', exitCode: 2 });
    });

    it('returns empty stdout and exitCode 1 when error has no stdout', async () => {
      mockedExecFileSync.mockImplementation(() => { throw new Error('command not found'); });

      const { execSafeSync } = await import('../src/utils/platform.js');
      const result = execSafeSync('/usr/local/bin/nonexistent', ['--version']);

      expect(result).toEqual({ stdout: '', exitCode: 1 });
    });

    it('passes custom cwd and timeout', async () => {
      mockedExecFileSync.mockReturnValue('ok' as any);

      const { execSafeSync } = await import('../src/utils/platform.js');
      execSafeSync('git', ['status'], { cwd: '/tmp/repo', timeout: 3000 });

      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'git',
        ['status'],
        expect.objectContaining({ cwd: '/tmp/repo', timeout: 3000 }),
      );
    });
  });

  describe('resolveBinary', () => {
    it('returns binaryPath if provided', async () => {
      const { resolveBinary } = await import('../src/utils/platform.js');
      expect(resolveBinary('claude', '/custom/path/claude')).toBe('/custom/path/claude');
    });

    it('falls back to resolveWhich when no binaryPath', async () => {
      mockedExecSync.mockReturnValue('/usr/local/bin/claude\n' as any);

      const { resolveBinary } = await import('../src/utils/platform.js');
      expect(resolveBinary('claude')).toBe('/usr/local/bin/claude');
    });

    it('returns null when binary is not found and no binaryPath', async () => {
      mockedExecSync.mockImplementation(() => { throw new Error('not found'); });

      const { resolveBinary } = await import('../src/utils/platform.js');
      expect(resolveBinary('nonexistent')).toBeNull();
    });
  });

  describe('isWindows', () => {
    it('returns false on macOS', async () => {
      mockedPlatform.mockReturnValue('darwin');
      const { isWindows } = await import('../src/utils/platform.js');
      expect(isWindows()).toBe(false);
    });

    it('returns false on Linux', async () => {
      mockedPlatform.mockReturnValue('linux');
      const { isWindows } = await import('../src/utils/platform.js');
      expect(isWindows()).toBe(false);
    });

    it('returns true on Windows', async () => {
      mockedPlatform.mockReturnValue('win32');
      const { isWindows } = await import('../src/utils/platform.js');
      expect(isWindows()).toBe(true);
    });
  });
});
