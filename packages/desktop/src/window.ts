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

export function restoreOrCreateWindow(url: string): void {
  if (mainWindow) {
    // A window created for a hidden auto-start launch exists but was never
    // shown — reveal it before focusing.
    if (!mainWindow.isVisible()) mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    // Deep links (install/invite/open) must navigate, not only focus.
    if (url) {
      const current = mainWindow.webContents.getURL();
      if (current !== url) void mainWindow.loadURL(url);
    }
    mainWindow.focus();
  } else {
    const win = createMainWindow();
    win.loadURL(url);
  }
}
