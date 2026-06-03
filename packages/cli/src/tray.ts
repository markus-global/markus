/**
 * Cross-platform system tray controller for Markus.
 * Launches the server on start, provides "Open Console" and "Quit" controls.
 */

import { spawn, exec, execSync, type ChildProcess } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, appendFileSync, openSync, writeFileSync, unlinkSync } from 'node:fs';
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
const MARKUS_DIR = resolve(homedir(), '.markus');
const LOCK_FILE = join(MARKUS_DIR, 'tray.lock');

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
  if (platform() === 'win32') {
    try {
      const winLang = execSync('powershell -NoProfile -Command "(Get-Culture).Name"', { encoding: 'utf-8' }).trim();
      if (winLang.startsWith('zh')) return 'zh';
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

// ── Singleton lock ────────────────────────────────────────────────────────────

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(): boolean {
  try {
    mkdirSync(MARKUS_DIR, { recursive: true });
    if (existsSync(LOCK_FILE)) {
      const pid = parseInt(readFileSync(LOCK_FILE, 'utf-8').trim(), 10);
      if (pid && !isNaN(pid) && isProcessAlive(pid)) {
        return false;
      }
    }
    writeFileSync(LOCK_FILE, String(process.pid));
    return true;
  } catch { return true; }
}

function releaseLock(): void {
  try {
    if (existsSync(LOCK_FILE)) {
      const pid = parseInt(readFileSync(LOCK_FILE, 'utf-8').trim(), 10);
      if (pid === process.pid) unlinkSync(LOCK_FILE);
    }
  } catch { /* ignore */ }
}

// ── Port / process helpers ────────────────────────────────────────────────────

function getPortOccupant(port: number): string {
  try {
    if (platform() === 'win32') {
      const out = execSync(
        `netstat -ano | findstr ":${port}" | findstr "LISTENING"`,
        { encoding: 'utf-8', timeout: 5000 },
      ).trim();
      const firstLine = out.split('\n')[0]?.trim();
      if (!firstLine) return 'unknown';
      const pid = firstLine.split(/\s+/).pop();
      if (!pid || pid === '0') return 'unknown';
      const taskInfo = execSync(
        `tasklist /FI "PID eq ${pid}" /FO CSV /NH`,
        { encoding: 'utf-8', timeout: 5000 },
      ).trim();
      return taskInfo.split(',')[0]?.replace(/"/g, '') || 'unknown';
    } else {
      return execSync(
        `lsof -i :${port} -sTCP:LISTEN -t 2>/dev/null | head -1 | xargs ps -p -o comm= 2>/dev/null`,
        { encoding: 'utf-8', timeout: 5000 },
      ).trim() || 'unknown';
    }
  } catch { return 'unknown'; }
}

function getPidsByPort(port: number): number[] {
  try {
    if (platform() === 'win32') {
      const out = execSync(
        `netstat -ano | findstr ":${port}" | findstr "LISTENING"`,
        { encoding: 'utf-8', timeout: 5000 },
      ).trim();
      if (!out) return [];
      const pids = new Set<number>();
      for (const line of out.split('\n')) {
        const pid = parseInt(line.trim().split(/\s+/).pop() ?? '', 10);
        if (pid && !isNaN(pid) && pid !== 0) pids.add(pid);
      }
      return [...pids];
    } else {
      const out = execSync(
        `lsof -i :${port} -sTCP:LISTEN -t 2>/dev/null`,
        { encoding: 'utf-8', timeout: 5000 },
      ).trim();
      if (!out) return [];
      return out.split('\n').map(s => parseInt(s.trim(), 10)).filter(n => n && !isNaN(n));
    }
  } catch { return []; }
}

function killPid(pid: number): void {
  try {
    if (platform() === 'win32') {
      execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore', timeout: 5000 });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch { /* ignore */ }
}

function forceKillPid(pid: number): void {
  try {
    if (platform() === 'win32') {
      execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore', timeout: 5000 });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch { /* ignore */ }
}

function showPortConflictDialog(port: number, occupant: string): void {
  const msg = t.portConflictMsg(port, occupant);
  if (platform() === 'darwin') {
    exec(`osascript -e 'display dialog "${msg}" with title "${t.portConflictTitle}" buttons {"OK"} default button "OK" with icon stop'`, () => {});
  } else if (platform() === 'win32') {
    const escaped = msg.replace(/'/g, "''");
    exec(
      `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.MessageBox]::Show('${escaped}','${t.portConflictTitle}','OK','Error')"`,
      () => {},
    );
  }
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
  if (platform() === 'win32') {
    const wrapperCmd = resolve(APP_DIR, 'markus.cmd');
    if (existsSync(wrapperCmd)) return { cmd: wrapperCmd, args: ['start'] };
  }
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
    const occupant = getPortOccupant(WEB_UI_PORT);
    trayLog(`Port ${WEB_UI_PORT} occupied by "${occupant}"`);
    showPortConflictDialog(WEB_UI_PORT, occupant);
    return;
  }

  mkdirSync(LOG_DIR, { recursive: true });
  const { cmd, args } = resolveMarkusCommand();
  trayLog(`Starting server: ${cmd} ${args.join(' ')}`);

  const outFd = openSync(join(LOG_DIR, 'stdout.log'), 'a');
  const errFd = openSync(join(LOG_DIR, 'stderr.log'), 'a');

  serverProcess = spawn(cmd, args, {
    stdio: ['ignore', outFd, errFd],
    detached: false,
    env: { ...process.env, NO_BROWSER: '1' },
    windowsHide: true,
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

  if (platform() === 'darwin') {
    try {
      const uid = execSync('id -u', { encoding: 'utf-8' }).trim();
      execSync(`launchctl bootout gui/${uid}/global.markus 2>/dev/null`, { encoding: 'utf-8' });
      trayLog('LaunchAgent unloaded');
    } catch { /* not loaded or already unloaded */ }
  }

  if (serverProcess) {
    if (platform() === 'win32') {
      try { execSync(`taskkill /PID ${serverProcess.pid} /T /F`, { stdio: 'ignore', timeout: 5000 }); } catch { /* ignore */ }
    } else {
      serverProcess.kill('SIGTERM');
    }
    serverProcess = null;
  }

  const pids = getPidsByPort(WEB_UI_PORT).filter(p => p !== process.pid);
  for (const pid of pids) {
    trayLog(`Killing server process ${pid}`);
    killPid(pid);
  }

  setTimeout(() => {
    const remaining = getPidsByPort(WEB_UI_PORT).filter(p => p !== process.pid);
    for (const pid of remaining) {
      trayLog(`Force killing server process ${pid}`);
      forceKillPid(pid);
    }
  }, 3000);
}

// ── Tray setup ───────────────────────────────────────────────────────────────

let tray: SysTrayInstance | null = null;

async function main() {
  trayLog(`Tray starting (locale=${detectLocale()}, pid=${process.pid})`);

  if (!acquireLock()) {
    const serverUp = await checkHealthOnce(`${WEB_UI_URL}/api/health`);
    if (serverUp) {
      trayLog('Another tray instance is already running — opening browser and exiting');
      openBrowser(WEB_UI_URL);
      setTimeout(() => process.exit(0), 1000);
      return;
    }
    trayLog('Stale lock file detected (server not healthy) — taking over');
    try { unlinkSync(LOCK_FILE); } catch { /* ignore */ }
    writeFileSync(LOCK_FILE, String(process.pid));
  }

  process.on('exit', releaseLock);
  process.on('SIGINT', () => { releaseLock(); process.exit(0); });
  process.on('SIGTERM', () => { releaseLock(); process.exit(0); });

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
        releaseLock();
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
  releaseLock();
  process.exit(1);
});
