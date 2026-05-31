/**
 * Cross-platform system tray controller for Markus.
 * Launches the server on start, provides "Open Console" and "Quit" controls.
 */

import { spawn, exec, execSync, type ChildProcess } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, appendFileSync, openSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { createConnection } from 'node:net';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform, homedir } from 'node:os';
import SysTrayModule from 'systray2';

const SysTray = (SysTrayModule as any).default || SysTrayModule;
type SysTrayInstance = InstanceType<typeof SysTray>;

const __dirname = dirname(fileURLToPath(import.meta.url));

const WEB_UI_PORT = 8056;
const WEB_UI_URL = `http://localhost:${WEB_UI_PORT}`;

const BIN_DIR = __dirname;
const APP_DIR = resolve(BIN_DIR, '..');
const LOG_DIR = resolve(homedir(), '.markus', 'logs');
const LOG_FILE = join(LOG_DIR, 'tray-stderr.log');

// ── i18n ──────────────────────────────────────────────────────────────────────

type Locale = 'en' | 'zh';

const STRINGS: Record<Locale, {
  openUI: string; quit: string; tooltip: string;
  portConflictTitle: string; portConflictMsg: (port: number, occupant: string) => string;
}> = {
  en: {
    openUI: 'Open Console',
    quit: 'Quit Markus',
    tooltip: 'Markus',
    portConflictTitle: 'Markus',
    portConflictMsg: (port, occupant) =>
      `Port ${port} is already in use by "${occupant}".\\nMarkus cannot start.\\n\\nFree the port or change it in ~/.markus/markus.json`,
  },
  zh: {
    openUI: '打开控制台',
    quit: '退出 Markus',
    tooltip: 'Markus',
    portConflictTitle: 'Markus',
    portConflictMsg: (port, occupant) =>
      `端口 ${port} 已被 "${occupant}" 占用。\\nMarkus 无法启动。\\n\\n请释放端口或在 ~/.markus/markus.json 中修改端口`,
  },
};

function detectLocale(): Locale {
  const lang = (process.env['LANG'] ?? process.env['LC_ALL'] ?? process.env['LANGUAGE'] ?? '').toLowerCase();
  if (lang.startsWith('zh')) return 'zh';
  if (platform() === 'darwin') {
    try {
      const appleLang = execSync('defaults read -g AppleLanguages 2>/dev/null', { encoding: 'utf-8' });
      if (/zh/.test(appleLang)) return 'zh';
    } catch { /* ignore */ }
  }
  return 'en';
}

const t = STRINGS[detectLocale()];

// ── Logging ───────────────────────────────────────────────────────────────────

function trayLog(msg: string): void {
  const ts = new Date().toISOString();
  const line = `${ts} ${msg}\n`;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, line);
  } catch { /* ignore */ }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadIconBase64(): string {
  for (const p of [resolve(APP_DIR, 'logo.png'), resolve(APP_DIR, 'markus.ico')]) {
    if (existsSync(p)) return readFileSync(p).toString('base64');
  }
  return '';
}

