import { app } from 'electron';
import { getMainWindow } from './window.js';

const PROTOCOL = 'markus';

/** Resolved once the desktop backend URL is known (may differ from 8056 in tests). */
let backendUrl = 'http://localhost:8056';
export function setProtocolBackendUrl(url: string): void {
  backendUrl = url.replace(/\/+$/, '');
}

// Session id from a markus://auth deep link that arrived before the renderer was
// ready to receive it (typically a cold start launched by the deep link). The
// renderer peeks/consumes it on mount via IPC.
let pendingAuthSession: string | null = null;
export function peekPendingDeepLinkAuth(): string | null {
  return pendingAuthSession;
}
export function consumePendingDeepLinkAuth(): string | null {
  const s = pendingAuthSession;
  pendingAuthSession = null;
  return s;
}
export function clearPendingDeepLinkAuth(): void {
  pendingAuthSession = null;
}

/** Full http URL to open after backend/splash is ready (cold-start race). */
let pendingLaunchUrl: string | null = null;
export function consumePendingLaunchUrl(): string | null {
  const u = pendingLaunchUrl;
  pendingLaunchUrl = null;
  return u;
}

export type PendingInstall = { id: string; type: string };
let pendingInstall: PendingInstall | null = null;
export function consumePendingInstall(): PendingInstall | null {
  const p = pendingInstall;
  pendingInstall = null;
  return p;
}

function isBackendUrl(url: string): boolean {
  return url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:');
}

/**
 * Open a backend UI URL. If the window is still on splash (or not created),
 * stash it for main.ts to load after the server is up — otherwise splash /
 * plain backendUrl would overwrite the install deep link.
 */
function openOrQueueBackendUrl(targetUrl: string): void {
  pendingLaunchUrl = targetUrl;
  const win = getMainWindow();
  if (!win) return;

  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  win.focus();

  const current = win.webContents.getURL();
  if (isBackendUrl(current)) {
    pendingLaunchUrl = null;
    void win.loadURL(targetUrl);
  }
}

function focusMainWindow(): void {
  const win = getMainWindow();
  if (!win) return;
  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
  try { win.flashFrame(true); } catch { /* unsupported */ }
}

function handleProtocolUrl(url: string): boolean {
  try {
    const parsed = new URL(url);

    if (parsed.hostname === 'invite') {
      const token = parsed.searchParams.get('token');
      if (token) {
        openOrQueueBackendUrl(`${backendUrl}/#invite?token=${token}`);
        return true;
      }
    } else if (parsed.hostname === 'install') {
      // Hub marketplace: markus://install?id=ITEM_ID&type=agent|team|skill
      // Web UI reads ?install=&type= and opens Explore (Store) install flow.
      const id = parsed.searchParams.get('id') || parsed.searchParams.get('item') || '';
      const type = parsed.searchParams.get('type') || '';
      if (id) {
        pendingInstall = { id, type };
        const qs = new URLSearchParams({ install: id });
        if (type) qs.set('type', type);
        // Address-bar slug for Store is `#explore` (see web-ui routes PAGE_HASH).
        const target = `${backendUrl}/?${qs.toString()}#explore`;
        openOrQueueBackendUrl(target);
        const win = getMainWindow();
        if (win && isBackendUrl(win.webContents.getURL())) {
          win.webContents.send('install:deep-link', { id, type });
        }
      } else {
        openOrQueueBackendUrl(`${backendUrl}/#explore`);
      }
      return true;
    } else if (parsed.hostname === 'open') {
      const path = parsed.searchParams.get('path') ?? '';
      openOrQueueBackendUrl(`${backendUrl}/#${path}`);
      return true;
    } else if (parsed.hostname === 'auth') {
      // OAuth handoff from the system browser. Focus the app and tell the
      // renderer to finish sign-in for this connect session. Always stash the
      // session too, so a cold start (or an event that races the renderer's
      // listener registration) is still picked up on mount.
      //
      // Cold start: do NOT create a window here — main.ts owns window creation
      // after the backend is up. Creating early races splash and can leave a
      // blank/broken second window.
      const session = parsed.searchParams.get('auth_session') || parsed.searchParams.get('session') || '';
      pendingAuthSession = session || null;
      const win = getMainWindow();
      if (win) {
        focusMainWindow();
        win.webContents.send('auth:deep-link', { session });
      }
      return true;
    } else {
      openOrQueueBackendUrl(backendUrl);
      return true;
    }
  } catch {
    openOrQueueBackendUrl(backendUrl);
    return true;
  }
  return false;
}

// macOS may deliver open-url before app.whenReady(); register early so cold
// starts from markus://install are not dropped.
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleProtocolUrl(url);
});

export function registerProtocol(): void {
  // Always (re)register so Windows HKCU picks up markus:// even when the NSIS
  // installer missed it, or the install path changed after an update.
  let ok = false;
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      ok = app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [process.argv[1]!]);
    }
  } else {
    ok = app.setAsDefaultProtocolClient(PROTOCOL);
  }
  const isDefault = app.isDefaultProtocolClient(PROTOCOL);
  console.log(`[protocol] register ${PROTOCOL}:// → set=${ok} isDefault=${isDefault} platform=${process.platform}`);

  // Windows/Linux: protocol URL on cold start arrives in process.argv
  if (process.platform !== 'darwin') {
    const protocolUrl = process.argv.find(arg => arg.startsWith(`${PROTOCOL}://`));
    if (protocolUrl) handleProtocolUrl(protocolUrl);
  }
}

/**
 * Handle a protocol URL from a second instance launch (Windows/Linux).
 * @returns true if a markus:// URL was handled (caller should not open bare backend).
 */
export function handleSecondInstanceArgs(argv: string[]): boolean {
  const protocolUrl = argv.find(arg => arg.startsWith(`${PROTOCOL}://`));
  if (protocolUrl) {
    return handleProtocolUrl(protocolUrl);
  }
  return false;
}
