/**
 * Auto-open browser utility for markus start command.
 * Uses `open` on macOS and `xdg-open` on Linux.
 */

import { exec } from 'node:child_process';
import { get as httpGet } from 'node:http';
import { platform } from 'node:os';

export function openBrowser(url: string): void {
  if (process.env['NO_BROWSER']) return;

  const sys = platform();
  const cmd = sys === 'darwin' ? `open "${url}"` : sys === 'win32' ? `start "" "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

/**
 * Poll the health endpoint until it responds with 2xx/3xx, then open browser.
 * Gives up silently after maxMs (default 30s).
 */
export function openBrowserAfterHealthCheck(
  uiUrl: string,
  healthUrl: string,
  intervalMs = 500,
  maxMs = 30000,
): void {
  if (process.env['NO_BROWSER']) return;

  const deadline = Date.now() + maxMs;
  const check = () => {
    const req = httpGet(healthUrl, (res) => {
      res.resume();
      if (res.statusCode && res.statusCode >= 200 && res.statusCode < 400) {
        openBrowser(uiUrl);
      } else if (Date.now() < deadline) {
        setTimeout(check, intervalMs);
      }
    });
    req.on('error', () => {
      if (Date.now() < deadline) setTimeout(check, intervalMs);
    });
    req.setTimeout(2000, () => { req.destroy(); });
  };
  check();
}
