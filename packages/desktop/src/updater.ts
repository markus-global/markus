import { BrowserWindow } from 'electron';

const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

export function setupAutoUpdater(): void {
  // Delayed import to avoid loading electron-updater in MAS builds
  import('electron-updater').then((mod) => {
    const autoUpdater = mod.autoUpdater ?? mod.default?.autoUpdater ?? mod.default;
    if (!autoUpdater || typeof autoUpdater.checkForUpdatesAndNotify !== 'function') {
      console.warn('electron-updater: autoUpdater not available, skipping auto-update setup');
      return;
    }
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.webContents.send('update:available', { version: info.version });
      }
    });

    autoUpdater.on('update-downloaded', (info) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.webContents.send('update:downloaded', { version: info.version });
      }
    });

    autoUpdater.on('error', (err) => {
      console.error('Auto-updater error:', err.message);
    });

    // Initial check after a short delay
    setTimeout(() => {
      autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    }, 10_000);

    // Periodic checks
    setInterval(() => {
      autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    }, UPDATE_CHECK_INTERVAL_MS);
  }).catch((err) => {
    console.error('Failed to load electron-updater:', err);
  });
}
