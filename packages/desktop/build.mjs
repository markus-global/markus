#!/usr/bin/env node

/**
 * Bundle the Electron main/preload scripts + markus backend into distributable form.
 * Uses esbuild to produce a single-file main process bundle.
 */

import { build } from 'esbuild';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

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

  // Windows shortcuts need build/icon.ico. Generate a Vista+ PNG-in-ICO from
  // icon.png when missing so electron-builder win.icon always resolves.
  const icoPath = resolve(__dirname, 'build/icon.ico');
  const pngPath = resolve(__dirname, 'build/icon.png');
  if (!existsSync(icoPath)) {
    console.log('  Generating build/icon.ico from icon.png...');
    const png = readFileSync(pngPath);
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(1, 4);
    const entry = Buffer.alloc(16);
    entry[0] = 0; // 256
    entry[1] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(22, 12);
    writeFileSync(icoPath, Buffer.concat([header, entry, png]));
  }
  if (!existsSync(icoPath)) {
    throw new Error('build/icon.ico missing — Windows shortcuts would have no brand icon');
  }

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

  // Chrome extension zip — required for Settings download; fail the build if missing
  console.log('  Ensuring Chrome extension zip...');
  const { execSync } = await import('node:child_process');
  const ensureScript = resolve(__dirname, '../../scripts/ensure-chrome-extension-zip.mjs');
  execSync(`node "${ensureScript}" --copy-to "${resolve(__dirname, 'dist')}"`, {
    cwd: resolve(__dirname, '../..'),
    stdio: 'inherit',
  });
  if (!existsSync(resolve(__dirname, 'dist/markus-browser-extension.zip'))) {
    throw new Error('Chrome extension zip missing after pack — browser extension download would 404');
  }
  console.log('  Chrome extension zip copied');

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
