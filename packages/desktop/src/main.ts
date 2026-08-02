import { app, BrowserWindow, shell, dialog, session } from 'electron';
import { join } from 'node:path';
import { startMarkusBackend, shutdownBackend } from './backend.js';
import { createMainWindow, getMainWindow, restoreOrCreateWindow } from './window.js';
import { setupMenu } from './menu.js';
import { setupTray, destroyTray } from './tray.js';
import { setupIpcHandlers } from './ipc-handlers.js';
import { setupAutoUpdater } from './updater.js';
import { registerProtocol, handleSecondInstanceArgs, consumePendingLaunchUrl, setProtocolBackendUrl } from './protocol.js';
import { startNotificationBridge, stopNotificationBridge } from './notifications.js';
import { ensureWindowsShortcuts } from './windows-shortcuts.js';
import { setAppQuitting } from './app-lifecycle.js';

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
        // Parse Local Address port exactly — `findstr :8056` also matches :18056.
        const out = execSync('netstat -ano -p tcp', { encoding: 'utf-8' });
        const pids: string[] = [];
        for (const line of out.split('\n')) {
          if (!/LISTENING/i.test(line)) continue;
          const parts = line.trim().split(/\s+/);
          // Proto LocalAddress ForeignAddress State PID
          const local = parts[1] ?? '';
          const pid = parts[4];
          const m = /:(\d+)$/.exec(local);
          if (m && Number(m[1]) === port && pid && /^\d+$/.test(pid)) pids.push(pid);
        }
        return [...new Set(pids)];
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

async function waitForBackendHealth(url: string, attempts = 30): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const h = await probeHealth(url);
    if (h.running) return;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Backend health check failed at ${url}`);
}

// Single instance lock — prevent multiple instances. Without the lock, a second
// process must not run whenReady (it would race for port 8056 / windows).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    // If argv carries markus://install|auth|…, protocol handler navigates.
    // Do not follow with bare backendUrl — that would wipe ?install= / #explore.
    const handledProtocol = handleSecondInstanceArgs(argv);
    if (!handledProtocol) restoreOrCreateWindow(backendUrl);
  });

app.whenReady().then(async () => {
  console.log('[main] app ready, appPath:', app.getAppPath());
  // Set templates dir — unpacked from asar so fs.lstat/readdir work
  const templatesDir = join(app.getAppPath().replace('app.asar', 'app.asar.unpacked'), 'dist', 'templates');
  process.env['MARKUS_TEMPLATES_DIR'] = templatesDir;
  console.log('[main] MARKUS_TEMPLATES_DIR:', templatesDir);

  registerProtocol();
  setupIpcHandlers();
  // NSIS upgrades often skip desktop shortcuts — create them from the app.
  void ensureWindowsShortcuts();

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

  // Detect a hidden auto-start launch (macOS: openAsHidden; Windows: --hidden
  // arg we register with setLoginItemSettings). The window is still created and
  // the backend still starts — the window just stays in the tray until the user
  // opens it, so booting the machine doesn't pop the app to the foreground.
  const startHidden = process.argv.includes('--hidden')
    || (() => { try { return app.getLoginItemSettings().wasOpenedAsHidden; } catch { return false; } })();

  // Show splash / loading window while backend starts
  console.log('[main] creating window...', { startHidden });
  const win = createMainWindow(!startHidden);
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
  if (!startHidden) win.show();

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
      setProtocolBackendUrl(backendUrl);
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
      setProtocolBackendUrl(backendUrl);
      backendReady = true;

      // Wire embedded WebContentsView as a CDP backend for browser tools.
      try {
        const { createEmbeddedBrowserHost } = await import('./embedded-browser-backend.js');
        const am = instance.apiServer.orgService.getAgentManager() as {
          setEmbeddedBrowserHost?: (host: ReturnType<typeof createEmbeddedBrowserHost>) => void;
        };
        am.setEmbeddedBrowserHost?.(createEmbeddedBrowserHost());
        console.log('[main] embedded browser CDP host registered');
      } catch (err) {
        console.warn('[main] failed to register embedded browser host:', err);
      }
    }

    startNotificationBridge(backendUrl);
    // start() now awaits listen, but still retry health before loading the UI
    // so a slow bind / antivirus delay cannot flash a failed page.
    await waitForBackendHealth(backendUrl);
    // Prefer a deep-link target queued during splash (markus://install, etc.).
    const launchUrl = consumePendingLaunchUrl() ?? backendUrl;
    win.loadURL(launchUrl);
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
    // Hash-only / unknown SPA fragments must NOT open a second Markus window —
    // markdown TOC links like `#section` resolve to localhost/#section and would
    // otherwise land on Home. Deny and let the renderer handle in-doc scroll.
    try {
      const parsed = new URL(url);
      const isLocalApp = parsed.origin === new URL(backendUrl).origin
        || parsed.hostname === 'localhost'
        || parsed.hostname === '127.0.0.1';
      if (isLocalApp) {
        const page = (parsed.hash || '').replace(/^#/, '').split(/[/?]/)[0] || '';
        // Allow real app routes (e.g. #team, #work/…) and auth paths; deny bare heading slugs.
        // Must match packages/web-ui/src/routes.ts PAGE_HASH + HASH_ALIASES (+ auth).
        const knownAppPages = /^(overview|team|tasks|explore|assets|output|settings|notifications|search|home|work|store|builder|deliverables|chat|dashboard|projects|login|auth)/i;
        if (page && !knownAppPages.test(page) && !parsed.pathname.includes('/auth')) {
          return { action: 'deny' };
        }
        return { action: 'allow' };
      }
    } catch {
      /* fall through */
    }
    // Allow local URLs (backend) that passed the SPA-hash check above
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

  // Mark Electron env when web UI loads (chrome CSS lives in web-ui; class also set in preload).
  win.webContents.on('did-finish-load', () => {
    const currentUrl = win.webContents.getURL();
    if (currentUrl.startsWith('http://localhost') || currentUrl.startsWith('http://127.0.0.1') || currentUrl.startsWith(backendUrl)) {
      win.webContents.executeJavaScript(`
        window.__MARKUS_ELECTRON__ = true;
        document.documentElement.classList.add('electron-app');
        if (${JSON.stringify(process.platform)} === 'darwin') {
          document.documentElement.classList.add('electron-darwin');
        }
      `).catch(() => {});
    }
  });
});

// Keep backend + tray alive when the last window is closed (macOS and Windows).
// User exits explicitly via tray / menu Quit.
app.on('window-all-closed', () => {
  /* no-op */
});

app.on('activate', () => {
  if (backendReady) {
    restoreOrCreateWindow(backendUrl);
  }
});

let quitting = false;
app.on('before-quit', (event) => {
  if (quitting) return;
  // Prevent default once so we can await a bounded shutdown; then force-exit
  // so Windows upgrades are not blocked by a hung backend close.
  event.preventDefault();
  quitting = true;
  setAppQuitting(true);
  // Allow the hidden main window to actually close now.
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.destroy();
  }
  stopNotificationBridge();
  destroyTray();
  const timeout = setTimeout(() => {
    console.warn('[main] shutdown timed out — forcing exit');
    app.exit(0);
  }, 2000);
  void shutdownBackend()
    .catch((err) => console.warn('[main] shutdown error:', err))
    .finally(() => {
      clearTimeout(timeout);
      app.exit(0);
    });
});
} // end gotLock
