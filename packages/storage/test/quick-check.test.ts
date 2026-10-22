/**
 * M0 回归：数据库完整性探针。
 *
 * 为什么需要它：`audit_logs` / `execution_stream_logs` 的坏页不会影响按主键点查，
 * 所以应用表面完全正常，直到某个功能做全表扫描（导出、统计、保留策略）才抛
 * SQLITE_CORRUPT —— 那时已经很难定位到"库坏了"。
 *
 * 本文件锁三件事：
 *   1. 健康的库 → ok=true
 *   2. 根本不是数据库的文件 → ok=false 且把错误**带出来**（不是吞掉/抛出）
 *   3. 真实的 b-tree 坏页 → ok=false
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openSqlite, closeSqlite, quickCheckDatabase } from '../src/sqlite-storage.js';

let tempDir: string;

beforeEach(() => {
  closeSqlite();
  tempDir = mkdtempSync(join(tmpdir(), 'markus-quickcheck-'));
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('quickCheckDatabase', () => {
  it('健康的库返回 ok=true', () => {
    const db = openSqlite(join(tempDir, 'healthy.db'));
    const health = quickCheckDatabase(db);
    expect(health.ok).toBe(true);
    expect(health.errors).toEqual([]);
    expect(health.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('不是数据库的文件 → ok=false，错误被带出而不是抛出', () => {
    const path = join(tempDir, 'not-a-db.bin');
    writeFileSync(path, Buffer.alloc(4096, 0x41)); // "AAAA..." 没有 SQLite 头
    const db = new DatabaseSync(path);
    const health = quickCheckDatabase(db);
    expect(health.ok).toBe(false);
    expect(health.errors.length).toBeGreaterThan(0);
    db.close();
  });

  it('真实的坏页 → ok=false（把 b-tree 页写成垃圾）', () => {
    const src = join(tempDir, 'src.db');
    const db = openSqlite(src);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    const ins = db.prepare('INSERT INTO t (v) VALUES (?)');
    for (let i = 0; i < 400; i += 1) ins.run('x'.repeat(200));
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const pageSize = (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
    closeSqlite();

    // 破坏第 4 页（前几页是 header / sqlite_master / t 的根页），保留文件头。
    const target = join(tempDir, 'broken.db');
    copyFileSync(src, target);
    const buf = readFileSync(target);
    const start = pageSize * 3;
    buf.fill(0xff, start, Math.min(start + pageSize, buf.length));
    writeFileSync(target, buf);

    const broken = new DatabaseSync(target);
    const health = quickCheckDatabase(broken);
    expect(health.ok).toBe(false);
    expect(health.errors.join(' ')).toMatch(/malformed|btreeInitPage|corrupt/i);
    broken.close();
  });
});
