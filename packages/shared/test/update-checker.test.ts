import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
