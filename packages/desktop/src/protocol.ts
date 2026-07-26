import { app } from 'electron';
import { getMainWindow, restoreOrCreateWindow } from './window.js';

const PROTOCOL = 'markus';
const BACKEND_URL = 'http://localhost:8056';

// Session id from a markus://auth deep link that arrived before the renderer was
// ready to receive it (typically a cold start launched by the deep link). The
// renderer consumes it on mount via the 'auth:consume-pending-deep-link' IPC.
let pendingAuthSession: string | null = null;
export function consumePendingDeepLinkAuth(): string | null {
  const s = pendingAuthSession;
  pendingAuthSession = null;
  return s;
}

export function registerProtocol(): void {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [process.argv[1]!]);
    }
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }

  // macOS: protocol URLs arrive via open-url event
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleProtocolUrl(url);
  });

  // Windows/Linux: protocol URL on cold start arrives in process.argv
  if (process.platform !== 'darwin') {
    const protocolUrl = process.argv.find(arg => arg.startsWith(`${PROTOCOL}://`));
    if (protocolUrl) handleProtocolUrl(protocolUrl);
  }
}

/**
 * Handle a protocol URL from a second instance launch (Windows/Linux).
 * Called from the second-instance handler in main.ts.
 */
export function handleSecondInstanceArgs(argv: string[]): void {
  const protocolUrl = argv.find(arg => arg.startsWith(`${PROTOCOL}://`));
  if (protocolUrl) {
    handleProtocolUrl(protocolUrl);
  }
}

function handleProtocolUrl(url: string): void {
  try {
    const parsed = new URL(url);
    const backendUrl = BACKEND_URL;

    if (parsed.hostname === 'invite') {
      const token = parsed.searchParams.get('token');
      if (token) {
        restoreOrCreateWindow(`${backendUrl}/#invite?token=${token}`);
      }
    } else if (parsed.hostname === 'open') {
      const path = parsed.searchParams.get('path') ?? '';
      restoreOrCreateWindow(`${backendUrl}/#${path}`);
    } else if (parsed.hostname === 'auth') {
      // OAuth handoff from the system browser. Focus the app and tell the
      // renderer to finish sign-in for this connect session. Always stash the
      // session too, so a cold start (or an event that races the renderer's
      // listener registration) is still picked up on mount.
      const session = parsed.searchParams.get('auth_session') || parsed.searchParams.get('session') || '';
      pendingAuthSession = session || null;
      const win = getMainWindow();
      if (win) {
        if (!win.isVisible()) win.show();
        if (win.isMinimized()) win.restore();
        win.focus();
        win.webContents.send('auth:deep-link', { session });
      } else {
        restoreOrCreateWindow(backendUrl);
      }
    } else {
      restoreOrCreateWindow(backendUrl);
    }
  } catch {
    restoreOrCreateWindow(BACKEND_URL);
  }
}
