#!/usr/bin/env node

/**
 * Bundle the Electron main/preload scripts + markus backend into distributable form.
 * Uses esbuild to produce a single-file main process bundle.
 */

import { build } from 'esbuild';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpSync, existsSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const external = [
  'electron',
  'electron-updater',
  'node:sqlite',
  'sharp',
  'rfb2',
  'ws',
  'node-datachannel',
];

async function main() {
  console.log('  Building Electron main process...');
  await build({
    entryPoints: [resolve(__dirname, 'src/main.ts')],
    outfile: resolve(__dirname, 'dist/main.js'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    external,
    banner: {
      js: [
        "import { createRequire as _createRequire } from 'module';",
        'const require = _createRequire(import.meta.url);',
      ].join('\n'),
    },
    inject: [resolve(__dirname, 'src/shims.js')],
    sourcemap: true,
    minify: false,
    treeShaking: true,
    conditions: ['node', 'import'],
    resolveExtensions: ['.ts', '.js', '.mjs', '.json'],
    define: {
      'process.env.MARKUS_MAS': JSON.stringify(process.env.MARKUS_MAS || 'false'),
    },
  });

  console.log('  Building preload script...');
  await build({
    entryPoints: [resolve(__dirname, 'src/preload.ts')],
    outfile: resolve(__dirname, 'dist/preload.js'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    external: ['electron'],
    sourcemap: true,
    minify: false,
  });

  // Copy splash.html and icon
  cpSync(resolve(__dirname, 'src/splash.html'), resolve(__dirname, 'dist/splash.html'));
  cpSync(resolve(__dirname, 'build/icon.png'), resolve(__dirname, 'dist/icon.png'));

  // Copy web-ui dist if available
  const webUiDist = resolve(__dirname, '../web-ui/dist');
  const webUiDest = resolve(__dirname, 'dist/web-ui');
  if (existsSync(webUiDist)) {
    console.log('  Copying Web UI static assets...');
    mkdirSync(webUiDest, { recursive: true });
    cpSync(webUiDist, webUiDest, { recursive: true });
  }

  // Copy templates
  const templatesRoot = resolve(__dirname, '../../templates');
  const templatesDest = resolve(__dirname, 'dist/templates');
  if (existsSync(templatesRoot)) {
    console.log('  Copying templates...');
    mkdirSync(templatesDest, { recursive: true });
    cpSync(templatesRoot, templatesDest, { recursive: true });
  }

  // Copy Chrome extension zip (build it first if needed)
  const extDir = resolve(__dirname, '../chrome-extension');
  const extZip = resolve(extDir, 'dist/markus-browser-extension.zip');
  if (!existsSync(extZip) && existsSync(resolve(extDir, 'pack.mjs'))) {
    console.log('  Building Chrome extension zip...');
    const { execSync } = await import('node:child_process');
    try { execSync('node pack.mjs', { cwd: extDir, stdio: 'inherit' }); } catch { /* non-critical */ }
  }
  if (existsSync(extZip)) {
    cpSync(extZip, resolve(__dirname, 'dist/markus-browser-extension.zip'));
    console.log('  Chrome extension zip copied');
  } else {
    console.warn('  ⚠ Chrome extension zip not found — browser extension download will be unavailable');
  }

  // Copy model catalog data (baseline + supplements)
  const coreDataDir = resolve(__dirname, '../core/data');
  const dataDest = resolve(__dirname, 'dist/data');
  if (existsSync(coreDataDir)) {
    mkdirSync(dataDest, { recursive: true });
    for (const f of ['model-catalog-baseline.json', 'model-catalog-supplements.json']) {
      const src = resolve(coreDataDir, f);
      if (existsSync(src)) cpSync(src, resolve(dataDest, f));
    }
    console.log('  Model catalog data copied');
  }

  console.log('  Done → dist/main.js + dist/preload.js');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