function openBrowser(url: string): void {
  const sys = platform();
  const cmd = sys === 'darwin' ? `open "${url}"`
    : sys === 'win32' ? `start "" "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) trayLog(`openBrowser failed: ${err.message}`);
  });
}

function isPortListening(port: number): Promise<boolean> {
  return new Promise((res) => {
    const socket = createConnection({ port, host: '127.0.0.1' }, () => { socket.destroy(); res(true); });
    socket.on('error', () => { socket.destroy(); res(false); });
    socket.setTimeout(2000, () => { socket.destroy(); res(false); });
  });
}

function checkHealthOnce(url: string): Promise<boolean> {
  return new Promise((res) => {
    const req = httpGet(url, (r) => { r.resume(); res(r.statusCode !== undefined && r.statusCode >= 200 && r.statusCode < 400); });
    req.on('error', () => res(false));
    req.setTimeout(2000, () => { req.destroy(); res(false); });
  });
}

function waitForHealth(url: string, intervalMs = 500, maxMs = 30000): Promise<boolean> {
  return new Promise((ok) => {
    const deadline = Date.now() + maxMs;
    const check = () => {
      const req = httpGet(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 400) { ok(true); return; }
        if (Date.now() >= deadline) { ok(false); return; }
        setTimeout(check, intervalMs);
      });
      req.on('error', () => { if (Date.now() >= deadline) ok(false); else setTimeout(check, intervalMs); });
      req.setTimeout(2000, () => req.destroy());
    };
    check();
  });
}

function resolveMarkusCommand(): { cmd: string; args: string[] } {
  const symlink = '/usr/local/bin/markus';
  if (existsSync(symlink)) return { cmd: symlink, args: ['start'] };
  const wrapper = resolve(APP_DIR, 'markus');
  if (existsSync(wrapper)) return { cmd: wrapper, args: ['start'] };
  const markusBin = resolve(BIN_DIR, 'Markus');
  const nodeBin = platform() === 'darwin' && existsSync(markusBin) ? markusBin : resolve(BIN_DIR, platform() === 'win32' ? 'node.exe' : 'node');
  const markusMjs = resolve(BIN_DIR, 'markus.mjs');
  return { cmd: nodeBin, args: [markusMjs, 'start'] };
}

// ── Server process management ────────────────────────────────────────────────

let serverProcess: ChildProcess | null = null;

async function ensureServerRunning(): Promise<void> {
  if (await isPortListening(WEB_UI_PORT)) {
    const isMarkus = await checkHealthOnce(`${WEB_UI_URL}/api/health`);
    if (isMarkus) {
      trayLog(`Server already running on port ${WEB_UI_PORT}`);
      openBrowser(WEB_UI_URL);
      return;
    }
    // Port occupied by a non-Markus process
    let occupant = 'unknown';
    try {
      occupant = execSync(`lsof -i :${WEB_UI_PORT} -sTCP:LISTEN -t 2>/dev/null | head -1 | xargs ps -p -o comm= 2>/dev/null`, { encoding: 'utf-8' }).trim() || 'unknown';
    } catch { /* ignore */ }
    trayLog(`Port ${WEB_UI_PORT} occupied by "${occupant}"`);
    if (platform() === 'darwin') {
      exec(`osascript -e 'display dialog "${t.portConflictMsg(WEB_UI_PORT, occupant)}" with title "${t.portConflictTitle}" buttons {"OK"} default button "OK" with icon stop'`, () => {});
    }
    return;
  }

  // Start the server
  mkdirSync(LOG_DIR, { recursive: true });
  const { cmd, args } = resolveMarkusCommand();
  trayLog(`Starting server: ${cmd} ${args.join(' ')}`);

  const outFd = openSync(join(LOG_DIR, 'stdout.log'), 'a');
  const errFd = openSync(join(LOG_DIR, 'stderr.log'), 'a');

  serverProcess = spawn(cmd, args, {
    stdio: ['ignore', outFd, errFd],
    detached: false,
    env: { ...process.env, NO_BROWSER: '1' },
  });

  serverProcess.on('exit', (code) => {
    if (code && code !== 0) trayLog(`Server exited with code ${code}`);
    serverProcess = null;
  });

  serverProcess.on('error', (err) => {
    trayLog(`Failed to spawn server: ${err.message}`);
    serverProcess = null;
  });

  const healthy = await waitForHealth(`${WEB_UI_URL}/api/health`);
  if (healthy) {
    trayLog('Server healthy — opening browser');
    openBrowser(WEB_UI_URL);
  } else {
    trayLog('Server did not become healthy within 30s');
  }
}

/** Stop all Markus server processes and prevent LaunchAgent from restarting. */
function killServer(): void {
  trayLog('Stopping server...');

  // Unload LaunchAgent first so launchd won't auto-restart the process
  if (platform() === 'darwin') {
    try {
      const uid = execSync('id -u', { encoding: 'utf-8' }).trim();
      execSync(`launchctl bootout gui/${uid}/global.markus 2>/dev/null`, { encoding: 'utf-8' });
      trayLog('LaunchAgent unloaded');
    } catch { /* not loaded or already unloaded */ }
  }

  // Kill the child process we spawned (if any)
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }

  // Also find and kill any Markus process on the port (may have been started
  // externally, by LaunchAgent, or a previous tray session)
  const killByPort = (signal: NodeJS.Signals) => {
    try {
      const pids = execSync(`lsof -i :${WEB_UI_PORT} -sTCP:LISTEN -t 2>/dev/null`, { encoding: 'utf-8' }).trim();
      if (!pids) return;
      for (const pid of pids.split('\n')) {
        const p = pid.trim();
        if (p && p !== String(process.pid)) {
          trayLog(`Sending ${signal} to server process ${p}`);
          process.kill(Number(p), signal);
        }
      }
    } catch { /* no process on port */ }
  };

  killByPort('SIGTERM');

  // Force kill after 3 seconds if still alive
  setTimeout(() => killByPort('SIGKILL'), 3000);
}

// ── Tray setup ───────────────────────────────────────────────────────────────

let tray: SysTrayInstance | null = null;

async function main() {
  trayLog(`Tray starting (locale=${detectLocale()}, pid=${process.pid})`);

  tray = new SysTray({
    menu: {
      icon: loadIconBase64(),
      title: '',
      tooltip: t.tooltip,
      items: [
        { title: t.openUI, tooltip: t.openUI, enabled: true },
        { title: '<SEPARATOR>', tooltip: '', enabled: true },
        { title: t.quit, tooltip: t.quit, enabled: true },
      ],
    },
    copyDir: false,
  });
  await tray.ready();

  tray.onClick(async (action: { item: { title: string }; seq_id: number }) => {
    const title = action.item.title;
    if (title === t.openUI) {
      openBrowser(WEB_UI_URL);
    } else if (title === t.quit) {
      trayLog('Quit requested');
      killServer();
      setTimeout(async () => {
        if (tray) await tray.kill(false);
        process.exit(0);
      }, 4000);
    }
  });

  tray.onError((err: Error) => {
    trayLog(`Tray error: ${err.message}`);
  });

  await ensureServerRunning();
}

main().catch((err) => {
  trayLog(`Tray failed to start: ${err}`);
  process.exit(1);
});
