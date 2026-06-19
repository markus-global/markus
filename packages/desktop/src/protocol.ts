import { app } from 'electron';
import { restoreOrCreateWindow } from './window.js';

const PROTOCOL = 'markus';

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
    const backendUrl = 'http://localhost:8056';

    if (parsed.hostname === 'invite') {
      const token = parsed.searchParams.get('token');
      if (token) {
        restoreOrCreateWindow(`${backendUrl}/#invite?token=${token}`);
      }
    } else if (parsed.hostname === 'open') {
      const path = parsed.searchParams.get('path') ?? '';
      restoreOrCreateWindow(`${backendUrl}/#${path}`);
    } else {
      restoreOrCreateWindow(backendUrl);
    }
  } catch {
    restoreOrCreateWindow('http://localhost:8056');
  }
}
