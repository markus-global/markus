/**
 * 临时诊断脚本（定位完删除）：Windows 上「健康探测」到底卡在哪一步。
 *
 * 背景：CI 的 windows-latest 上 packages/storage/test/repair.test.ts 有 8/11 个
 * 用例 60 秒超时，而通过的 3 个恰好都是不走健康探测的。本脚本把探针单独拿出来
 * 逐步计时，把「慢」和「不返回」区分开 —— 这是日志里读不出来的东西。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const { probeDatabaseHealthInChild, buildProbeSpawnSpec, deriveProbeTimeoutMs } = await import(
  '../packages/storage/dist/health-probe.js'
);
const { prepareDatabaseFile } = await import('../packages/storage/dist/repair.js');

const dir = mkdtempSync(join(tmpdir(), 'diag-'));
const dbPath = join(dir, 'healthy.db');

const db = new DatabaseSync(dbPath);
db.exec('CREATE TABLE keep(id INTEGER PRIMARY KEY, v TEXT)');
const ins = db.prepare('INSERT INTO keep(id, v) VALUES (?, ?)');
for (let i = 1; i <= 300; i++) ins.run(i, 'x');
db.close();

const t = (label, fn) =>
  fn().then(
    (r) => console.log(`[${label}] ${r.elapsed ?? '?'}ms →`, JSON.stringify(r).slice(0, 200)),
    (e) => console.log(`[${label}] THREW`, String(e).slice(0, 200)),
  );

const spec = buildProbeSpawnSpec(dbPath);
console.log('[spec] command =', spec.command);
console.log('[spec] args[0] =', spec.args[0], '| source chars =', spec.args[1].length, '| arg count =', spec.args.length);
console.log('[spec] derived probe timeout =', deriveProbeTimeoutMs(dbPath), 'ms');

// ① 裸 spawn：子进程能不能起来、会不会退出、有没有输出？
await new Promise((resolve) => {
  const t0 = Date.now();
  const child = spawn(spec.command, spec.args, spec.options);
  let out = '';
  let err = '';
  child.stdout?.on('data', (d) => { out += d.toString(); });
  child.stderr?.on('data', (d) => { err += d.toString(); });
  child.on('error', (e) => { console.log('[raw] error', String(e).slice(0, 200)); });
  child.on('close', (code) => {
    console.log(`[raw] closed code=${code} after ${Date.now() - t0}ms | stdout=${JSON.stringify(out.slice(0, 80))} | stderr=${JSON.stringify(err.slice(0, 200))}`);
    resolve();
  });
  setTimeout(() => {
    console.log(`[raw] STILL RUNNING after 15000ms | stdout=${JSON.stringify(out.slice(0, 80))} | stderr=${JSON.stringify(err.slice(0, 200))}`);
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    resolve();
  }, 15_000);
});

// ② 封装后的探针（给它 10 秒预算，看它是否按时返回）
await t('probeDatabaseHealthInChild', () => probeDatabaseHealthInChild(dbPath, 10_000));

// ③ 完整启动路径
await t('prepareDatabaseFile', () => prepareDatabaseFile(dbPath, { probeTimeoutMs: 10_000 }));

rmSync(dir, { recursive: true, force: true });
console.log('[done]');
process.exit(0);
