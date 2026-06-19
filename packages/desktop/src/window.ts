import { BrowserWindow, screen, app } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

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

export function createMainWindow(): BrowserWindow {
  const state = loadWindowState();

  const windowOpts: Electron.BrowserWindowConstructorOptions = {
    width: state.width,
    height: state.height,
    minWidth: 800,
    minHeight: 600,
    show: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
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

  if (state.isMaximized) {
    mainWindow.maximize();
  }

  mainWindow.on('close', () => {
    if (mainWindow) saveWindowState(mainWindow);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function restoreOrCreateWindow(url: string): void {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  } else {
    const win = createMainWindow();
    win.loadURL(url);
  }
}
