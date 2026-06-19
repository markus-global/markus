import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { startMarkusBackend, shutdownBackend } from './backend.js';
import { createMainWindow, getMainWindow, restoreOrCreateWindow } from './window.js';
import { setupMenu } from './menu.js';
import { setupTray, destroyTray } from './tray.js';
import { setupIpcHandlers } from './ipc-handlers.js';
import { setupAutoUpdater } from './updater.js';
import { registerProtocol, handleSecondInstanceArgs } from './protocol.js';
import { startNotificationBridge, stopNotificationBridge } from './notifications.js';

app.setName('Markus');

const IS_MAS = process.env['MARKUS_MAS'] === 'true';
let backendReady = false;
let backendUrl = 'http://localhost:8056';

// Single instance lock — prevent multiple instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    handleSecondInstanceArgs(argv);
    restoreOrCreateWindow(backendUrl);
  });
}

app.whenReady().then(async () => {
  console.log('[main] app ready, appPath:', app.getAppPath());

  // Set templates dir so the API server finds bundled templates
  const templatesDir = join(app.getAppPath(), 'dist', 'templates');
  process.env['MARKUS_TEMPLATES_DIR'] = templatesDir;
  console.log('[main] MARKUS_TEMPLATES_DIR:', templatesDir);

  registerProtocol();
  setupIpcHandlers();

  // Show splash / loading window while backend starts
  console.log('[main] creating window...');
  const win = createMainWindow();
  console.log('[main] window created, loading splash...');
  
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[main] did-fail-load:', code, desc, url);
  });
  win.webContents.on('did-finish-load', () => {
    console.log('[main] did-finish-load, URL:', win.webContents.getURL());
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[main] renderer crashed:', details.reason);
  });

  const splashPath = join(app.getAppPath().replace('app.asar', 'app.asar.unpacked'), 'dist', 'splash.html');
  try {
    await win.loadFile(splashPath);
    console.log('[main] splash loaded from file');
  } catch (err) {
    console.error('[main] splash loadFile error:', err);
  }
  win.show();

  // Start backend
  try {
    const instance = await startMarkusBackend({
      onProgress: (_step, message) => {
        win.webContents.executeJavaScript(
          `document.getElementById('status')&&(document.getElementById('status').textContent=${JSON.stringify(message)})`,
        ).catch(() => {});
      },
    });
    backendUrl = instance.url;
    backendReady = true;

    // Start OS notification bridge (listens to backend WebSocket events)
    startNotificationBridge(backendUrl);

    // Load the actual web UI
    win.loadURL(backendUrl);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error('[main] backend startup error:', errorMsg);
    // Show error on the splash page instead of navigating away
    win.webContents.executeJavaScript(
      `document.getElementById('status')&&(document.getElementById('status').innerHTML=${JSON.stringify('<span style="color:#ef4444">Error: ' + errorMsg + '</span><br><br><span style="color:#94a3b8">You can use Markus CLI instead:<br><code>markus start</code></span>')})`,
    ).catch(() => {});
  }

  setupMenu(backendUrl);
  setupTray(backendUrl);

  if (!IS_MAS) {
    setupAutoUpdater();
  }

  // Set window open handler DIRECTLY on the main window's webContents
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Allow local URLs (backend)
    if (url.startsWith('http://localhost') || url.startsWith(backendUrl)) {
      return { action: 'allow' };
    }
    // Only OAuth auth flows get a popup window
    if (url.includes('/auth/callback') || url.includes('/auth/login') || url.includes('/oauth')) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 500,
          height: 650,
          resizable: true,
          minimizable: false,
          maximizable: false,
          title: 'Markus Login',
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
          },
        },
      };
    }
    // All other external URLs (including markus.global Hub pages) → system browser
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Inject Electron-specific styles and mark environment when web UI loads
  win.webContents.on('did-finish-load', () => {
    const currentUrl = win.webContents.getURL();
    if (currentUrl.startsWith('http://localhost') || currentUrl.startsWith(backendUrl)) {
      win.webContents.executeJavaScript(`window.__MARKUS_ELECTRON__ = true;`).catch(() => {});
      if (process.platform === 'darwin') {
        // macOS: inject CSS for traffic light clearance and drag region
        win.webContents.insertCSS(`
          html.electron-app aside {
            padding-top: 48px !important;
          }
          html.electron-app aside > :first-child {
            -webkit-app-region: drag;
          }
          html.electron-app body::before {
            content: '';
            display: block;
            position: fixed;
            top: 0; left: 0; right: 0;
            height: 48px;
            -webkit-app-region: drag;
            z-index: 99999;
            pointer-events: none;
          }
          html.electron-app button,
          html.electron-app a,
          html.electron-app input,
          html.electron-app select,
          html.electron-app textarea,
          html.electron-app [role="button"],
          html.electron-app [data-no-drag] {
            -webkit-app-region: no-drag;
          }
        `).catch(() => {});
      }
      win.webContents.executeJavaScript(`document.documentElement.classList.add('electron-app');`).catch(() => {});
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (backendReady) {
    restoreOrCreateWindow(backendUrl);
  }
});

app.on('before-quit', async () => {
  stopNotificationBridge();
  destroyTray();
  await shutdownBackend();
});
