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

/**
 * Semver-aware version comparison.
 *
 * Compares the numeric core (major.minor.patch) first, then applies SemVer
 * prerelease precedence rules:
 *   - A version WITH a prerelease has LOWER precedence than the same core
 *     without one (e.g. `0.8.5-rc.0` < `0.8.5`).
 *   - Prerelease identifiers are compared dot-by-dot: numeric identifiers
 *     compare numerically, alphanumeric ones compare lexically, and numeric
 *     always sorts below alphanumeric. A longer set of identifiers wins when
 *     all preceding ones are equal.
 * Build metadata (everything after `+`) is ignored per the SemVer spec.
 *
 * Returns 1 if a > b, -1 if a < b, 0 if equal.
 */
export function compareVersions(a: string, b: string): number {
  const norm = (v: string) => v.trim().replace(/^v/, '').split('+')[0]!; // strip leading v + build metadata
  const split = (v: string): { core: number[]; pre: string[] } => {
    const [core, pre] = norm(v).split('-', 2) as [string, string | undefined];
    return {
      core: core.split('.').map(n => Number(n) || 0),
      pre: pre ? pre.split('.') : [],
    };
  };

  const va = split(a);
  const vb = split(b);

  // Compare numeric core (major.minor.patch...)
  for (let i = 0; i < Math.max(va.core.length, vb.core.length); i++) {
    const na = va.core[i] ?? 0;
    const nb = vb.core[i] ?? 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }

  // Core equal — apply prerelease precedence
  const aHasPre = va.pre.length > 0;
  const bHasPre = vb.pre.length > 0;
  if (!aHasPre && !bHasPre) return 0;
  if (!aHasPre) return 1;  // a is stable, b is prerelease → a > b
  if (!bHasPre) return -1; // a is prerelease, b is stable → a < b

  // Both have prereleases — compare identifier by identifier
  for (let i = 0; i < Math.max(va.pre.length, vb.pre.length); i++) {
    const ia = va.pre[i];
    const ib = vb.pre[i];
    if (ia === undefined) return -1; // fewer identifiers → lower precedence
    if (ib === undefined) return 1;
    if (ia === ib) continue;
    const numA = /^\d+$/.test(ia);
    const numB = /^\d+$/.test(ib);
    if (numA && numB) {
      const diff = Number(ia) - Number(ib);
      if (diff !== 0) return diff > 0 ? 1 : -1;
    } else if (numA) {
      return -1; // numeric identifiers have lower precedence than alphanumeric
    } else if (numB) {
      return 1;
    } else {
      return ia > ib ? 1 : -1; // lexical ASCII order
    }
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
