import { contextBridge, ipcRenderer } from 'electron';

// Apply chrome classes as early as possible so traffic-light padding exists
// before React paints (main-process insertCSS was easy to miss / race).
function markElectronChrome(): void {
  document.documentElement.classList.add('electron-app');
  if (process.platform === 'darwin') {
    document.documentElement.classList.add('electron-darwin');
  }
  (window as unknown as { __MARKUS_ELECTRON__?: boolean }).__MARKUS_ELECTRON__ = true;
}
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', markElectronChrome);
} else {
  markElectronChrome();
}

contextBridge.exposeInMainWorld('markusDesktop', {
  platform: process.platform,
  isMAS: process.env['MARKUS_MAS'] === 'true',

  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  getDefaultCwd: () => ipcRenderer.invoke('app:get-default-cwd') as Promise<string>,
  openExternal: (url: string) => ipcRenderer.invoke('app:open-external', url),
  focusWindow: () => ipcRenderer.invoke('app:focus-window'),
  openInBrowser: () => ipcRenderer.invoke('app:open-in-browser'),
  /** Native directory picker — returns selected absolute path, or null if cancelled. */
  selectDirectory: (title?: string) => ipcRenderer.invoke('dialog:open-directory', title) as Promise<string | null>,

  showNotification: (title: string, body: string) =>
    ipcRenderer.invoke('app:show-notification', title, body),

  checkForUpdates: () => ipcRenderer.invoke('app:check-for-updates'),

  getLoginItemSettings: () => ipcRenderer.invoke('app:get-login-item-settings'),
  setLoginItemSettings: (openAtLogin: boolean) =>
    ipcRenderer.invoke('app:set-login-item-settings', openAtLogin),

  onUpdateAvailable: (callback: (info: { version: string }) => void) => {
    ipcRenderer.on('update:available', (_event, info) => callback(info));
  },

  onUpdateDownloaded: (callback: (info: { version: string }) => void) => {
    ipcRenderer.on('update:downloaded', (_event, info) => callback(info));
  },

  /** Menu accelerators (Cmd/Ctrl+W / T) → right-panel tab actions. */
  onAppShortcut: (callback: (event: { type: 'close-tab' | 'new-tab' }) => void) => {
    const handler = (_: unknown, event: { type: 'close-tab' | 'new-tab' }) => callback(event);
    ipcRenderer.on('app:shortcut', handler);
    return () => { ipcRenderer.removeListener('app:shortcut', handler); };
  },

  onNotification: (callback: (data: { title: string; body: string; type: string }) => void) => {
    ipcRenderer.on('notification:show', (_event, data) => callback(data));
  },

  onNotificationClick: (callback: (nav: { page: string; params?: Record<string, string> }) => void) => {
    ipcRenderer.on('notification:navigate', (_event, nav) => callback(nav));
  },

  // OAuth deep-link handoff (markus://auth). The main process fires this when
  // the system browser returns control to the app after Hub sign-in.
  onDeepLinkAuth: (callback: (data: { session: string }) => void) => {
    ipcRenderer.on('auth:deep-link', (_event, data) => callback(data));
  },
  peekPendingDeepLinkAuth: () => ipcRenderer.invoke('auth:peek-pending-deep-link'),
  consumePendingDeepLinkAuth: () => ipcRenderer.invoke('auth:consume-pending-deep-link'),
  clearPendingDeepLinkAuth: () => ipcRenderer.invoke('auth:clear-pending-deep-link'),

  // Hub marketplace install (markus://install?id=&type=).
  onDeepLinkInstall: (callback: (data: { id: string; type: string }) => void) => {
    ipcRenderer.on('install:deep-link', (_event, data) => callback(data));
  },
  consumePendingDeepLinkInstall: () => ipcRenderer.invoke('install:consume-pending-deep-link'),

  setTrafficLightPosition: (x: number, y: number) =>
    ipcRenderer.invoke('app:set-traffic-light-position', x, y),

  // Embedded browser (WebContentsView in the right panel)
  browser: {
    create: (id: string, url?: string) => ipcRenderer.invoke('browser:create', id, url),
    destroy: (id: string) => ipcRenderer.invoke('browser:destroy', id),
    setBounds: (id: string, bounds: { x: number; y: number; width: number; height: number }, visible?: boolean) =>
      ipcRenderer.invoke('browser:set-bounds', id, bounds, visible),
    hideAll: () => ipcRenderer.invoke('browser:hide-all'),
    navigate: (id: string, url: string) => ipcRenderer.invoke('browser:navigate', id, url),
    action: (id: string, action: 'back' | 'forward' | 'reload' | 'stop') =>
      ipcRenderer.invoke('browser:action', id, action),
    getState: (id: string) => ipcRenderer.invoke('browser:get-state', id),
    executeJs: (id: string, code: string) => ipcRenderer.invoke('browser:execute-js', id, code),
    capture: (id: string) => ipcRenderer.invoke('browser:capture', id),
    cdp: (id: string, method: string, params?: Record<string, unknown>) =>
      ipcRenderer.invoke('browser:cdp', id, method, params),
    openDevTools: (id: string) => ipcRenderer.invoke('browser:open-devtools', id),
    onPageEvent: (callback: (event: {
      type: 'opened' | 'closed' | 'navigated' | 'selected' | 'loading' | 'loaded' | 'load-failed' | 'directory';
      pageId: number;
      browserId: string;
      url?: string;
      title?: string;
      isLoading?: boolean;
      error?: string;
      directoryPath?: string;
    }) => void) => {
      const handler = (_: unknown, event: {
        type: 'opened' | 'closed' | 'navigated' | 'selected' | 'loading' | 'loaded' | 'load-failed' | 'directory';
        pageId: number;
        browserId: string;
        url?: string;
        title?: string;
        isLoading?: boolean;
        error?: string;
        directoryPath?: string;
      }) => callback(event);
      ipcRenderer.on('browser:page-event', handler);
      return () => { ipcRenderer.removeListener('browser:page-event', handler); };
    },
  },

  // Embedded terminal (PTY in the right panel)
  terminal: {
    create: (id: string, opts?: { cwd?: string; title?: string; cols?: number; rows?: number }) =>
      ipcRenderer.invoke('terminal:create', id, opts),
    destroy: (id: string) => ipcRenderer.invoke('terminal:destroy', id),
    write: (id: string, data: string) => ipcRenderer.invoke('terminal:write', id, data),
    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.invoke('terminal:resize', id, cols, rows),
    list: () => ipcRenderer.invoke('terminal:list'),
    getBuffer: (id: string, opts?: { maxChars?: number; maxLines?: number }) =>
      ipcRenderer.invoke('terminal:get-buffer', id, opts),
    select: (id: string) => ipcRenderer.invoke('terminal:select', id),
    onData: (callback: (event: { id: string; data: string }) => void) => {
      const handler = (_: unknown, event: { id: string; data: string }) => callback(event);
      ipcRenderer.on('terminal:data', handler);
      return () => { ipcRenderer.removeListener('terminal:data', handler); };
    },
    onExit: (callback: (event: { id: string; exitCode: number }) => void) => {
      const handler = (_: unknown, event: { id: string; exitCode: number }) => callback(event);
      ipcRenderer.on('terminal:exit', handler);
      return () => { ipcRenderer.removeListener('terminal:exit', handler); };
    },
    onEvent: (callback: (event: {
      type: 'opened' | 'closed' | 'selected' | 'cwd';
      id: string;
      title?: string;
      cwd?: string;
    }) => void) => {
      const handler = (_: unknown, event: {
        type: 'opened' | 'closed' | 'selected' | 'cwd';
        id: string;
        title?: string;
        cwd?: string;
      }) => callback(event);
      ipcRenderer.on('terminal:event', handler);
      return () => { ipcRenderer.removeListener('terminal:event', handler); };
    },
  },
});
