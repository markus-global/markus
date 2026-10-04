#!/usr/bin/env node

import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// §26 — 目录拷贝的唯一实现（镜像语义）。此前这里是 mkdirSync+cpSync 的合并拷贝，
// 导致源 templates/ 里删掉的条目（如退役的 skills/self-evolution）在产物里永存。
import { syncDir } from '../../scripts/sync-dir.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outfile = resolve(__dirname, 'dist', 'markus.mjs');

// Modules that cannot be bundled: native addons and Node.js built-ins
const external = [
  'node:sqlite',
  'sharp',
  'rfb2',
  'ws',
  'node-datachannel',
];

async function main() {
  // Step 1: Compile all workspace packages so TS sources are available
  console.log('  Building workspace packages...');
  execSync('pnpm -r build', { cwd: resolve(__dirname, '../..'), stdio: 'inherit' });

  // Step 2: Bundle CLI + all workspace code into a single ESM file
  console.log('  Bundling CLI...');
  await build({
    entryPoints: [resolve(__dirname, 'src/index.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    external,
    banner: {
      js: [
        '#!/usr/bin/env -S node --disable-warning=ExperimentalWarning',
        "import { createRequire as _createRequire } from 'module';",
        "import { fileURLToPath as _filenameOf } from 'url';",
        "import { dirname as _dirOf } from 'path';",
        'const require = _createRequire(import.meta.url);',
        'var __filename = _filenameOf(import.meta.url);',
        'var __dirname = _dirOf(__filename);',
      ].join('\n'),
    },
    sourcemap: false,
    minify: false,
    treeShaking: true,
    // Resolve workspace:* packages from the monorepo
    conditions: ['node', 'import'],
    resolveExtensions: ['.ts', '.js', '.mjs', '.json'],
  });

  // Step 3: Copy templates into dist/ so they ship with the npm package.
  // §26 — 必须镜像（先清再拷）：合并拷贝会让源里删掉的模板永远留在包里。
  const templatesRoot = resolve(__dirname, '../../templates');
  const templatesDest = resolve(__dirname, 'templates');
  if (syncDir(templatesRoot, templatesDest)) {
    console.log('  Copied templates (mirrored).');
  }

  // Step 4: Copy pre-built Web UI into dist/ for static serving (§26 — 镜像)
  const webUiDist = resolve(__dirname, '../web-ui/dist');
  const webUiDest = resolve(__dirname, 'dist', 'web-ui');
  if (syncDir(webUiDist, webUiDest)) {
    console.log('  Copied Web UI static assets (mirrored).');
  } else {
    console.log('  Web UI not built — skipping static assets (run pnpm --filter @markus/web-ui build first)');
  }

  // Step 5: Ship Chrome extension zip next to markus.mjs (npm + binary layout)
  console.log('  Ensuring Chrome extension zip…');
  const ensureScript = resolve(__dirname, '../../scripts/ensure-chrome-extension-zip.mjs');
  execSync(`node "${ensureScript}" --copy-to "${resolve(__dirname, 'dist')}"`, {
    cwd: resolve(__dirname, '../..'),
    stdio: 'inherit',
  });

  console.log(`  Done → ${outfile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
