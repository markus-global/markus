import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function findVersion(): string {
  const candidates = [
    resolve(__dirname, '..', 'package.json'),             // npm global: dist/ → ../package.json
    resolve(__dirname, '..', '..', '..', 'package.json'),  // monorepo: packages/shared/dist/ → root
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, 'utf-8')).version; } catch { /* skip */ }
    }
  }
  return '0.0.0';
}

export const APP_VERSION: string = findVersion();
