/**
 * Cross-platform system tray controller for Markus.
 * Provides start/stop controls and quick access to the Web UI.
 *
 * Launched by the desktop shortcut / .app instead of `markus start` directly.
 */

import { spawn, exec, type ChildProcess } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { createConnection } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform, homedir } from 'node:os';
import SysTrayModule from 'systray2';
// systray2 is CJS; default export is the class
const SysTray = (SysTrayModule as any).default || SysTrayModule;
type SysTrayInstance = InstanceType<typeof SysTray>;

const __dirname = dirname(fileURLToPath(import.meta.url));

const WEB_UI_PORT = 8056;
const WEB_UI_URL = `http://localhost:${WEB_UI_PORT}`;

// Resolve paths relative to the binary distribution layout:
//   bin/tray.mjs  (this file)
//   bin/node      (bundled node)
//   bin/markus.mjs
const BIN_DIR = __dirname;
const APP_DIR = resolve(BIN_DIR, '..');
const NODE_BIN = resolve(BIN_DIR, platform() === 'win32' ? 'node.exe' : 'node');
const MARKUS_MJS = resolve(BIN_DIR, 'markus.mjs');
const LOG_DIR = resolve(homedir(), '.markus', 'logs');

function loadIconBase64(): string {
  const candidates = [
    resolve(APP_DIR, 'logo.png'),
    resolve(APP_DIR, 'markus.ico'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      return readFileSync(p).toString('base64');
    }
  }
  // Fallback: empty icon (systray2 will show a default)
  return '';
}

function openBrowser(url: string): void {
  const sys = platform();
  const cmd = sys === 'darwin' ? `open "${url}"`
    : sys === 'win32' ? `start "" "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

// ── Server process management ────────────────────────────────────────────────

let serverProcess: ChildProcess | null = null;
let serverRunning = false;

function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.setTimeout(2000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function startServer(): Promise<void> {
  if (serverRunning) return;

  // If the port is already in use, the server is running externally — just open the browser
  if (await isPortListening(WEB_UI_PORT)) {
    serverRunning = true;
    updateTrayMenu();
    openBrowser(WEB_UI_URL);
    return;
  }

  mkdirSync(LOG_DIR, { recursive: true });

  serverProcess = spawn(NODE_BIN, [MARKUS_MJS, 'start'], {
    stdio: 'ignore',
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
      console.error(`Markus server exited with code ${code}`);
    }
  });

  serverProcess.on('error', (err) => {
    serverRunning = false;
    serverProcess = null;
    updateTrayMenu();
    console.error('Failed to start Markus server:', err.message);
  });

  // Auto-open browser after a short delay
  setTimeout(() => {
    if (serverRunning) openBrowser(WEB_UI_URL);
  }, 3000);
}

function stopServer(): void {
  if (!serverProcess) return;
  serverProcess.kill('SIGTERM');
  // Force kill after 5 seconds if still alive
  const forceTimer = setTimeout(() => {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGKILL');
    }
  }, 5000);
  serverProcess.on('exit', () => clearTimeout(forceTimer));
}

// ── Tray setup ───────────────────────────────────────────────────────────────

const SEPARATOR = { title: '<SEPARATOR>', tooltip: '', enabled: true };
const ITEM_OPEN_UI   = { title: 'Open Web UI', tooltip: 'Open Markus in browser', enabled: true };
const ITEM_START     = { title: 'Start Server', tooltip: 'Start Markus server', enabled: true };
const ITEM_STOP      = { title: 'Stop Server', tooltip: 'Stop Markus server', enabled: false };
const ITEM_QUIT      = { title: 'Quit Markus', tooltip: 'Stop server and quit', enabled: true };

let tray: SysTrayInstance | null = null;

function buildMenu() {
  return {
    icon: loadIconBase64(),
    title: '',
    tooltip: serverRunning ? 'Markus (running)' : 'Markus (stopped)',
    items: [
      { ...ITEM_OPEN_UI, enabled: serverRunning },
      SEPARATOR,
      { ...ITEM_START, enabled: !serverRunning },
      { ...ITEM_STOP, enabled: serverRunning },
      SEPARATOR,
      ITEM_QUIT,
    ],
  };
}

function updateTrayMenu(): void {
  if (!tray) return;
  tray.sendAction({ type: 'update-menu', menu: buildMenu() });
}

async function main() {
  tray = new SysTray({ menu: buildMenu(), copyDir: false });

  await tray.ready();

  tray.onClick(async (action: { item: { title: string }; seq_id: number }) => {
    const title = action.item.title;
    if (title === ITEM_OPEN_UI.title) {
      openBrowser(WEB_UI_URL);
    } else if (title === ITEM_START.title) {
      await startServer();
    } else if (title === ITEM_STOP.title) {
      stopServer();
    } else if (title === ITEM_QUIT.title) {
      stopServer();
      // Wait briefly for server to stop, then exit
      setTimeout(async () => {
        if (tray) await tray.kill(false);
        process.exit(0);
      }, 1000);
    }
  });

  tray.onError((err: Error) => {
    console.error('Tray error:', err.message);
  });

  // Auto-start the server on launch
  await startServer();
}

main().catch((err) => {
  console.error('Tray failed to start:', err);
  process.exit(1);
});
