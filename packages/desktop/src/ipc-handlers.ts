import { ipcMain, app, shell, Notification, BrowserWindow } from 'electron';

export function setupIpcHandlers(): void {
  ipcMain.handle('app:get-version', () => {
    return app.getVersion();
  });

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
}
