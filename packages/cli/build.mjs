#!/usr/bin/env node

import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outfile = resolve(__dirname, 'dist', 'markus.mjs');

// Native / binary modules that cannot be bundled
const external = [
  'better-sqlite3',
  'sharp',
  'rfb2',
  'ws',
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
    target: 'node20',
    format: 'esm',
    external,
    banner: {
      js: [
        '#!/usr/bin/env node',
        "import { createRequire } from 'module';",
        'const require = createRequire(import.meta.url);',
      ].join('\n'),
    },
    sourcemap: false,
    minify: false,
    treeShaking: true,
    // Resolve workspace:* packages from the monorepo
    conditions: ['node', 'import'],
    resolveExtensions: ['.ts', '.js', '.mjs', '.json'],
  });

  // Step 3: Copy templates into dist/ so they ship with the npm package
  const templatesRoot = resolve(__dirname, '../../templates');
  const templatesDest = resolve(__dirname, 'templates');
  if (existsSync(templatesRoot)) {
    console.log('  Copying templates...');
    mkdirSync(templatesDest, { recursive: true });
    cpSync(templatesRoot, templatesDest, { recursive: true });
  }

  // Step 4: Copy pre-built Web UI into dist/ for static serving
  const webUiDist = resolve(__dirname, '../web-ui/dist');
  const webUiDest = resolve(__dirname, 'dist', 'web-ui');
  if (existsSync(webUiDist)) {
    console.log('  Copying Web UI static assets...');
    mkdirSync(webUiDest, { recursive: true });
    cpSync(webUiDist, webUiDest, { recursive: true });
  } else {
    console.log('  Web UI not built — skipping static assets (run pnpm --filter @markus/web-ui build first)');
  }

  console.log(`  Done → ${outfile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
