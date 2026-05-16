import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { createLogger } from '@markus/shared';

const log = createLogger('chrome-launcher');

const SINGLETON_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];

export interface ChromeLauncherOptions {
  port?: number;
  userDataDir?: string;
  chromePath?: string;
}

export type ChromeExitCallback = () => void;

export class ChromeLauncher {
  private port: number;
  private userDataDir: string;
  private chromePath: string | null;
  private process: ChildProcess | null = null;
  private onEarlyExit: ChromeExitCallback | null = null;
  private launchedAt = 0;

  constructor(options: ChromeLauncherOptions = {}) {
    this.port = options.port ?? 9222;
    this.userDataDir = options.userDataDir ?? join(homedir(), '.markus', 'chrome-profile');
    this.chromePath = options.chromePath ?? null;
  }

  /**
   * Register a callback invoked if Chrome exits unexpectedly within 30s of launch.
   * Use this to fall back to the system browser.
   */
  onUnexpectedExit(cb: ChromeExitCallback): void {
    this.onEarlyExit = cb;
  }

  async launch(initialUrl?: string): Promise<{ port: number } | { error: string }> {
    const existingOwner = await this.identifyRunningInstance();
    if (existingOwner === 'ours') {
      log.info('Chrome debugging instance already running (ours)', { port: this.port });
      if (initialUrl) {
        await this.openUrl(initialUrl);
      }
      return { port: this.port };
    }
    if (existingOwner === 'foreign') {
      log.warn('Port is occupied by another Chrome process, killing it', { port: this.port });
      this.killProcessOnPort();
      await new Promise(r => setTimeout(r, 1000));
    }

    const chromePath = this.chromePath ?? detectChromePath();
    if (!chromePath) {
      return { error: 'Chrome not found. Please install Google Chrome for browser automation.' };
    }

    this.cleanStaleLocks();

    const args = [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-default-apps',
      '--disable-popup-blocking',
      '--disable-translate',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-device-discovery-notifications',
      '--disable-sync',
      '--disable-background-networking',
      initialUrl ?? 'about:blank',
    ];

    try {
      this.process = spawn(chromePath, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        detached: true,
      });

      this.process.unref();
      this.launchedAt = Date.now();

      if (this.process.stderr) {
        let stderrBuf = '';
        this.process.stderr.on('data', (chunk: Buffer) => {
          stderrBuf += chunk.toString();
          if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-2048);
        });
        this.process.on('exit', () => {
          if (stderrBuf.trim()) log.warn('Chrome stderr output', { stderr: stderrBuf.trim().slice(0, 500) });
        });
      }

      this.process.on('error', (err) => {
        log.error('Chrome process error', { error: String(err) });
        this.process = null;
      });

      this.process.on('exit', (code) => {
        const uptime = Date.now() - this.launchedAt;
        log.info('Chrome process exited', { code, uptimeMs: uptime });
        this.process = null;
        if (uptime < 30_000 && this.onEarlyExit) {
          log.warn('Chrome exited early, triggering fallback');
          this.onEarlyExit();
        }
      });

      const ready = await this.waitForPort(15_000);
      if (!ready) {
        this.shutdown();
        return { error: `Chrome started but debugging port ${this.port} not ready within 15s` };
      }

