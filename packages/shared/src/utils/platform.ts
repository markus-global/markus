import { platform } from 'node:os';
import { execFileSync, execSync } from 'node:child_process';

const _isWin = platform() === 'win32';

export function isWindows(): boolean {
  return _isWin;
}

/**
 * Cross-platform binary lookup. Uses `where` on Windows, `which` on Unix.
 * Returns the resolved absolute path or null if not found.
 */
export function resolveWhich(name: string): string | null {
  try {
    const cmd = _isWin ? `where ${name}` : `which ${name}`;
    const out = execSync(cmd, { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    // `where` on Windows may return multiple lines; take the first
    return out.split(/\r?\n/)[0]?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Cross-platform safe execution of a command with argument array.
 * Avoids shell-string issues like `2>&1 ||` that break on Windows cmd.exe.
 * Uses `shell: true` on Windows so `.cmd` shims resolve correctly.
 */
export function execSafeSync(
  command: string,
  args: string[],
  opts?: { timeout?: number; cwd?: string; env?: NodeJS.ProcessEnv },
): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync(command, args, {
      encoding: 'utf-8',
      timeout: opts?.timeout ?? 10_000,
      cwd: opts?.cwd,
      env: opts?.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: _isWin,
    });
    return { stdout: stdout.trim(), exitCode: 0 };
  } catch (err: any) {
    const stdout = (typeof err?.stdout === 'string' ? err.stdout : '').trim();
    const exitCode = typeof err?.status === 'number' ? err.status : 1;
    return { stdout, exitCode };
  }
}

/**
 * Resolve the binary path for a coding tool. Prefers user-configured `binaryPath`,
 * falls back to PATH resolution via `resolveWhich`.
 */
export function resolveBinary(binaryName: string, binaryPath?: string): string | null {
  if (binaryPath) return binaryPath;
  return resolveWhich(binaryName);
}
