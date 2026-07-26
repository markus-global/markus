import { ipcMain, app, shell, Notification, BrowserWindow } from 'electron';
import { consumePendingDeepLinkAuth } from './protocol.js';
import {
  createEmbeddedBrowser,
  destroyEmbeddedBrowser,
  hideAllEmbeddedBrowsers,
  setEmbeddedBrowserBounds,
  navigateEmbeddedBrowser,
  embeddedBrowserAction,
  getEmbeddedBrowserState,
  executeInEmbeddedBrowser,
  captureEmbeddedBrowser,
  debuggerSendEmbeddedBrowser,
} from './embedded-browser.js';

export function setupIpcHandlers(): void {
  ipcMain.handle('app:get-version', () => {
    return app.getVersion();
  });

  // Hand a pending markus://auth deep-link session to the renderer (cold start).
  ipcMain.handle('auth:consume-pending-deep-link', () => consumePendingDeepLinkAuth());

  ipcMain.handle('app:open-external', (_event, url: string) => {
    return shell.openExternal(url);
  });

  ipcMain.handle('app:open-in-browser', () => {
    const win = BrowserWindow.getFocusedWindow();
    const url = win?.webContents.getURL() ?? 'http://localhost:8056';
    // Open the base URL (without hash) to let browser handle routing
    const baseUrl = url.split('#')[0];
    return shell.openExternal(baseUrl);
  });

  ipcMain.handle('app:show-notification', (_event, title: string, body: string) => {
    if (Notification.isSupported()) {
      const notification = new Notification({ title, body });
      notification.show();
      notification.on('click', () => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
          if (win.isMinimized()) win.restore();
          win.focus();
        }
      });
    }
  });

  ipcMain.handle('app:set-traffic-light-position', (event, x: number, y: number) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getAllWindows()[0];
    if (win && process.platform === 'darwin') {
      win.setWindowButtonPosition({ x, y });
    }
  });

  // Launch-at-login (auto-start on boot). User-controlled via Settings.
  // Supported on Windows and macOS; Linux support depends on the desktop
  // environment (Electron writes an autostart .desktop entry where possible).
  ipcMain.handle('app:get-login-item-settings', () => {
    try {
      return { openAtLogin: app.getLoginItemSettings().openAtLogin };
    } catch {
      return { openAtLogin: false };
    }
  });

  ipcMain.handle('app:set-login-item-settings', (_event, openAtLogin: boolean) => {
    try {
      // On Windows, launch the app minimized to the tray so auto-start is
      // unobtrusive; macOS honors openAsHidden natively.
      app.setLoginItemSettings({
        openAtLogin: !!openAtLogin,
        openAsHidden: !!openAtLogin,
        ...(process.platform === 'win32' ? { args: ['--hidden'] } : {}),
      });
      return { openAtLogin: app.getLoginItemSettings().openAtLogin };
    } catch (err) {
      return { openAtLogin: false, error: String(err) };
    }
  });

  ipcMain.handle('app:check-for-updates', async () => {
    if (process.env['MARKUS_MAS'] === 'true') {
      return { available: false, message: 'Updates managed by App Store' };
    }
    try {
      const { autoUpdater } = await import('electron-updater');
      const result = await autoUpdater.checkForUpdates();
      return { available: !!result?.updateInfo, version: result?.updateInfo?.version };
    } catch (err) {
      return { available: false, error: String(err) };
    }
  });

  // ── Embedded browser (right-panel WebContentsView) ────────────────────────
  ipcMain.handle('browser:create', (_e, id: string, url?: string) => createEmbeddedBrowser(id, url));
  ipcMain.handle('browser:destroy', (_e, id: string) => destroyEmbeddedBrowser(id));
  ipcMain.handle('browser:set-bounds', (_e, id: string, bounds: { x: number; y: number; width: number; height: number }, visible?: boolean) =>
    setEmbeddedBrowserBounds(id, bounds, visible !== false));
  ipcMain.handle('browser:hide-all', () => hideAllEmbeddedBrowsers());
  ipcMain.handle('browser:navigate', (_e, id: string, url: string) => navigateEmbeddedBrowser(id, url));
  ipcMain.handle('browser:action', (_e, id: string, action: 'back' | 'forward' | 'reload' | 'stop') =>
    embeddedBrowserAction(id, action));
  ipcMain.handle('browser:get-state', (_e, id: string) => getEmbeddedBrowserState(id));
  ipcMain.handle('browser:execute-js', (_e, id: string, code: string) => executeInEmbeddedBrowser(id, code));
  ipcMain.handle('browser:capture', (_e, id: string) => captureEmbeddedBrowser(id));
  ipcMain.handle('browser:cdp', (_e, id: string, method: string, params?: Record<string, unknown>) =>
    debuggerSendEmbeddedBrowser(id, method, params));
}
