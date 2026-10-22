/**
 * 自动备份的生命周期回归。
 *
 * 规则只有一句：**自动备份只在它所保护的升级被证明完成之前存在。**
 *
 * 「证明完成」= 库能只读打开 + `data_migrations` 里没有非终态的行。
 * 满足后在**下一次启动**（还没有进程打开库的窗口）删除它自己生成的备份，
 * 用户的 `data.db.bak-*` 一个都不碰。
 *
 * 这里锁的都是**不许删**的情形 —— 删错了没有第二次机会：
 *   1. 迁移还在跑 → 不删（升级没完成）
 *   2. 有「需要重建 / 上次失败」标记 → 不删（当前状态不健康）
 *   3. 备份比活库还新（时间戳更晚）→ 不删（可能是正在进行的那一份）
 *   4. 不是自己生成的命名 → 不删（用户手备份）
 *   5. 幂等：第二次什么都不删
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { pruneSupersededBackups, prepareDatabaseFile } from '../src/index.js';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'markus-prune-'));
  dbPath = join(dir, 'data.db');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** 造一个健康的活库；`migrations` 决定 data_migrations 的内容。 */
function makeDb(migrations?: Array<{ id: string; status: string }>): void {
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  db.exec('INSERT INTO t (v) VALUES (\'a\')');
  if (migrations) {
    db.exec(`CREATE TABLE data_migrations (
      id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending',
      cursor INTEGER NOT NULL DEFAULT 0, processed INTEGER NOT NULL DEFAULT 0,
      total INTEGER, last_error TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    const ins = db.prepare('INSERT INTO data_migrations (id, status) VALUES (?, ?)');
    for (const m of migrations) ins.run(m.id, m.status);
  }
  db.close();
}

/** 造一份「自己生成的」备份，mtime 早于活库。返回路径。 */
function makeBackup(stamp: string, opts: { older?: boolean; bytes?: string } = {}): string {
  const p = `${dbPath}.backup-${stamp}`;
  writeFileSync(p, opts.bytes ?? 'backup-bytes');
  if (opts.older !== false) {
    const past = new Date(Date.now() - 60_000);
    utimesSync(p, past, past);
  }
  return p;
}

describe('pruneSupersededBackups', () => {
  it('迁移全部完成 → 删掉自己生成的备份（含 -wal/-shm），不碰用户手备份', () => {
    makeDb([{ id: '001', status: 'done' }, { id: '002', status: 'done' }]);
    const b1 = makeBackup('20261021135947');
    const b2 = makeBackup('20261021145517');
    writeFileSync(`${b2}-wal`, 'wal');
    writeFileSync(`${b2}-shm`, 'shm');
    const manual = join(dir, 'data.db.bak-before-upgrade');
    writeFileSync(manual, 'user-owned');

    const r = pruneSupersededBackups(dbPath);

    expect(r.deleted).toContain(b1);
    expect(r.deleted).toContain(b2);
    expect(r.deleted).toContain(`${b2}-wal`);
    expect(r.deleted).toContain(`${b2}-shm`);
    expect(existsSync(b1)).toBe(false);
    expect(existsSync(b2)).toBe(false);
    expect(existsSync(`${b2}-wal`)).toBe(false);
    expect(existsSync(`${b2}-shm`)).toBe(false);
    expect(existsSync(manual)).toBe(true);
    expect(r.bytesFreed).toBeGreaterThan(0);
  });

  it('迁移还在跑 → 一个都不删（升级未完成）', () => {
    makeDb([{ id: '001', status: 'done' }, { id: '002', status: 'running' }]);
    const b = makeBackup('20261021145517');

    const r = pruneSupersededBackups(dbPath);

    expect(r.deleted).toEqual([]);
    expect(r.skipped).toMatch(/migration/);
    expect(existsSync(b)).toBe(true);
  });

  it('迁移 pending → 不删', () => {
    makeDb([{ id: '001', status: 'pending' }]);
    const b = makeBackup('20261021145517');

    const r = pruneSupersededBackups(dbPath);

    expect(r.deleted).toEqual([]);
    expect(existsSync(b)).toBe(true);
  });

  it('有「需要重建」标记 → 不删（当前状态不健康，备份还要用）', () => {
    makeDb([{ id: '001', status: 'done' }]);
    const b = makeBackup('20261021145517');
    writeFileSync(`${dbPath}.repair-needed.json`, JSON.stringify({ reason: 'corrupt' }));

    const r = pruneSupersededBackups(dbPath);

    expect(r.deleted).toEqual([]);
    expect(r.skipped).toMatch(/repair-needed/);
    expect(existsSync(b)).toBe(true);
  });

  it('有「上次修复失败」标记 → 不删', () => {
    makeDb([{ id: '001', status: 'done' }]);
    const b = makeBackup('20261021145517');
    writeFileSync(`${dbPath}.repair-failed.json`, JSON.stringify({ reason: 'x' }));

    const r = pruneSupersededBackups(dbPath);

    expect(r.deleted).toEqual([]);
    expect(existsSync(b)).toBe(true);
  });

  it('备份比活库还新 → 不删（可能正在写的那一份）', () => {
    makeDb([{ id: '001', status: 'done' }]);
    const future = new Date(Date.now() + 60_000);
    const b = makeBackup('20990101000000', { older: false });
    utimesSync(b, future, future);

    const r = pruneSupersededBackups(dbPath);

    expect(r.deleted).toEqual([]);
    expect(existsSync(b)).toBe(true);
  });

  it('不是自己生成的命名 → 一个都不删', () => {
    makeDb([{ id: '001', status: 'done' }]);
    const odd = `${dbPath}.backup-handmade`;
    writeFileSync(odd, 'x');
    const older = new Date(Date.now() - 60_000);
    utimesSync(odd, older, older);

    const r = pruneSupersededBackups(dbPath);

    expect(r.deleted).toEqual([]);
    expect(existsSync(odd)).toBe(true);
  });

  it('幂等：第二次什么都不删', () => {
    makeDb([{ id: '001', status: 'done' }]);
    makeBackup('20261021145517');

    expect(pruneSupersededBackups(dbPath).deleted).toHaveLength(1);
    expect(pruneSupersededBackups(dbPath).deleted).toHaveLength(0);
  });

  it('没有 data_migrations 表（全新库/极旧库）→ 视为升级已完成，可删', () => {
    makeDb(undefined);
    const b = makeBackup('20261021145517');

    const r = pruneSupersededBackups(dbPath);

    expect(r.deleted).toEqual([b]);
  });

  it('库打不开（损坏到无法只读打开）→ 不删', () => {
    writeFileSync(dbPath, 'not-a-database'.repeat(100));
    const b = makeBackup('20261021145517');

    const r = pruneSupersededBackups(dbPath);

    expect(r.deleted).toEqual([]);
    expect(r.skipped).toBeTruthy();
    expect(existsSync(b)).toBe(true);
  });

  it('被 prepareDatabaseFile 调用：健康库启动时自动清理，无需人工', async () => {
    makeDb([{ id: '001', status: 'done' }]);
    const b = makeBackup('20261021145517');

    await prepareDatabaseFile(dbPath, { log: () => {} });

    expect(existsSync(b)).toBe(false);
    expect(existsSync(dbPath)).toBe(true);
  });
});
