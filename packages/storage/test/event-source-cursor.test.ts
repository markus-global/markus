/**
 * `event_sources.cursor` / `last_polled_at` —— 真 SQLite，无 fake repo。
 *
 * 锁三件事，每一件都能因为「实现被改坏」而红：
 *  1. **升级不动旧行**（I9 的口径）：老库副本加列后 `cursor` 全为 NULL，是「历史行」而不是「读到 0」；
 *  2. **CAS**：位点只能被「读到哪儿」的那个调用方推进一次，重复/乱序推进是 0 行 no-op；
 *  3. **一列一个问题**：`upsert()`（配置写入）与 `advanceCursor()`（位点写入）互不影响 ——
 *     改配置不会重置位点，推进位点也不会动 config/secret/health。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openSqlite, closeSqlite } from '../src/sqlite-storage.js';
import { SqliteEventSourceRepo } from '../src/thread-store.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'markus-source-cursor-'));
});

afterEach(() => {
  closeSqlite();
  rmSync(dir, { recursive: true, force: true });
});

/** 老库：只有 B2 之前的列（模拟已发布的存量库） */
function createLegacyDb(path: string, rows: Array<{ id: string; prefix: string }>): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE event_sources (
      id         TEXT PRIMARY KEY,
      org_id     TEXT NOT NULL,
      prefix     TEXT NOT NULL,
      secret     TEXT,
      config     TEXT DEFAULT '{}',
      health     TEXT DEFAULT '{}',
      created_at INTEGER NOT NULL,
      UNIQUE(org_id, prefix)
    );
  `);
  for (const r of rows) {
    db.prepare(`INSERT INTO event_sources (id, org_id, prefix, secret, config, health, created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(r.id, 'org_1', r.prefix, 's3cr3t', '{"repos":["a/b"]}', '{"fails":1}', 1000);
  }
  db.close();
}

describe('升级：加列不迁移数据（旧行位点 = NULL = 从未拉取过）', () => {
  it('老库升级后两列存在，且旧行 cursor 为 NULL、其余列一字未动', () => {
    const path = join(dir, 'markus.db');
    createLegacyDb(path, [{ id: 'src_old', prefix: 'gh' }]);

    const db = openSqlite(path);
    const cols = (db.prepare('PRAGMA table_info(event_sources)').all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('cursor');
    expect(cols).toContain('last_polled_at');

    const repo = new SqliteEventSourceRepo(db);
    const row = repo.getById('src_old')!;
    expect(row.cursor).toBeNull();
    expect(row.lastPolledAt).toBeNull();
    // 旧数据一字未动（B2 只做加法）
    expect(row.prefix).toBe('gh');
    expect(row.secret).toBe('s3cr3t');
    expect(row.config).toEqual({ repos: ['a/b'] });
    expect(row.health).toEqual({ fails: 1 });
  });

  it('新建来源位点为 NULL（推送式来源没有位点）', () => {
    const db = openSqlite(join(dir, 'markus.db'));
    const repo = new SqliteEventSourceRepo(db);
    const src = repo.upsert({ orgId: 'org_1', prefix: 'xhs' });
    expect(src.cursor).toBeNull();
    expect(src.lastPolledAt).toBeNull();
  });
});

describe('advanceCursor：CAS 推进，只有匹配的期望值才生效', () => {
  it('NULL → p1 生效；再用同样的期望 NULL 推进是 no-op；用 p1 才能推到 p2', () => {
    const db = openSqlite(join(dir, 'markus.db'));
    const repo = new SqliteEventSourceRepo(db);
    const src = repo.upsert({ orgId: 'org_1', prefix: 'rss' });

    expect(repo.advanceCursor({ sourceId: src.id, expectedCursor: null, cursor: 'p1', polledAt: 111 })).toBe(true);
    expect(repo.getById(src.id)!.cursor).toBe('p1');
    expect(repo.getById(src.id)!.lastPolledAt).toBe(111);

    // 重复推进（两个拉取者都以为自己在 NULL 上）→ 第二次是 no-op，位点不回退
    expect(repo.advanceCursor({ sourceId: src.id, expectedCursor: null, cursor: 'p1', polledAt: 222 })).toBe(false);
    expect(repo.getById(src.id)!.cursor).toBe('p1');

    expect(repo.advanceCursor({ sourceId: src.id, expectedCursor: 'p1', cursor: 'p2', polledAt: 333 })).toBe(true);
    expect(repo.getById(src.id)!.cursor).toBe('p2');
  });

  it('不存在的来源 → false，不抛错', () => {
    const db = openSqlite(join(dir, 'markus.db'));
    const repo = new SqliteEventSourceRepo(db);
    expect(repo.advanceCursor({ sourceId: 'src_nope', expectedCursor: null, cursor: 'p1', polledAt: 1 })).toBe(false);
  });

  it('推进位点不影响 config/secret/health；反过来 upsert 配置也不重置位点', () => {
    const db = openSqlite(join(dir, 'markus.db'));
    const repo = new SqliteEventSourceRepo(db);
    const src = repo.upsert({ orgId: 'org_1', prefix: 'im', secret: 's3cr3t', config: { policy: { acceptKinds: ['mention'] } } });

    repo.advanceCursor({ sourceId: src.id, expectedCursor: null, cursor: 'p9', polledAt: 42 });
    let row = repo.getById(src.id)!;
    expect(row.cursor).toBe('p9');
    expect(row.secret).toBe('s3cr3t');
    expect(row.config).toEqual({ policy: { acceptKinds: ['mention'] } });

    repo.upsert({ orgId: 'org_1', prefix: 'im', config: { refPrefixes: ['im:'] } });
    row = repo.getById(src.id)!;
    expect(row.cursor).toBe('p9'); // 位点不是配置，改配置不该动它
    expect(row.lastPolledAt).toBe(42);
    expect(row.config).toEqual({ policy: { acceptKinds: ['mention'] }, refPrefixes: ['im:'] });
  });
});
