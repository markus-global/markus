import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('markusDesktop', {
  platform: process.platform,
  isMAS: process.env['MARKUS_MAS'] === 'true',

  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  openExternal: (url: string) => ipcRenderer.invoke('app:open-external', url),
  openInBrowser: () => ipcRenderer.invoke('app:open-in-browser'),

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
  consumePendingDeepLinkAuth: () => ipcRenderer.invoke('auth:consume-pending-deep-link'),

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
});
