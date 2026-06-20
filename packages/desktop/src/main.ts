import { app, BrowserWindow, shell, dialog, session } from 'electron';
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

interface HealthResult {
  running: boolean;
  version?: string;
  sameVersion: boolean;
}

const APP_VERSION: string = (() => {
  try { return require(join(app.getAppPath(), 'package.json')).version; } catch { return ''; }
})();

async function probeHealth(url: string): Promise<HealthResult> {
  const none: HealthResult = { running: false, sameVersion: false };
  try {
    const http = await import('node:http');
    return await new Promise<HealthResult>((resolve) => {
      const req = http.default.get(`${url}/api/health`, { timeout: 2000 }, (res) => {
        let body = '';
        res.on('data', (c: Buffer) => { body += c; });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data.status === 'ok') {
              resolve({ running: true, version: data.version, sameVersion: data.version === APP_VERSION });
              return;
            }
          } catch { /* not Markus */ }
          resolve(none);
        });
      });
      req.on('error', () => resolve(none));
      req.on('timeout', () => { req.destroy(); resolve(none); });
    });
  } catch { return none; }
}

async function stopPortProcess(port: number): Promise<void> {
  const { execSync } = await import('node:child_process');
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  const getPids = (): string[] => {
    try {
      if (process.platform === 'win32') {
        const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf-8' });
        return [...new Set(out.split('\n').map(l => l.trim().split(/\s+/).pop()).filter(Boolean))];
      }
      return execSync(`lsof -ti :${port} 2>/dev/null`, { encoding: 'utf-8' }).trim().split('\n').filter(Boolean);
    } catch { return []; }
  };

  // Graceful: SIGTERM (Windows: taskkill without /F)
  const pids = getPids();
  if (pids.length === 0) return;
  try {
    if (process.platform === 'win32') {
      for (const pid of pids) execSync(`taskkill /PID ${pid}`, { stdio: 'ignore' });
    } else {
      for (const pid of pids) execSync(`kill ${pid}`, { stdio: 'ignore' });
    }
  } catch { /* process may have already exited */ }

  // Wait up to 5s for graceful exit
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    if (getPids().length === 0) return;
  }

  // Force kill as last resort
  const remaining = getPids();
  if (remaining.length === 0) return;
  try {
    if (process.platform === 'win32') {
      for (const pid of remaining) execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
    } else {
      for (const pid of remaining) execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
    }
  } catch { /* best-effort */ }
  await sleep(1000);
}
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

  // Set templates dir — unpacked from asar so fs.lstat/readdir work
  const templatesDir = join(app.getAppPath().replace('app.asar', 'app.asar.unpacked'), 'dist', 'templates');
  process.env['MARKUS_TEMPLATES_DIR'] = templatesDir;
  console.log('[main] MARKUS_TEMPLATES_DIR:', templatesDir);

  registerProtocol();
  setupIpcHandlers();

  // Handle file downloads (e.g. Chrome extension zip from Settings)
  session.defaultSession.on('will-download', (_event, item) => {
    const filename = item.getFilename();
    const downloadsPath = app.getPath('downloads');
    item.setSavePath(join(downloadsPath, filename));
    item.on('done', (_e, state) => {
      if (state === 'completed') {
        shell.showItemInFolder(join(downloadsPath, filename));
      }
    });
  });

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

  // Start backend (or reuse an existing instance on the same port)
  const isZh = app.getLocale().startsWith('zh');
  const t = (en: string, zh: string) => isZh ? zh : en;

  const updateSplash = (msg: string) => {
    win.webContents.executeJavaScript(
      `document.getElementById('status')&&(document.getElementById('status').textContent=${JSON.stringify(msg)})`,
    ).catch(() => {});
  };

  try {
    const port = 8056;
    const health = await probeHealth(backendUrl);

    if (health.running && health.sameVersion) {
      console.log('[main] reusing existing Markus server (same version:', health.version, ')');
      updateSplash(t('Connecting to running server...', '正在连接已运行的服务...'));
      backendReady = true;
    } else {
      if (health.running) {
        console.log('[main] old Markus server detected (', health.version, '→', APP_VERSION, '), restarting...');
        updateSplash(t('Restarting server (upgrading)...', '正在重启服务（升级中）...'));
        await stopPortProcess(port);
      }
      const instance = await startMarkusBackend({
        onProgress: (_step, message) => updateSplash(message),
      });
      backendUrl = instance.url;
      backendReady = true;
    }

    startNotificationBridge(backendUrl);
    win.loadURL(backendUrl);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error('[main] backend startup error:', errorMsg);
    const errHtml = `<span style="color:#ef4444">${t('Error', '错误')}: ${errorMsg}</span><br><br>`
      + `<span style="color:#94a3b8">${t('You can use Markus CLI instead:', '你可以改用命令行启动：')}<br><code>markus start</code></span>`;
    win.webContents.executeJavaScript(
      `document.getElementById('status')&&(document.getElementById('status').innerHTML=${JSON.stringify(errHtml)})`,
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
    // Auth flows (local OAuth callbacks + Hub login/connect) → popup window
    const isAuthFlow = url.includes('/auth/callback') || url.includes('/auth/login')
      || url.includes('/auth/connect') || url.includes('/oauth');
    if (isAuthFlow) {
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
    // All other external URLs → system browser
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
