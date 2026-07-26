import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compareVersions } from '../src/update-checker.js';

describe('compareVersions (semver-aware)', () => {
  it('compares numeric core', () => {
    expect(compareVersions('0.9.0', '0.8.5')).toBe(1);
    expect(compareVersions('0.8.5', '0.9.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.8.10', '0.8.9')).toBe(1); // not string compare
  });

  it('treats a prerelease as lower than the same stable core', () => {
    expect(compareVersions('0.8.5-rc.0', '0.8.5')).toBe(-1);
    expect(compareVersions('0.8.5', '0.8.5-rc.0')).toBe(1);
    // The bug this fixes: rc users must be told about the stable release.
    expect(compareVersions('0.8.5', '0.8.5-rc.0') > 0).toBe(true);
  });

  it('orders prerelease identifiers numerically, not lexically', () => {
    expect(compareVersions('1.0.0-rc.10', '1.0.0-rc.2')).toBe(1);
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1);
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha')).toBe(1); // more identifiers wins
  });

  it('numeric identifiers sort below alphanumeric ones', () => {
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1);
    expect(compareVersions('1.0.0-alpha', '1.0.0-1')).toBe(1);
  });

  it('ignores build metadata and leading v', () => {
    expect(compareVersions('1.2.3+build.5', '1.2.3+build.9')).toBe(0);
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
  });
});

describe('checkForUpdate', () => {
  let cacheDir: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'markus-update-test-'));
    previousHome = process.env.HOME;
    process.env.HOME = cacheDir;
    vi.resetModules();
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    vi.unstubAllGlobals();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('returns cached result when cache is fresh', async () => {
    const markusDir = join(cacheDir, '.markus');
    mkdirSync(markusDir, { recursive: true });
    writeFileSync(
      join(markusDir, '.update-check-cache.json'),
      JSON.stringify({ latestVersion: '9.9.9', checkedAt: new Date().toISOString() }),
      'utf-8',
    );

    const { checkForUpdate } = await import('../src/update-checker.js');
    const info = await checkForUpdate();
    expect(info.latestVersion).toBe('9.9.9');
    expect(info.updateAvailable).toBe(true);
  });

  it('fetches from npm when cache is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: '1.0.0' }),
      }),
    );

    const { checkForUpdate } = await import('../src/update-checker.js');
    const info = await checkForUpdate();
    expect(info.latestVersion).toBe('1.0.0');
    expect(info.checkedAt).toBeTruthy();
  });

  it('returns current version when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const { checkForUpdate } = await import('../src/update-checker.js');
    const info = await checkForUpdate();
    expect(info.updateAvailable).toBe(false);
    expect(info.latestVersion).toBe(info.currentVersion);
  });

  it('ignores expired cache and refetches', async () => {
    const markusDir = join(cacheDir, '.markus');
    mkdirSync(markusDir, { recursive: true });
    const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    writeFileSync(
      join(markusDir, '.update-check-cache.json'),
      JSON.stringify({ latestVersion: '0.0.1', checkedAt: staleDate }),
      'utf-8',
    );

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: '2.0.0' }),
      }),
    );

    const { checkForUpdate } = await import('../src/update-checker.js');
    const info = await checkForUpdate();
    expect(info.latestVersion).toBe('2.0.0');
  });
});
