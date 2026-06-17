import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('APP_VERSION', () => {
  it('loads version from package.json', async () => {
    const { APP_VERSION } = await import('../src/version.js');
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkgVersion = JSON.parse(readFileSync(pkgPath, 'utf-8')).version as string;
    expect(APP_VERSION).toBe(pkgVersion);
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
