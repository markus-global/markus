import { execFile, spawn } from 'node:child_process';
import { platform } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createLogger } from '@markus/shared';

const log = createLogger('chrome-dialog-clicker');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SCRIPTS_DIR = resolve(__dirname, '../../../../scripts/markus-chrome-allow');

export interface AutoClickCheckResult {
  platform: 'darwin' | 'win32' | 'linux' | string;
  supported: boolean;
  accessibilityPermission: boolean;
  chromeRunning: boolean;
  binaryAvailable: boolean;
}

export interface AutoClickTestResult {
  checkResult: AutoClickCheckResult;
  openedAccessibilitySettings: boolean;
  clickResult: 'success' | 'no_permission' | 'chrome_not_running' | 'unsupported' | 'error';
  pageLoaded: boolean;
  pageTitle?: string;
  error?: string;
}

/**
 * Check current platform's readiness for auto-click (permissions, Chrome status).
 */
export async function checkAutoClickStatus(): Promise<AutoClickCheckResult> {
  const os = platform();
  const base: AutoClickCheckResult = {
    platform: os,
    supported: os === 'darwin' || os === 'win32',
    accessibilityPermission: false,
    chromeRunning: false,
    binaryAvailable: false,
  };

  if (os === 'darwin') {
    const bin = resolve(SCRIPTS_DIR, 'markus-chrome-allow');
    base.binaryAvailable = existsSync(bin);
    if (!base.binaryAvailable) return base;
    try {
      const result = await runHelperRaw(bin, ['--check'], 5);
      const data = JSON.parse(result);
      base.accessibilityPermission = data.accessibilityPermission === true;
      base.chromeRunning = data.chromeRunning === true;
    } catch { /* keep defaults */ }
    return base;
  }

  if (os === 'win32') {
    const script = resolve(SCRIPTS_DIR, 'markus-chrome-allow.ps1');
    base.binaryAvailable = existsSync(script);
    if (!base.binaryAvailable) return base;
    try {
      const result = await runHelperRaw(
        'powershell',
        ['-ExecutionPolicy', 'Bypass', '-File', script, '-Check'],
        5,
      );
      const data = JSON.parse(result);
      base.accessibilityPermission = data.accessibilityPermission === true;
      base.chromeRunning = data.chromeRunning === true;
    } catch { /* keep defaults */ }
    return base;
  }

  return base;
}

/**
 * Open the macOS Accessibility settings pane.
 */
export async function openAccessibilitySettings(): Promise<boolean> {
  const os = platform();
  if (os === 'darwin') {
    const bin = resolve(SCRIPTS_DIR, 'markus-chrome-allow');
    if (!existsSync(bin)) return false;
    try {
      await runHelperRaw(bin, ['--open-accessibility'], 3);
      return true;
    } catch { return false; }
  }
  return false;
}

/**
 * Run a full end-to-end test:
 * 1. Check permissions and Chrome status
 * 2. If no permission on macOS, open settings page
 * 3. Spawn a temporary chrome-devtools-mcp connection (triggers the dialog)
 * 4. Auto-click the "Allow" dialog
 * 5. Navigate to a test URL and verify page loaded
 * 6. Clean up and return results
 */
export async function testAutoClick(): Promise<AutoClickTestResult> {
  const checkResult = await checkAutoClickStatus();
  const result: AutoClickTestResult = {
    checkResult,
    openedAccessibilitySettings: false,
    clickResult: 'unsupported',
    pageLoaded: false,
  };

  if (!checkResult.supported) {
    result.clickResult = 'unsupported';
    return result;
  }

  if (!checkResult.binaryAvailable) {
    result.clickResult = 'error';
    result.error = 'Helper binary not found';
    return result;
  }

  if (platform() === 'darwin' && !checkResult.accessibilityPermission) {
    result.openedAccessibilitySettings = await openAccessibilitySettings();
    result.clickResult = 'no_permission';
    return result;
  }

  if (!checkResult.chromeRunning) {
    result.clickResult = 'chrome_not_running';
    return result;
  }

  // Spawn a temporary chrome-devtools-mcp to trigger the Allow dialog + navigate
  try {
    const { navigated, title } = await runMcpTest();
    result.pageLoaded = navigated;
    result.pageTitle = title;
    result.clickResult = 'success';
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err);
    if (msg.includes('Accessibility permission')) {
      result.clickResult = 'no_permission';
    } else {
      result.clickResult = 'error';
      result.error = msg.slice(0, 200);
    }
  }

  return result;
}

/**
 * Spawn chrome-devtools-mcp, auto-click the Allow dialog, then navigate to a page.
 * Returns whether navigation succeeded and the page title.
 */
