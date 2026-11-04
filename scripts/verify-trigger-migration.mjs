#!/usr/bin/env node
/**
 * 旧库升级验证：新增表必须「只做加法」，旧数据逐字节不变。
 *
 * 这是 §7「只做加法」硬约束的可执行版本。测的不是「新库能建表」——
 * 新库建表根本不会失败，测它没有意义。测的是**老用户升级那一下**：
 *   ① 升级后新表出现（含 UNIQUE(idempotency_key) 索引）
 *   ② 旧表的每一行、每一个字段都不变
 *   ③ 在新表上幂等语义真的生效（重投 50 次 = 1 行）
 *
 * 用法：node scripts/verify-trigger-migration.mjs
 * 退出码：0 = 全通过；1 = 有失败。
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const { openSqlite, closeSqlite } = await import('../packages/storage/dist/sqlite-storage.js');
const { SqliteTriggerRepo } = await import('../packages/storage/dist/thread-store.js');

const dir = mkdtempSync(join(tmpdir(), 'markus-migrate-'));
const p = join(dir, 'legacy.db');
const rows = [];
const assert = (name, pass, detail) => rows.push({ name, pass, detail });

// ① 造一个「旧库」：只有老表，且带数据（模拟装了半年的用户）
{
  const db = new DatabaseSync(p);
  db.exec(`
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT);
    CREATE TABLE tasks  (id TEXT PRIMARY KEY, title TEXT, status TEXT);
    PRAGMA user_version = 3;
  `);
  db.prepare(`INSERT INTO agents VALUES (?,?,?)`).run('agt_old', '老机器人', '2025-01-01');
  db.prepare(`INSERT INTO tasks  VALUES (?,?,?)`).run('tsk_old', '老任务', 'completed');
  db.close();
}

const dumpCols = (db, table, cols) =>
  JSON.stringify(db.prepare(`SELECT ${cols.join(',')} FROM ${table} ORDER BY id`).all());
const colsOf = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

let before;
let beforeCols;
{
  const db = new DatabaseSync(p, { readOnly: true });
  beforeCols = { agents: colsOf(db, 'agents'), tasks: colsOf(db, 'tasks') };
  before = {
    agents: dumpCols(db, 'agents', beforeCols.agents),
    tasks: dumpCols(db, 'tasks', beforeCols.tasks),
  };
  db.close();
}

// ② 走真实升级路径（与 app 启动时完全同一条代码）
const db = openSqlite(p);

const hasTable = Number(
  db.prepare(`SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='triggers'`).get().c,
);
assert('triggers 表已建', hasTable === 1, `sqlite_master 命中 ${hasTable}`);

const uniqueIdxOn = (db, table, col) => {
  const list = db.prepare(`PRAGMA index_list(${table})`).all();
  for (const idx of list) {
    if (!idx.unique) continue;
    const cols = db.prepare(`PRAGMA index_info(${idx.name})`).all().map((c) => c.name);
    if (cols.length === 1 && cols[0] === col) return idx.name;
  }
  return null;
};
const uniq = uniqueIdxOn(db, 'triggers', 'idempotency_key');
assert('idempotency_key 上有唯一约束', !!uniq, uniq ? `索引 ${uniq}` : '未找到唯一索引');

for (const t of ['agents', 'tasks']) {
  // 只比原有列的**值**：升级可以加列（加法），但不能改已有数据
  const afterCols = colsOf(db, t);
  const lost = beforeCols[t].filter((c) => !afterCols.includes(c));
  assert(`旧表 ${t} 原有列未被删除`, lost.length === 0, lost.length ? `丢了 ${lost.join(',')}` : '原有列完整');
  const after = dumpCols(db, t, beforeCols[t]);
  assert(
    `旧表 ${t} 原有列的值不变`,
    before[t] === after,
    before[t] === after ? '完全一致' : `被改动\n  before=${before[t]}\n  after =${after}`,
  );
}

// ③ 在「升级后的旧库」上验证幂等真的生效
const repo = new SqliteTriggerRepo(db);
for (let i = 0; i < 50; i++) repo.insertOrGet({ kind: 'external', idempotencyKey: 'gh:delivery:x' });
const trigCount = Number(db.prepare(`SELECT COUNT(*) c FROM triggers`).get().c);
assert('重投 50 次 = 1 行（幂等）', trigCount === 1, `实际 ${trigCount} 行`);

closeSqlite();

console.log(`\n旧库升级验证（临时库 ${(statSync(p).size / 1024).toFixed(0)} KB）\n`);
for (const r of rows) console.log(`${r.pass ? '✅' : '❌'} ${r.name}  —  ${r.detail}`);
const failed = rows.filter((r) => !r.pass).length;
console.log(`\n合计：${rows.length - failed} 通过 / ${failed} 失败\n`);
rmSync(dir, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);
