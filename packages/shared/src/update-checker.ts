import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { APP_VERSION } from './version.js';

const NPM_PACKAGE = '@markus-global/cli';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS = 5_000;

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  checkedAt: string;
}

interface CacheEntry {
  latestVersion: string;
  checkedAt: string;
}

function getCachePath(): string {
  const dir = join(homedir(), '.markus');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, '.update-check-cache.json');
}

function readCache(): CacheEntry | null {
  try {
    const cachePath = getCachePath();
    if (!existsSync(cachePath)) return null;
    const data = JSON.parse(readFileSync(cachePath, 'utf-8')) as CacheEntry;
    const age = Date.now() - new Date(data.checkedAt).getTime();
    if (age > CACHE_TTL_MS) return null;
    return data;
  } catch {
    return null;
  }
}

function writeCache(entry: CacheEntry): void {
  try {
    writeFileSync(getCachePath(), JSON.stringify(entry), 'utf-8');
  } catch { /* best-effort */ }
}

function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(`https://registry.npmjs.org/${NPM_PACKAGE}/latest`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json() as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Check if a newer version of Markus is available on npm.
 * Results are cached for 24 hours. Never throws.
 */
export async function checkForUpdate(): Promise<UpdateInfo> {
  const currentVersion = APP_VERSION;

  // Try cache first
  const cached = readCache();
  if (cached) {
    return {
      currentVersion,
      latestVersion: cached.latestVersion,
      updateAvailable: compareVersions(cached.latestVersion, currentVersion) > 0,
      checkedAt: cached.checkedAt,
    };
  }

  // Fetch from npm registry
  const latestVersion = await fetchLatestVersion();
  if (!latestVersion) {
    return {
      currentVersion,
      latestVersion: currentVersion,
      updateAvailable: false,
      checkedAt: new Date().toISOString(),
    };
  }

  const entry: CacheEntry = { latestVersion, checkedAt: new Date().toISOString() };
  writeCache(entry);

  return {
    currentVersion,
    latestVersion,
    updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
    checkedAt: entry.checkedAt,
  };
}
