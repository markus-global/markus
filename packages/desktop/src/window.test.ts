import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as WindowModuleNs from './window.js';

/**
 * Regression guard for the "click the dock icon → back to overview" bug.
 *
 * `restoreOrCreateWindow` is the bring-to-front path used by macOS `activate`
 * (dock icon click), the tray menu and the second-instance handler. The web UI
 * is a hash-routed SPA, so any `loadURL(backendUrl)` on an already-loaded
 * window drops the hash and re-boots the app on the overview page.
 */

type MockWin = {
  calls: string[];
  url: string;
  visible: boolean;
  webContents: { getURL: () => string };
  isVisible: () => boolean;
  isMinimized: () => boolean;
  isDestroyed: () => boolean;
  isMaximized: () => boolean;
  getBounds: () => { x: number; y: number; width: number; height: number };
  show: () => void;
  hide: () => void;
  restore: () => void;
  focus: () => void;
  maximize: () => void;
  loadURL: (url: string) => void;
  on: () => void;
  setMenuBarVisibility: () => void;
};

const BACKEND = 'http://localhost:8056';
let created: MockWin[] = [];

function makeMockWindow(): MockWin {
  const win: MockWin = {
    calls: [],
    url: BACKEND,
    visible: true,
    webContents: { getURL: () => win.url },
    isVisible: () => win.visible,
    isMinimized: () => false,
    isDestroyed: () => false,
    isMaximized: () => false,
    getBounds: () => ({ x: 0, y: 0, width: 1280, height: 800 }),
    show: () => win.calls.push('show'),
    hide: () => win.calls.push('hide'),
    restore: () => win.calls.push('restore'),
    focus: () => win.calls.push('focus'),
    maximize: () => win.calls.push('maximize'),
    loadURL: (url: string) => win.calls.push(`loadURL:${url}`),
    on: () => undefined,
    setMenuBarVisibility: () => undefined,
  };
  return win;
}

vi.mock('electron', () => ({
  app: { getAppPath: () => '/tmp/markus-app' },
  screen: { getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 1512, height: 982 } }] },
  BrowserWindow: class {
    constructor() {
      const win = makeMockWindow();
      created.push(win);
      return win as unknown as Electron.BrowserWindow;
    }
  },
}));

type WindowModule = typeof WindowModuleNs;
let mod: WindowModule;

/** Fresh module state per test (mainWindow is module-private). */
async function freshModule(): Promise<{ restore: (url: string, o?: { navigate?: boolean }) => void; getMW: () => unknown }> {
  vi.resetModules();
  created = [];
  mod = await import('./window.js');
  return {
    restore: (url, o) => mod.restoreOrCreateWindow(url, o),
    getMW: () => mod.getMainWindow(),
  };
}

async function withWindow(currentUrl: string, visible = true) {
  const api = await freshModule();
  api.restore(BACKEND); // creates the window
  const win = created[0]!;
  win.url = currentUrl;
  win.visible = visible;
  win.calls.length = 0;
  return { win, api };
}

describe('restoreOrCreateWindow', () => {
  beforeEach(() => {
    created = [];
  });

  it('focuses an existing window without reloading its SPA route', async () => {
    const { win, api } = await withWindow(`${BACKEND}/#/work/proj_123`);

    api.restore(BACKEND);

    expect(win.calls.filter(c => c.startsWith('loadURL'))).toHaveLength(0);
    expect(win.calls).toContain('focus');
    expect(api.getMW()).toBe(win);
  });

  it('does not reload when only the hash differs, even with navigate:true', async () => {
    const { win, api } = await withWindow(`${BACKEND}/#/chat/sess_1`);

    api.restore(BACKEND, { navigate: true });

    expect(win.calls.filter(c => c.startsWith('loadURL'))).toHaveLength(0);
  });

  it('navigates a real deep link when explicitly asked', async () => {
    const { win, api } = await withWindow(`${BACKEND}/#/work`);

    api.restore(`${BACKEND}/?install=abc`, { navigate: true });

    expect(win.calls).toContain(`loadURL:${BACKEND}/?install=abc`);
  });

  it('reveals a hidden window (hidden auto-start launch)', async () => {
    const { win, api } = await withWindow(`${BACKEND}/#/home`, false);

    api.restore(BACKEND);

    expect(win.calls).toContain('show');
    expect(win.calls).toContain('focus');
  });

  it('creates and loads a window when none exists', async () => {
    const api = await freshModule();

    api.restore(BACKEND);

    expect(created).toHaveLength(1);
    expect(created[0]!.calls).toContain(`loadURL:${BACKEND}`);
  });
});