async function runMcpTest(): Promise<{ navigated: boolean; title?: string }> {
  const npxCmd = platform() === 'win32' ? 'npx.cmd' : 'npx';

  return new Promise((resolveTest, rejectTest) => {
    const stderrChunks: string[] = [];
    const proc = spawn(npxCmd, ['-y', 'chrome-devtools-mcp@latest', '--autoConnect'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      shell: platform() === 'win32',
    });

    let stdout = '';
    let requestId = 1;
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    let cleaned = false;

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      try { proc.kill(); } catch { /* already dead */ }
    };

    const timeout = setTimeout(() => {
      cleanup();
      const stderr = stderrChunks.join('').slice(0, 300);
      rejectTest(new Error(`MCP test timed out after 60s${stderr ? ` (stderr: ${stderr})` : ''}`));
    }, 60000);

    proc.on('error', (err) => {
      clearTimeout(timeout);
      cleanup();
      rejectTest(err);
    });

    proc.stderr?.on('data', (data: Buffer) => {
      stderrChunks.push(data.toString());
    });

    proc.on('exit', (code) => {
      clearTimeout(timeout);
      if (!cleaned) {
        cleaned = true;
        const stderr = stderrChunks.join('').slice(0, 300);
        rejectTest(new Error(`MCP process exited (code ${code})${stderr ? `: ${stderr}` : ''}`));
      }
    });

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
      const lines = stdout.split('\n');
      stdout = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          if (msg.id != null && pending.has(msg.id)) {
            const p = pending.get(msg.id)!;
            pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
            else p.resolve(msg.result);
          }
        } catch { /* not JSON */ }
      }
    });

    const sendRequest = (method: string, params: unknown): Promise<unknown> => {
      const id = requestId++;
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      proc.stdin?.write(msg);
      return new Promise((res, rej) => { pending.set(id, { resolve: res, reject: rej }); });
    };

    const sendNotification = (method: string, params: unknown) => {
      const msg = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
      proc.stdin?.write(msg);
    };

    // Fire auto-clicker with generous timeout — dialog only appears after npx
    // finishes downloading and the MCP server attempts its Chrome connection.
    clickChromeAllowDialog(30).catch(() => {});

    // Run the MCP handshake + navigate sequence
    (async () => {
      try {
        await sendRequest('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'markus-test', version: '1.0.0' },
        });
        sendNotification('notifications/initialized', {});
        await sendRequest('tools/list', {});

        // open_page (new tab) triggers Chrome CDP connection → "Allow" dialog
        const navResult = await sendRequest('tools/call', {
          name: 'open_page',
          arguments: { url: 'https://example.com', background: true },
        }) as { content?: Array<{ text?: string }> };

        const text = navResult?.content?.[0]?.text ?? '';
        const navigated = !text.toLowerCase().includes('error');

        // Close the test tab to avoid leaving garbage
        const pageIdMatch = text.match(/(\d+):\s*https?:\/\/example\.com/);
        if (pageIdMatch) {
          await sendRequest('tools/call', {
            name: 'close_page',
            arguments: { pageId: Number(pageIdMatch[1]) },
          }).catch(() => {});
        }

        clearTimeout(timeout);
        cleanup();
        resolveTest({ navigated, title: navigated ? 'example.com' : undefined });
      } catch (err) {
        clearTimeout(timeout);
        cleanup();
        rejectTest(err instanceof Error ? err : new Error(String(err)));
      }
    })();
  });
}

/**
 * Auto-click Chrome's "Allow remote debugging?" dialog.
 */
export async function clickChromeAllowDialog(timeoutSec = 5): Promise<boolean> {
  const os = platform();

  if (os === 'darwin') {
    const bin = resolve(SCRIPTS_DIR, 'markus-chrome-allow');
    return runHelper(bin, ['--timeout', String(timeoutSec)], timeoutSec);
  }
  if (os === 'win32') {
    const script = resolve(SCRIPTS_DIR, 'markus-chrome-allow.ps1');
    return runHelper(
      'powershell',
      ['-ExecutionPolicy', 'Bypass', '-File', script, '-Timeout', String(timeoutSec)],
      timeoutSec,
    );
  }

  log.debug('Auto-click Chrome dialog not supported on this platform');
  return false;
}

function runHelper(cmd: string, args: string[], timeoutSec: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: (timeoutSec + 2) * 1000 }, (err, stdout) => {
      if (err) {
        log.debug('Chrome dialog clicker failed', { error: String(err) });
        resolve(false);
        return;
      }
      try {
        const r = JSON.parse(stdout);
        if (r.clicked === true) {
          log.info('Auto-clicked Chrome "Allow debugging" dialog');
        }
        resolve(r.clicked === true);
      } catch {
        resolve(false);
      }
    });
  });
}

function runHelperRaw(cmd: string, args: string[], timeoutSec: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: (timeoutSec + 2) * 1000 }, (err, stdout) => {
      if (err) { reject(err); return; }
      resolve(stdout.trim());
    });
  });
}
