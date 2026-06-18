import { app, shell } from 'electron';
import { restoreOrCreateWindow } from './window.js';

const PROTOCOL = 'markus';

export function registerProtocol(): void {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [process.argv[1]]);
    }
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }

  // Handle protocol URL on macOS
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleProtocolUrl(url);
  });
}

function handleProtocolUrl(url: string): void {
  // markus://invite?token=xxx → open invite setup page
  // markus://open?path=/team/t/123 → navigate to path
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
