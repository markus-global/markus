#!/usr/bin/env node
/**
 * Markus 数据库维护工具（M0 修复 + M1/M2/M4 外置回填 + M5 清理）。
 *
 * 设计纪律：
 *  - **默认 dry-run**：externalize / prune 不加 --apply 只报告，不改数据。
 *  - **recover 永不覆盖原库**：输出到新文件，逐表比对行数后才告诉你下一步。
 *  - 不猜路径：默认 ~/.markus/data.db，可用 --db 覆盖。
 *
 * 用法：
 *   node scripts/db-maintenance.mjs check
 *   node scripts/db-maintenance.mjs externalize            # 只报告
 *   node scripts/db-maintenance.mjs externalize --apply
 *   node scripts/db-maintenance.mjs prune --days 30        # 只报告
 *   node scripts/db-maintenance.mjs prune --days 30 --apply
 *   node scripts/db-maintenance.mjs recover                # 只报告可恢复情况
 *   node scripts/db-maintenance.mjs recover --apply
 */
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const out = { _: [], apply: false, days: 30, only: null, db: null, blobs: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--days') out.days = Number(argv[++i]);
    else if (a === '--only') out.only = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--db') out.db = argv[++i];
    else if (a === '--blobs') out.blobs = argv[++i];
    else if (a.startsWith('--')) { console.error(`未知参数: ${a}`); process.exit(2); }
    else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
const dbPath = args.db ?? join(homedir(), '.markus', 'data.db');
const blobRoot = args.blobs ?? join(homedir(), '.markus', 'blobs');

if (!cmd || !['check', 'externalize', 'prune', 'recover'].includes(cmd)) {
  console.error('用法: node scripts/db-maintenance.mjs <check|externalize|prune|recover> [--apply] [--days N] [--only tbl] [--db path]');
  process.exit(2);
}
if (!existsSync(dbPath)) {
  console.error(`找不到数据库: ${dbPath}`);
  process.exit(2);
}

const mb = n => `${(n / 1048576).toFixed(1)} MB`;

function loadStorage() {
  const candidates = [
    '../packages/storage/dist/index.js',
    '../packages/storage/src/index.ts',
  ];
  for (const rel of candidates) {
    try { return require(rel); } catch { /* try next */ }
  }
  console.error('无法加载 @markus/storage —— 请先 `pnpm --filter @markus/storage build`');
  process.exit(1);
}

const storage = loadStorage();

if (cmd === 'check') {
  const db = storage.openSqlite(dbPath);
  console.log(`数据库: ${dbPath} (${mb(statSync(dbPath).size)})`);
  const health = storage.quickCheckDatabase(db, 10);
  if (health.ok) {
    console.log(`✅ 完整性检查通过（${health.elapsedMs} ms）`);
  } else {
    console.log(`❌ 发现损坏（${health.elapsedMs} ms）：`);
    for (const e of health.errors) console.log(`   ${e}`);
    console.log('\n下一步: node scripts/db-maintenance.mjs recover   # 先看可恢复情况');
  }
  process.exit(health.ok ? 0 : 1);
}

if (cmd === 'externalize') {
  const db = storage.openSqlite(dbPath);
  const store = new storage.BlobStore(blobRoot);
  console.log(`数据库: ${dbPath} (${mb(statSync(dbPath).size)})`);
  console.log(`blob 目录: ${blobRoot}`);
  console.log(args.apply ? '模式: 应用' : '模式: dry-run（不改数据，加 --apply 才执行）');
  const res = storage.externalizeLargeFields(db, {
    store, dryRun: !args.apply, only: args.only ?? undefined,
    onProgress: ({ table, externalized }) => { if (externalized > 0) console.log(`  ${table}: 已外置 ${externalized}`); },
  });
  console.log('\n按表:');
  for (const [t, s] of Object.entries(res.byTable)) {
    console.log(`  ${t.padEnd(22)} 扫描 ${String(s.scanned).padStart(7)}  外置 ${String(s.externalized).padStart(7)}  省 ${mb(s.bytesSaved)}`);
  }
  console.log(`\n合计: 扫描 ${res.scanned}，外置 ${res.externalized}，行内字节 ${mb(res.bytesBefore)} → ${mb(res.bytesAfter)}`);
  if (res.errors.length) {
    console.log(`⚠ ${res.errors.length} 条失败（数据未改动）:`);
    for (const e of res.errors.slice(0, 10)) console.log(`   ${e}`);
  }
  if (!args.apply) console.log('\n这是 dry-run。确认无误后加 --apply 执行。');
  process.exit(res.errors.length ? 1 : 0);
}

if (cmd === 'prune') {
  const db = storage.openSqlite(dbPath);
  console.log(`数据库: ${dbPath} (${mb(statSync(dbPath).size)})`);
  console.log(args.apply ? '模式: 应用' : '模式: dry-run（不改数据，加 --apply 才执行）');
  const res = storage.pruneTerminalMailboxItems(db, { olderThanDays: args.days, dryRun: !args.apply });
  console.log(`终态且超过 ${args.days} 天的邮件项: ${res.candidates} 条，约 ${mb(res.bytes)}`);
  if (!args.apply) {
    console.log('\n这是 dry-run。确认无误后加 --apply 执行。');
  } else {
    console.log(`已删除 ${res.deleted} 条${res.vacuumed ? '，并执行了 incremental_vacuum' : ''}。`);
    console.log('提示: auto_vacuum=0 的库不会立刻缩小，需要 VACUUM 才能把空间还给文件系统。');
  }
  process.exit(0);
}

if (cmd === 'recover') {
  const size = statSync(dbPath).size;
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const outPath = `${dbPath}.recovered-${stamp}`;
  console.log(`源库: ${dbPath} (${mb(size)})`);
  console.log(`输出: ${outPath}`);

  const probe = spawnSync('sqlite3', ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    console.error('找不到 sqlite3 命令行工具 —— .recover 只能由官方 CLI 提供，请先安装。');
    process.exit(1);
  }

  if (!args.apply) {
    console.log('\n干跑：将执行 `sqlite3 <db> .recover > <out>`，逐表比对行数，原库不改名、不删除。');
    console.log('确认后加 --apply。');
    process.exit(0);
  }

  console.log('正在恢复（17 GB 量级可能需要几分钟）…');
  const run = spawnSync('sqlite3', [dbPath, '.recover'], { encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 });
  if (run.status !== 0 && !run.stdout?.length) {
    console.error(`恢复失败: ${run.stderr?.toString() ?? 'unknown'}`);
    process.exit(1);
  }
  writeFileSync(outPath, run.stdout);
  console.log(`已写出 ${mb(statSync(outPath).size)}`);

  // 逐表比对行数：只报告，不自动切换
  const src = storage.openSqlite(dbPath);
  const dst = storage.openSqlite(outPath);
  const tables = src.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
  let diffs = 0;
  console.log('\n表名                         源         恢复         差异');
  for (const t of tables) {
    const count = db => { try { return db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n; } catch { return 'ERR'; } };
    const a = count(src); const b = count(dst);
    const d = (typeof a === 'number' && typeof b === 'number') ? a - b : '?';
    if (d !== 0) diffs += 1;
    console.log(`${t.padEnd(26)} ${String(a).padStart(10)} ${String(b).padStart(12)} ${String(d).padStart(8)}`);
  }
  console.log(`\n${diffs === 0 ? '✅ 所有表行数一致' : `⚠ ${diffs} 张表行数不一致 —— 请先看差异再决定是否切换`}`);
  console.log(`原库未被修改。切换方式（人工确认后执行）:`);
  console.log(`  mv "${dbPath}" "${dbPath}.corrupt-${stamp}" && mv "${outPath}" "${dbPath}"`);
  process.exit(diffs === 0 ? 0 : 1);
}