      log.info('Chrome debugging instance launched', { port: this.port, path: chromePath });
      return { port: this.port };
    } catch (err) {
      return { error: `Failed to launch Chrome: ${String(err)}` };
    }
  }

  async isRunning(): Promise<boolean> {
    return (await this.cdpHost()) !== null;
  }

  /**
   * Find which host (IPv4 or IPv6) the CDP endpoint is reachable on.
   * Chrome may bind to 127.0.0.1 or [::1] depending on what's available.
   */
  private async cdpHost(): Promise<string | null> {
    for (const host of ['127.0.0.1', '[::1]']) {
      try {
        const res = await fetch(`http://${host}:${this.port}/json/version`, {
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) return host;
      } catch { /* try next */ }
    }
    return null;
  }

  /**
   * Check if the Chrome instance on our port belongs to us (same user-data-dir)
   * or is a foreign process (user's own Chrome, stale from previous run, etc.)
   */
  private async identifyRunningInstance(): Promise<'ours' | 'foreign' | 'none'> {
    const host = await this.cdpHost();
    if (!host) return 'none';
    try {
      const res = await fetch(`http://${host}:${this.port}/json/version`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return 'none';
      const info = await res.json() as Record<string, string>;
      const wsUrl = info['webSocketDebuggerUrl'] ?? '';
      if (this.process) return 'ours';
      if (wsUrl) {
        log.info('Found existing Chrome on debugging port', { wsUrl: wsUrl.slice(0, 80) });
      }
      return 'foreign';
    } catch {
      return 'none';
    }
  }

  /**
   * Kill whatever process is listening on our debugging port.
   */
  private killProcessOnPort(): void {
    try {
      if (platform() === 'win32') {
        execSync(`for /f "tokens=5" %a in ('netstat -aon ^| findstr :${this.port}') do taskkill /F /PID %a`, { stdio: 'ignore' });
      } else {
        const pid = execSync(`lsof -ti tcp:${this.port}`, { encoding: 'utf-8' }).trim();
        if (pid) {
          for (const p of pid.split('\n')) {
            try { process.kill(Number(p), 'SIGTERM'); } catch { /* already dead */ }
          }
          log.info('Killed process occupying debugging port', { port: this.port, pid });
        }
      }
    } catch { /* best-effort */ }
  }

  async shutdown(): Promise<void> {
    this.onEarlyExit = null;
    if (this.process) {
      try {
        this.process.kill();
      } catch { /* already dead */ }
      this.process = null;
      log.info('Chrome debugging instance shut down');
    }
  }

  getPort(): number {
    return this.port;
  }

  /**
   * Open a URL in this dedicated Chrome instance via CDP.
   * Falls back silently if the instance isn't running.
   */
  async openUrl(url: string): Promise<boolean> {
    const host = await this.cdpHost();
    if (!host) {
      log.warn('Cannot reach Chrome CDP to open URL (no host found)');
      return false;
    }
    try {
      const res = await fetch(`http://${host}:${this.port}/json/new?${url}`, {
        method: 'PUT',
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        log.info('Opened URL in dedicated Chrome instance', { url });
        return true;
      }
      log.warn('Failed to open URL in Chrome via CDP', { status: res.status });
      return false;
    } catch (err) {
      log.warn('Cannot reach Chrome CDP to open URL', { error: String(err) });
      return false;
    }
  }

  /**
   * Remove stale Chrome singleton files from the user-data-dir.
   * These lock files are left behind when Chrome doesn't shut down cleanly.
   * If not cleaned, a new Chrome process may detect them, delegate to
   * an "existing" instance (or the user's own Chrome on macOS), then exit.
   */
  private cleanStaleLocks(): void {
    mkdirSync(this.userDataDir, { recursive: true });
    for (const name of SINGLETON_FILES) {
      const p = join(this.userDataDir, name);
      try {
        if (existsSync(p)) {
          unlinkSync(p);
          log.info('Removed stale Chrome lock file', { file: name });
        }
      } catch { /* best-effort */ }
    }
  }

  private async waitForPort(timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.isRunning()) return true;
      await new Promise(r => setTimeout(r, 500));
    }
    return false;
  }
}

/**
 * Detect Chrome installation path across platforms.
 */
export function detectChromePath(): string | null {
  const p = platform();

  if (p === 'darwin') {
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
    for (const path of candidates) {
      if (existsSync(path)) return path;
    }
  } else if (p === 'linux') {
    const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
    for (const name of names) {
      try {
        const path = execSync(`which ${name}`, { encoding: 'utf-8' }).trim();
        if (path) return path;
      } catch { /* not found */ }
    }
  } else if (p === 'win32') {
    const candidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      `${process.env['LOCALAPPDATA'] ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
    ];
    for (const path of candidates) {
      if (existsSync(path)) return path;
    }
  }

  return null;
}

/**
 * Check if Chrome is installed (for API/onboarding checks).
 */
export function isChromeInstalled(): { installed: boolean; path?: string } {
  const path = detectChromePath();
  return path ? { installed: true, path } : { installed: false };
}

