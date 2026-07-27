#!/usr/bin/env node
/**
 * Ensure packages/chrome-extension/dist/markus-browser-extension.zip exists.
 * Prints the absolute path on success; exits non-zero on failure.
 *
 * Usage:
 *   node scripts/ensure-chrome-extension-zip.mjs
 *   node scripts/ensure-chrome-extension-zip.mjs --copy-to <dir>
 */
import { cpSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const EXT_DIR = join(ROOT, 'packages', 'chrome-extension');
const ZIP = join(EXT_DIR, 'dist', 'markus-browser-extension.zip');

function ensureZip() {
  if (existsSync(ZIP) && statSync(ZIP).size > 0) return ZIP;

  if (!existsSync(join(EXT_DIR, 'package.json'))) {
    console.error(`Chrome extension package not found at ${EXT_DIR}`);
    process.exit(1);
  }

  console.error('Packing Chrome extension…');
  // Keep script stdout clean (callers may capture the path); stream pack logs to stderr.
  execSync('pnpm run pack', { cwd: EXT_DIR, stdio: ['ignore', 'inherit', 'inherit'] });

  if (!existsSync(ZIP) || statSync(ZIP).size === 0) {
    console.error(`Failed to produce ${ZIP}`);
    process.exit(1);
  }
  return ZIP;
}

const zipPath = ensureZip();
const sizeKb = (statSync(zipPath).size / 1024).toFixed(1);
console.error(`Chrome extension zip ready: ${zipPath} (${sizeKb} KB)`);

const copyIdx = process.argv.indexOf('--copy-to');
if (copyIdx >= 0) {
  const destDir = process.argv[copyIdx + 1];
  if (!destDir) {
    console.error('--copy-to requires a directory');
    process.exit(1);
  }
  mkdirSync(destDir, { recursive: true });
  const dest = join(resolve(destDir), 'markus-browser-extension.zip');
  cpSync(zipPath, dest);
  console.error(`Copied → ${dest}`);
}

// Last line on stdout is the absolute path (for scripting).
console.log(zipPath);
