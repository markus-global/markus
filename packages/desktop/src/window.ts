import { BrowserWindow, screen, app } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAppQuitting } from './app-lifecycle.js';

const STATE_FILE = join(homedir(), '.markus', 'window-state.json');

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized?: boolean;
}

function loadWindowState(): WindowState {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch { /* use defaults */ }
  return { width: 1280, height: 800 };
}

function saveWindowState(win: BrowserWindow): void {
  try {
    const bounds = win.getBounds();
    const state: WindowState = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized: win.isMaximized(),
    };
    const dir = join(homedir(), '.markus');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch { /* best-effort */ }
}

function isStateVisible(state: WindowState): boolean {
  const displays = screen.getAllDisplays();
  return displays.some(display => {
    const { x, y, width, height } = display.bounds;
    return (
      (state.x ?? 0) >= x - 100 &&
      (state.x ?? 0) <= x + width + 100 &&
      (state.y ?? 0) >= y - 100 &&
      (state.y ?? 0) <= y + height + 100
    );
  });
}

let mainWindow: BrowserWindow | null = null;

export function createMainWindow(show = true): BrowserWindow {
  const state = loadWindowState();

  const windowOpts: Electron.BrowserWindowConstructorOptions = {
    width: state.width,
    height: state.height,
    minWidth: 800,
    minHeight: 600,
    show,
    // Windows/Linux: keep Menu.setApplicationMenu for accelerators (Ctrl+R, etc.)
    // but hide the native File/Edit/View bar — it looks like a legacy desktop app.
    ...(process.platform !== 'darwin' ? { autoHideMenuBar: true } : {}),
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset' as const,
      trafficLightPosition: { x: 16, y: 16 },
    } : {}),
    webPreferences: {
      preload: join(app.getAppPath().replace('app.asar', 'app.asar.unpacked'), 'dist', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
    },
  };

  if (state.x !== undefined && state.y !== undefined && isStateVisible(state)) {
    windowOpts.x = state.x;
    windowOpts.y = state.y;
  }

  mainWindow = new BrowserWindow(windowOpts);

  if (process.platform !== 'darwin') {
    mainWindow.setMenuBarVisibility(false);
  }

  // Only maximize when actually showing — maximizing a hidden window can force
  // it visible on some platforms, defeating a hidden auto-start launch.
  if (show && state.isMaximized) {
    mainWindow.maximize();
  }

  // Close = hide to tray (keep backend). Explicit Quit sets isAppQuitting.
  mainWindow.on('close', (event) => {
    if (mainWindow) saveWindowState(mainWindow);
    if (!isAppQuitting()) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    try {
      // Lazy import to avoid circular deps at module load.
      void import('./embedded-browser.js').then(m => m.destroyAllEmbeddedBrowsers());
    } catch { /* ignore */ }
    mainWindow = null;
  });

  return mainWindow;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export interface RestoreWindowOptions {
  /**
   * Navigate the existing window to `url` instead of only focusing it.
   * Default `false`. The web UI is a hash-routed SPA (`#/work`, `#/chat/…`),
   * so `loadURL(backendUrl)` would drop the hash, re-boot the whole app and
   * dump the user back on the overview page. Bring-to-front must never reload
   * an already-loaded window.
   */
  navigate?: boolean;
}

/**
 * Same document (ignoring the `#route`) — i.e. comparing "the page the window
 * has loaded" rather than the user's current SPA route.
 *
 * Must go through `URL`: `http://host:8056` and `http://host:8056/#/work`
 * are the *same* document (Chromium normalises the bare URL to `…/`), while a
 * naive string compare reports them as different and triggers a full reload.
 */
function sameDocument(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname === ub.pathname && ua.search === ub.search;
  } catch {
    const strip = (raw: string) => {
      const i = raw.indexOf('#');
      return i === -1 ? raw : raw.slice(0, i);
    };
    return strip(a) === strip(b);
  }
}

/**
 * Bring the main window to the foreground — dock icon click, tray click,
 * second instance, `markus://` hand-off.
 *
 * Focus-only by default (see RestoreWindowOptions): an existing window keeps
 * whatever page the user was on. The window is only *created* (and loaded)
 * when none exists.
 */
export function restoreOrCreateWindow(url: string, opts: RestoreWindowOptions = {}): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    // A window created for a hidden auto-start launch exists but was never
    // shown — reveal it before focusing.
    if (!mainWindow.isVisible()) mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    // Only an explicit navigation request (deep link) may change the page —
    // and even then only when the loaded document really differs. A different
    // hash (or a hash vs no hash) is the user's current route, not a reason to
    // reload.
    if (opts.navigate && url) {
      const current = mainWindow.webContents.getURL();
      if (!sameDocument(current, url)) void mainWindow.loadURL(url);
    }
    mainWindow.focus();
  } else {
    const win = createMainWindow();
    void win.loadURL(url);
  }
}
