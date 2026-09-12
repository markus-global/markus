/**
 * P0 回归：既有数据库（旧 schema，无 claimed_by/lease_until/dedup_key 列）升级时，
 * openSqlite 必须成功完成列迁移 + 后置索引创建，不得在 SCHEMA_SQL 阶段
 * 因 CREATE INDEX 引用尚不存在的列而抛出 no such column 异常。
 *
 * 背景：P0 曾把 idx_mailbox_agent_lease / uq_mailbox_agent_dedup 放进 SCHEMA_SQL，
 * 该段在列迁移（ALTER TABLE ADD COLUMN）之前执行；新库因 CREATE TABLE 直接带新列
 * 而侥幸通过，但旧库（表已存在、列缺失）会在 SCHEMA_SQL 阶段报
 * 'no such column: lease_until'，storage 初始化整体失败 → 登录等接口
 * 全部 503 'Storage not available'。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openSqlite, closeSqlite, SqliteMailboxRepo } from '../src/sqlite-storage.js';

let tempDir: string;
let dbPath: string;

beforeEach(() => {
  closeSqlite();
  tempDir = mkdtempSync(join(tmpdir(), 'markus-legacy-upgrade-'));
  dbPath = join(tempDir, 'legacy.db');
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

const LEGACY_SCHEMA = `
CREATE TABLE IF NOT EXISTS mailbox_items (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 2,
  status TEXT NOT NULL DEFAULT 'queued',
  payload TEXT NOT NULL DEFAULT '{}',
  metadata TEXT DEFAULT '{}',
  queued_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  deferred_until TEXT,
  merged_into TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_mailbox_agent_status ON mailbox_items(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_mailbox_agent_queued ON mailbox_items(agent_id, priority, queued_at);
CREATE INDEX IF NOT EXISTS idx_mailbox_agent_source ON mailbox_items(agent_id, source_type);
`;

describe('openSqlite — 旧库升级（P0 迁移完整性）', () => {
  it('旧 schema 库（无 P0 新列）调用 openSqlite 不抛异常，且迁移出新列 + 后置索引', () => {
    // 1) 用旧版 schema 手工构造一个"既有库"
    const legacy = new DatabaseSync(dbPath);
    for (const stmt of LEGACY_SCHEMA.split(';').map(s => s.trim()).filter(Boolean)) {
      legacy.exec(stmt);
    }
    legacy
      .prepare(
        'INSERT INTO mailbox_items (id, agent_id, source_type, priority, status, payload, metadata, queued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run('legacy-1', 'agt_1', 'message', 2, 'queued', '{}', '{}', '2026-09-01T00:00:00.000Z');
    legacy.close();

    // 2) 重新打开 —— 必须完成迁移而不崩溃
    let db: ReturnType<typeof openSqlite>;
    try {
      db = openSqlite(dbPath);
    } catch (e) {
      throw new Error(`openSqlite 在旧库上升级失败（生产环境表现为登录 503 Storage not available）: ${e}`);
    }

    // 3) 新列已补上
    const cols = db.prepare('PRAGMA table_info(mailbox_items)').all() as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    for (const col of ['claimed_by', 'lease_until', 'dedup_key']) {
      expect(names, `缺少 P0 列 ${col}`).toContain(col);
    }

    // 4) 后置索引已创建（依赖新列）
    const indexRows = db.prepare("PRAGMA index_list('mailbox_items')").all() as Array<{ name: string }>;
    const idxNames = indexRows.map(r => r.name);
    expect(idxNames).toContain('idx_mailbox_agent_lease');
    expect(idxNames).toContain('uq_mailbox_agent_dedup');

    // 5) 旧数据保留且可被认领（P0 claimItem 依赖新列）
    const repo = new SqliteMailboxRepo(db);
    const claimed = repo.claimItem('legacy-1', 'agt_1', '2026-09-13T00:00:00.000Z', '2026-09-12T00:00:00.000Z');
    expect(claimed).toBe(true);
  });

  it('全新库路径依旧正常（回归保护）', () => {
    const db = openSqlite(dbPath);
    const repo = new SqliteMailboxRepo(db);
    const ok = repo.save({
      id: 'new-1',
      agentId: 'agt_1',
      sourceType: 'message',
      priority: 2,
      status: 'queued',
      payload: {},
      metadata: {},
      queuedAt: '2026-09-12T00:00:00.000Z',
      dedupKey: 'dd-1',
    });
    expect(ok).toBe(true);
    expect(
      repo.save({
        id: 'new-2',
        agentId: 'agt_1',
        sourceType: 'message',
        priority: 2,
        status: 'queued',
        payload: {},
        metadata: {},
        queuedAt: '2026-09-12T00:00:00.000Z',
        dedupKey: 'dd-1',
      })
    ).toBe(false); // 幂等键拒绝重复
  });
});