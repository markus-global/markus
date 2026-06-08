/**
 * Proxy-aware fetch utility for LLM and OAuth requests.
 * Resolution order for proxy URL:
 *   1. ~/.markus/markus.json → network.proxy
 *   2. HTTPS_PROXY / HTTP_PROXY / ALL_PROXY env vars (any case)
 *   3. macOS system proxy (via scutil --proxy)
 */
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

function readProxyFromConfig(): string | undefined {
  try {
    const configPath = join(homedir(), '.markus', 'markus.json');
    if (!existsSync(configPath)) return undefined;
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    const proxy = raw?.network?.proxy;
    return typeof proxy === 'string' && proxy.length > 0 ? proxy : undefined;
  } catch {
    return undefined;
  }
}

function readSystemProxy(): string | undefined {
  const os = platform();
  try {
    if (os === 'darwin') {
      return readMacOSProxy();
    } else if (os === 'win32') {
      return readWindowsProxy();
    } else {
      // Linux: GNOME/KDE proxy via gsettings or environment — env vars are
      // already checked earlier in the chain, so no extra detection needed.
      return readLinuxProxy();
    }
  } catch {
    return undefined;
  }
}

function readMacOSProxy(): string | undefined {
  const output = execSync('scutil --proxy', { encoding: 'utf-8', timeout: 3000 });
  const httpsEnabled = /HTTPSEnable\s*:\s*1/.test(output);
  if (httpsEnabled) {
    const host = output.match(/HTTPSProxy\s*:\s*(\S+)/)?.[1];
    const port = output.match(/HTTPSPort\s*:\s*(\d+)/)?.[1];
    if (host && port) return `http://${host}:${port}`;
  }
  const httpEnabled = /HTTPEnable\s*:\s*1/.test(output);
  if (httpEnabled) {
    const host = output.match(/HTTPProxy\s*:\s*(\S+)/)?.[1];
    const port = output.match(/HTTPPort\s*:\s*(\d+)/)?.[1];
    if (host && port) return `http://${host}:${port}`;
  }
  return undefined;
}

function readWindowsProxy(): string | undefined {
  // Read from Windows Registry: Internet Settings
  const output = execSync(
    'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /v ProxyServer',
    { encoding: 'utf-8', timeout: 3000 },
  );
  const enableMatch = output.match(/ProxyEnable\s+REG_DWORD\s+0x(\d+)/);
  if (!enableMatch || enableMatch[1] === '0') return undefined;
  const serverMatch = output.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
  if (!serverMatch?.[1]) return undefined;
  const server = serverMatch[1];
  // Windows may store as "host:port" or "http=host:port;https=host:port"
  if (server.includes('=')) {
    const httpsEntry = server.split(';').find(s => s.startsWith('https='));
    const httpEntry = server.split(';').find(s => s.startsWith('http='));
    const entry = httpsEntry ?? httpEntry;
    if (entry) {
      const addr = entry.split('=')[1];
      return addr?.startsWith('http') ? addr : `http://${addr}`;
    }
    return undefined;
  }
  return server.startsWith('http') ? server : `http://${server}`;
}

function readLinuxProxy(): string | undefined {
  // Try GNOME gsettings
  try {
    const mode = execSync("gsettings get org.gnome.system.proxy mode", { encoding: 'utf-8', timeout: 2000 }).trim().replace(/'/g, '');
    if (mode !== 'manual') return undefined;
    const host = execSync("gsettings get org.gnome.system.proxy.https host", { encoding: 'utf-8', timeout: 2000 }).trim().replace(/'/g, '');
    const port = execSync("gsettings get org.gnome.system.proxy.https port", { encoding: 'utf-8', timeout: 2000 }).trim();
    if (host && port && port !== '0') return `http://${host}:${port}`;
    const httpHost = execSync("gsettings get org.gnome.system.proxy.http host", { encoding: 'utf-8', timeout: 2000 }).trim().replace(/'/g, '');
    const httpPort = execSync("gsettings get org.gnome.system.proxy.http port", { encoding: 'utf-8', timeout: 2000 }).trim();
    if (httpHost && httpPort && httpPort !== '0') return `http://${httpHost}:${httpPort}`;
    return undefined;
  } catch {
    return undefined;
  }
}

export type ProxySource = 'config' | 'env' | 'system' | 'none';

export interface EffectiveProxy {
  url: string | undefined;
  source: ProxySource;
}

export function getEffectiveProxy(): EffectiveProxy {
  const fromConfig = readProxyFromConfig();
  if (fromConfig) return { url: fromConfig, source: 'config' };

  const fromEnv =
    process.env['HTTPS_PROXY'] || process.env['HTTP_PROXY'] ||
    process.env['https_proxy'] || process.env['http_proxy'] ||
    process.env['ALL_PROXY'] || process.env['all_proxy'];
  if (fromEnv) return { url: fromEnv, source: 'env' };

  const fromSystem = readSystemProxy();
  if (fromSystem) return { url: fromSystem, source: 'system' };

  return { url: undefined, source: 'none' };
}

function resolveProxyUrl(): string | undefined {
  return getEffectiveProxy().url;
}

type UndiciModule = {
  ProxyAgent: new (opts: { uri: string; requestTls?: Record<string, unknown> }) => Record<string, unknown>;
  fetch: (url: string | URL, opts?: Record<string, unknown>) => Promise<Response>;
};

let _undici: UndiciModule | null | false = false;

async function loadUndici(): Promise<UndiciModule | null> {
  if (_undici !== false) return _undici;
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const load = new Function('id', 'return import(id)') as (id: string) => Promise<UndiciModule>;
    _undici = await load('undici');
  } catch {
    _undici = null;
  }
  return _undici;
}

/**
 * Fetch wrapper that routes through proxy when configured.
 * Uses undici's own fetch + ProxyAgent for reliable proxy support.
 * Forces TLSv1.2 max to bypass Cloudflare JA3/JA4 TLS fingerprint blocking.
 * Drop-in replacement for global fetch().
 */
export async function proxyFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const proxyUrl = resolveProxyUrl();
  if (!proxyUrl) return fetch(url, init);

  const undici = await loadUndici();
  if (!undici) return fetch(url, init);

  const agent = new undici.ProxyAgent({
    uri: proxyUrl,
    requestTls: { maxVersion: 'TLSv1.2' },
  });
  const opts: Record<string, unknown> = { ...init, dispatcher: agent };
  return undici.fetch(url, opts) as unknown as Response;
}
