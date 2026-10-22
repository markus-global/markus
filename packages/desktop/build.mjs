#!/usr/bin/env node

/**
 * Bundle the Electron main/preload scripts + markus backend into distributable form.
 * Uses esbuild to produce a single-file main process bundle.
 */

import { build } from 'esbuild';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
// §26 — 目录拷贝的唯一实现（镜像）。两处模板/web-ui 拷贝改走它，消除重复实现。
import { syncDir } from '../../scripts/sync-dir.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const external = [
  'electron',
  'electron-updater',
  'node:sqlite',
  'sharp',
  'rfb2',
  'ws',
  'node-datachannel',
  'node-pty',
];

async function main() {
  // `-e` 的源码走**一个命令行参数**，上限由最紧的平台决定，而最紧的是 Windows：
  // CreateProcess 整条命令行 32767 字符（Linux 单参数 128 KB、macOS 1 MB）。
  // 留 15% 余量给可执行文件路径与环境变量的拼接。
  const WINDOWS_ARGV_BUDGET = 28_000;
  // 后台修复工人：单独打一份 CJS 文本，**内联进主包**。
  //
  // 为什么不用独立入口文件：这里的 electron-builder 只 `files: dist/**`，而 esbuild
  // 只有 main/preload 两个 entry —— `@markus/storage` 是内联进 main 的，
  // 所以 `dist/repair-worker.js` 从来不存在。运行时 `new URL('./repair-worker.js',
  // import.meta.url)` 会解析到 `app.asar/dist/repair-worker.js`，
  // spawn 得到 MODULE_NOT_FOUND；detached + stdio:'ignore' 让它在三次重启里完全不可见
  // （实测：`ELECTRON_RUN_AS_NODE=1 Markus <asar>/dist/repair-worker.js` → Cannot find module, exit=1）。
  //
  // 内联成源码字符串后走 `-e`，这条路径已由健康探针在打包后的 Electron 里实测可用。
  console.log('  Bundling repair worker (inline)...');
  const workerBuild = await build({
    entryPoints: [resolve(__dirname, '../storage/src/repair-worker.ts')],
    bundle: true,
    write: false,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    external: ['node:sqlite', 'electron'],
    conditions: ['node', 'import'],
    resolveExtensions: ['.ts', '.js', '.mjs', '.json'],
    logLevel: 'silent',
  });
  const repairWorkerSource = workerBuild.outputFiles?.[0]?.text ?? '';
  if (repairWorkerSource.length < 2000) {
    throw new Error(`repair worker bundle too small (${repairWorkerSource.length} B) — worker would be a no-op`);
  }
  // `-e` 的源码是**一个命令行参数**，所以真正的上限由最紧的那个平台决定：
  //   Windows CreateProcess 整条命令行 32767 字符 ← 最紧
  //   Linux 单参数 128 KB（MAX_ARG_STRLEN）· macOS 1 MB
  // 原来按 Linux 的 128 KB 留余量写成 100 KB，那等于**在 Windows 上必炸**却不会有
  // 任何构建期提示。现在按 Windows 定预算并留 15% 余量。
  if (repairWorkerSource.length > WINDOWS_ARGV_BUDGET) {
    throw new Error(
      `repair worker bundle too large for -e (${repairWorkerSource.length} B > ${WINDOWS_ARGV_BUDGET} B): `
      + 'Windows caps the whole command line at 32767 chars — ship it as a file instead',
    );
  }
  if (/require\(["']@markus\//.test(repairWorkerSource)) {
    throw new Error('repair worker bundle has unresolved workspace imports — it would crash in the packaged app');
  }
  console.log(`  Repair worker inlined (${Math.round(repairWorkerSource.length / 1024)} KB)`);

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
      // 后台修复工人的源码（见文件开头的说明）。缺失时 storage 会抛 repair-worker-missing。
      __REPAIR_WORKER_SOURCE__: JSON.stringify(repairWorkerSource),
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
  // §26 — syncDir 内部即「先清再拷」。web-ui 资源名带内容 hash，vite 只清自己的
  // dist，管不到这里；不清会每构建一次攒一批旧 chunk（实测曾攒到 235.8 MB 打进 app.asar）。
  if (syncDir(webUiDist, webUiDest)) {
    console.log('  Copied Web UI static assets (mirrored).');
  }

  // Copy templates
  const templatesRoot = resolve(__dirname, '../../templates');
  const templatesDest = resolve(__dirname, 'dist/templates');
  // §26 — 镜像：先清再拷，否则源里删掉的模板会永远留在包里。
  if (syncDir(templatesRoot, templatesDest)) {
    console.log('  Copied templates (mirrored).');
  }

  // Copy docs — shipped so an installed agent can actually read the platform docs that
  // templates/roles/HANDBOOK.md points at. §26 — mirrored. `images/` is GitHub README art
  // (~7 MB) and has no use in the bundle, so it is excluded.
  const docsRoot = resolve(__dirname, '../../docs');
  const docsDest = resolve(__dirname, 'dist/docs');
  if (syncDir(docsRoot, docsDest, { ignore: ['images'] })) {
    console.log('  Copied docs (mirrored, images excluded).');
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
