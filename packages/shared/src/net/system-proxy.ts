/**
 * System proxy discovery.
 *
 * Kept separate from {@link ./egress.ts} because everything here shells out — it
 * runs once per resolution, not per request, and it must never throw into a caller
 * that is just trying to make an HTTP request.
 */
import { execSync } from 'node:child_process';
import { platform } from 'node:os';

function run(command: string, timeout = 3000): string {
  try {
    const output = execSync(command, { encoding: 'utf-8', timeout, stdio: ['ignore', 'pipe', 'ignore'] });
    // Never hand a non-string back to a caller that will .trim() it: execSync is
    // typed as string, but a stub (tests) or an odd spawn can yield undefined.
    return typeof output === 'string' ? output : '';
  } catch {
    return '';
  }
}

function readMacOSProxy(): string | undefined {
  const output = run('scutil --proxy');
  if (!output) return undefined;

  if (/HTTPSEnable\s*:\s*1/.test(output)) {
    const host = output.match(/HTTPSProxy\s*:\s*(\S+)/)?.[1];
    const port = output.match(/HTTPSPort\s*:\s*(\d+)/)?.[1];
    if (host && port) return `http://${host}:${port}`;
  }
  if (/HTTPEnable\s*:\s*1/.test(output)) {
    const host = output.match(/HTTPProxy\s*:\s*(\S+)/)?.[1];
    const port = output.match(/HTTPPort\s*:\s*(\d+)/)?.[1];
    if (host && port) return `http://${host}:${port}`;
  }
  return undefined;
}

function readWindowsProxy(): string | undefined {
  const output = run(
    'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /v ProxyServer',
  );
  if (!output) return undefined;

  const enable = output.match(/ProxyEnable\s+REG_DWORD\s+0x(\d+)/);
  if (!enable || enable[1] === '0') return undefined;

  const server = output.match(/ProxyServer\s+REG_SZ\s+(\S+)/)?.[1];
  if (!server) return undefined;

  // Windows stores either "host:port" or "http=host:port;https=host:port".
  if (server.includes('=')) {
    const entry = server.split(';').find(part => part.startsWith('https='))
      ?? server.split(';').find(part => part.startsWith('http='));
    const address = entry?.split('=')[1];
    if (!address) return undefined;
    return address.startsWith('http') ? address : `http://${address}`;
  }
  return server.startsWith('http') ? server : `http://${server}`;
}

function readLinuxProxy(): string | undefined {
  const mode = run('gsettings get org.gnome.system.proxy mode', 2000).trim().replace(/'/g, '');
  if (mode !== 'manual') return undefined;

  for (const scheme of ['https', 'http']) {
    const host = run(`gsettings get org.gnome.system.proxy.${scheme} host`, 2000).trim().replace(/'/g, '');
    const port = run(`gsettings get org.gnome.system.proxy.${scheme} port`, 2000).trim();
    if (host && port && port !== '0') return `http://${host}:${port}`;
  }
  return undefined;
}

/** System-configured proxy URL for this machine, if any. */
export function readSystemProxy(): string | undefined {
  switch (platform()) {
    case 'darwin':
      return readMacOSProxy();
    case 'win32':
      return readWindowsProxy();
    default:
      return readLinuxProxy();
  }
}
