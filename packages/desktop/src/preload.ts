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
});
