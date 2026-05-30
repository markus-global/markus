/**
 * Cross-platform system tray controller for Markus.
 * Provides start/stop controls and quick access to the Web UI.
 */

import { spawn, exec, execSync, type ChildProcess } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
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

// Resolve the markus command: prefer the symlink in /usr/local/bin,
// then fall back to the bundled wrapper script, then to direct node invocation.
function resolveMarkusCommand(): { cmd: string; args: string[] } {
  const symlink = '/usr/local/bin/markus';
  if (existsSync(symlink)) {
    return { cmd: symlink, args: ['start'] };
  }
  const wrapper = resolve(APP_DIR, 'markus');
  if (existsSync(wrapper)) {
    return { cmd: wrapper, args: ['start'] };
  }
  const nodeBin = resolve(BIN_DIR, platform() === 'win32' ? 'node.exe' : 'node');
  const markusMjs = resolve(BIN_DIR, 'markus.mjs');
  return { cmd: nodeBin, args: [markusMjs, 'start'] };
}

// ── i18n ──────────────────────────────────────────────────────────────────────

type Locale = 'en' | 'zh';

const STRINGS: Record<Locale, {
  openUI: string; startServer: string; stopServer: string; quit: string;
  tooltipRunning: string; tooltipStopped: string;
  portConflictTitle: string; portConflictMsg: (port: number, occupant: string) => string;
}> = {
  en: {
    openUI: 'Open Web UI',
    startServer: 'Start Server',
    stopServer: 'Stop Server',
    quit: 'Quit Markus',
    tooltipRunning: 'Markus (running)',
    tooltipStopped: 'Markus (stopped)',
    portConflictTitle: 'Markus',
    portConflictMsg: (port, occupant) =>
      `Port ${port} is already in use by "${occupant}".\\nMarkus cannot start.\\n\\nFree the port or change it in ~/.markus/markus.json`,
  },
  zh: {
    openUI: '打开控制台',
    startServer: '启动服务',
    stopServer: '停止服务',
    quit: '退出 Markus',
    tooltipRunning: 'Markus (运行中)',
    tooltipStopped: 'Markus (已停止)',
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
  console.error(line.trimEnd());
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
  exec(cmd, () => {});
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

// ── Server process management ────────────────────────────────────────────────

let serverProcess: ChildProcess | null = null;
let serverRunning = false;

async function startServer(): Promise<void> {
  if (serverRunning) return;

  if (await isPortListening(WEB_UI_PORT)) {
    const isMarkus = await checkHealthOnce(`${WEB_UI_URL}/api/health`);
    if (isMarkus) {
      trayLog(`Port ${WEB_UI_PORT} is Markus — opening browser`);
      serverRunning = true;
      updateTrayMenu();
      openBrowser(WEB_UI_URL);
      return;
    }
    // Port occupied by something else
    let occupant = 'unknown';
    try {
      occupant = execSync(`lsof -i :${WEB_UI_PORT} -sTCP:LISTEN -t 2>/dev/null | head -1 | xargs ps -p -o comm= 2>/dev/null`, { encoding: 'utf-8' }).trim() || 'unknown';
    } catch { /* ignore */ }
    trayLog(`Port ${WEB_UI_PORT} occupied by "${occupant}" — showing conflict dialog`);
    if (platform() === 'darwin') {
      exec(`osascript -e 'display dialog "${t.portConflictMsg(WEB_UI_PORT, occupant)}" with title "${t.portConflictTitle}" buttons {"OK"} default button "OK" with icon stop'`, () => {});
    }
    return;
  }

  mkdirSync(LOG_DIR, { recursive: true });

  const { cmd, args } = resolveMarkusCommand();
  trayLog(`Starting server: ${cmd} ${args.join(' ')}`);

  const stdoutLog = join(LOG_DIR, 'stdout.log');
  const stderrLog = join(LOG_DIR, 'stderr.log');
  const { openSync } = await import('node:fs');
  const outFd = openSync(stdoutLog, 'a');
  const errFd = openSync(stderrLog, 'a');

  serverProcess = spawn(cmd, args, {
    stdio: ['ignore', outFd, errFd],
    detached: false,
    env: { ...process.env, NO_BROWSER: '1' },
  });

  serverRunning = true;
  updateTrayMenu();

  serverProcess.on('exit', (code) => {
    serverRunning = false;
    serverProcess = null;
    updateTrayMenu();
    if (code && code !== 0) {
      trayLog(`Server exited with code ${code} — check ${stderrLog}`);
    }
  });

  serverProcess.on('error', (err) => {
    serverRunning = false;
    serverProcess = null;
    updateTrayMenu();
    trayLog(`Failed to spawn server: ${err.message}`);
  });

  waitForHealth(`${WEB_UI_URL}/api/health`).then((ok) => {
    if (ok && serverRunning) {
      trayLog('Server healthy — opening browser');
      openBrowser(WEB_UI_URL);
    } else if (!ok) {
      trayLog(`Server did not become healthy within 30s — check ${stderrLog}`);
    }
  });
}

function stopServer(): void {
  if (!serverProcess) return;
  trayLog('Stopping server...');
  serverProcess.kill('SIGTERM');
  const forceTimer = setTimeout(() => {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGKILL');
    }
  }, 5000);
  serverProcess.on('exit', () => clearTimeout(forceTimer));
}

// ── Tray setup ───────────────────────────────────────────────────────────────

const SEPARATOR = { title: '<SEPARATOR>', tooltip: '', enabled: true };

let tray: SysTrayInstance | null = null;

function buildMenu() {
  return {
    icon: loadIconBase64(),
    title: '',
    tooltip: serverRunning ? t.tooltipRunning : t.tooltipStopped,
    items: [
      { title: t.openUI, tooltip: t.openUI, enabled: serverRunning },
      SEPARATOR,
      { title: t.startServer, tooltip: t.startServer, enabled: !serverRunning },
      { title: t.stopServer, tooltip: t.stopServer, enabled: serverRunning },
      SEPARATOR,
      { title: t.quit, tooltip: t.quit, enabled: true },
    ],
  };
}

function updateTrayMenu(): void {
  if (!tray) return;
  tray.sendAction({ type: 'update-menu', menu: buildMenu() });
}

async function main() {
  trayLog(`Tray starting (locale=${detectLocale()}, pid=${process.pid})`);

  tray = new SysTray({ menu: buildMenu(), copyDir: false });
  await tray.ready();

  tray.onClick(async (action: { item: { title: string }; seq_id: number }) => {
    const title = action.item.title;
    if (title === t.openUI) {
      openBrowser(WEB_UI_URL);
    } else if (title === t.startServer) {
      await startServer();
    } else if (title === t.stopServer) {
      stopServer();
    } else if (title === t.quit) {
      stopServer();
      setTimeout(async () => {
        if (tray) await tray.kill(false);
        process.exit(0);
      }, 1000);
    }
  });

  tray.onError((err: Error) => {
    trayLog(`Tray error: ${err.message}`);
  });

  await startServer();
}

main().catch((err) => {
  trayLog(`Tray failed to start: ${err}`);
  process.exit(1);
});
