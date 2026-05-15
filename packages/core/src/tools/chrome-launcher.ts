import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { execSync } from 'node:child_process';
import { createLogger } from '@markus/shared';

const log = createLogger('chrome-launcher');

export interface ChromeLauncherOptions {
  port?: number;
  userDataDir?: string;
  chromePath?: string;
}

export class ChromeLauncher {
  private port: number;
  private userDataDir: string;
  private chromePath: string | null;
  private process: ChildProcess | null = null;

  constructor(options: ChromeLauncherOptions = {}) {
    this.port = options.port ?? 9222;
    this.userDataDir = options.userDataDir ?? join(homedir(), '.markus', 'chrome-profile');
    this.chromePath = options.chromePath ?? null;
  }

  async launch(): Promise<{ port: number } | { error: string }> {
    if (await this.isRunning()) {
      log.info('Chrome debugging instance already running', { port: this.port });
      return { port: this.port };
    }

    const chromePath = this.chromePath ?? detectChromePath();
    if (!chromePath) {
      return { error: 'Chrome not found. Please install Google Chrome for browser automation.' };
    }

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
    ];

    try {
      this.process = spawn(chromePath, args, {
        stdio: 'ignore',
        detached: true,
      });

      this.process.unref();

      this.process.on('error', (err) => {
        log.error('Chrome process error', { error: String(err) });
        this.process = null;
      });

      this.process.on('exit', (code) => {
        log.info('Chrome process exited', { code });
        this.process = null;
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
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/json/version`, {
        signal: AbortSignal.timeout(2000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async shutdown(): Promise<void> {
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

