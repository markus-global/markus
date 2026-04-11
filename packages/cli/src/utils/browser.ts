/**
 * Auto-open browser utility for markus start command.
 * Uses `open` on macOS and `xdg-open` on Linux.
 */

import { exec } from 'node:child_process';
import { platform } from 'node:os';

export function openBrowser(url: string): void {
  if (process.env['NO_BROWSER']) return;

  const sys = platform();
  const cmd = sys === 'darwin' ? `open "${url}"` : sys === 'win32' ? `start "" "${url}"` : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) {
      // Browser open failure is non-fatal, silently ignore.
    }
  });
}
