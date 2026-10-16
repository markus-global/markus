/**
 * 审批幂等键 `appliedAt` / `appliedIntent` 的持久化回归。
 *
 * 背景（卡片 tsk_7146396ecdaf4246b4812cbe §5 持久化落地）：审批「已应用」幂等键
 * 必须真落库，而不是只活在 hitl-service 的内存里。否则进程重启后幂等失效 →
 * 同一审批被二次应用（双写）。本文件用**真实** SqliteApprovalRepo（非 fake repo）
 * 锁死两件事：
 *
 *   1. 往返（重启可读）：写入带 appliedAt 的审批 → 关闭并重开数据库（等价进程重启）
 *      → 重新构造 repo 实例 → get()/list() 读回 appliedAt 非空且等于写入值。
 *   2. 冲突路径（本卡最关键的一处）：先 upsert 一次（appliedAt 为空），再 upsert 同一
 *      id 且带 appliedAt —— 若 `ON CONFLICT DO UPDATE SET` 漏了
 *      `applied_at = excluded.applied_at`，则首次 INSERT 有值、后续写被静默丢弃
 *      （内存有、库没有），而 fake repo 单测照样绿。此处必须读回已落库的值。
 *
 * 另附一条既有库补列回归：旧 approvals 表（无 applied_at/applied_intent）经
 * openSqlite 升级后必须补齐两列（对应迁移表改动）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openSqlite, closeSqlite, SqliteApprovalRepo, type ApprovalRow } from '../src/sqlite-storage.js';

let tempDir: string;
let dbPath: string;

beforeEach(() => {
  closeSqlite();
  tempDir = mkdtempSync(join(tmpdir(), 'markus-approval-applied-at-'));
  dbPath = join(tempDir, 'approvals.db');
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

/** 最小可用审批行；appliedAt / appliedIntent 由各用例按需覆盖。 */
function baseApproval(id: string, overrides: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    id,
    agentId: 'agent-1',
    agentName: 'Worker',
    type: 'custom',
    title: 'Deploy to prod?',
    description: 'Ready for production',
    details: { env: 'prod' },
    status: 'pending',
    requestedAt: '2026-10-15T10:00:00.000Z',
    ...overrides,
  };
}

describe('SqliteApprovalRepo — appliedAt 持久化', () => {
  it('往返：写入 appliedAt 后关闭重开（进程重启），get()/list() 仍读回同一值', () => {
    const appliedAt = '2026-10-15T12:34:56.789Z';
    const db = openSqlite(dbPath);
    const repo = new SqliteApprovalRepo(db);
    repo.upsert(baseApproval('appr-roundtrip', { appliedAt, appliedIntent: 'approve' }));

    // 模拟进程重启：关闭连接 → 用同一 db 文件重新打开 → 重新构造 repo 实例。
    closeSqlite();
    const db2 = openSqlite(dbPath);
    const repo2 = new SqliteApprovalRepo(db2);

    const viaGet = repo2.get('appr-roundtrip');
    expect(viaGet?.appliedAt).toBeTruthy();
    expect(viaGet?.appliedAt).toBe(appliedAt);
    expect(viaGet?.appliedIntent).toBe('approve');

    const viaList = repo2.list().find(a => a.id === 'appr-roundtrip');
    expect(viaList?.appliedAt).toBe(appliedAt);
    expect(viaList?.appliedIntent).toBe('approve');
  });

  it('冲突路径：先 upsert（appliedAt 空）再 upsert 同 id（带 appliedAt），appliedAt 必须落库', () => {
    const appliedAt = '2026-10-15T13:00:00.000Z';
    const db = openSqlite(dbPath);
    const repo = new SqliteApprovalRepo(db);

    // 首次写入：INSERT 路径，appliedAt 为空。
    repo.upsert(baseApproval('appr-conflict'));
    expect(repo.get('appr-conflict')?.appliedAt).toBeUndefined();

    // 第二次写入同一 id：走 ON CONFLICT DO UPDATE SET 路径。
    repo.upsert(baseApproval('appr-conflict', { appliedAt, appliedIntent: 'request_changes' }));

    // 同一连接读回：claim 的写没有被静默丢弃。
    expect(repo.get('appr-conflict')?.appliedAt).toBe(appliedAt);
    expect(repo.get('appr-conflict')?.appliedIntent).toBe('request_changes');

    // 关闭重开再读：证明是落库而非内存假象。
    closeSqlite();
    const db2 = openSqlite(dbPath);
    const repo2 = new SqliteApprovalRepo(db2);
    const row = repo2.get('appr-conflict');
    expect(row?.appliedAt).toBe(appliedAt);
    expect(row?.appliedIntent).toBe('request_changes');
  });

  it('既有库升级：旧 approvals 表（无两列）经 openSqlite 后补齐 applied_at/applied_intent 且旧行保留', () => {
    // 1) 用改动前的 schema 手工构造「既有库」。
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'custom',
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        details TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending',
        requested_at TEXT NOT NULL DEFAULT (datetime('now')),
        responded_at TEXT,
        responded_by TEXT,
        response_comment TEXT,
        expires_at TEXT,
        options TEXT,
        allow_freeform INTEGER NOT NULL DEFAULT 0,
        selected_option TEXT,
        approver_user_ids TEXT,
        target_user_id TEXT,
        questions TEXT,
        answers TEXT
      )
    `);
    legacy
      .prepare(
        `INSERT INTO approvals (id, agent_id, agent_name, type, title, description, details, status, requested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('appr-legacy', 'agent-1', 'Worker', 'custom', 'Legacy', '', '{}', 'pending', '2026-10-01T00:00:00.000Z');
    legacy.close();

    // 2) 升级：不得抛异常，且两列补齐。
    const db = openSqlite(dbPath);
    const cols = (db.prepare('PRAGMA table_info(approvals)').all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('applied_at');
    expect(cols).toContain('applied_intent');

    // 3) 旧行保留，新列读回为 undefined；写入 appliedAt 后走冲突路径同样落库。
    const repo = new SqliteApprovalRepo(db);
    expect(repo.get('appr-legacy')?.title).toBe('Legacy');
    expect(repo.get('appr-legacy')?.appliedAt).toBeUndefined();

    const appliedAt = '2026-10-15T14:00:00.000Z';
    repo.upsert(baseApproval('appr-legacy', { title: 'Legacy', appliedAt, appliedIntent: 'reject' }));
    expect(repo.get('appr-legacy')?.appliedAt).toBe(appliedAt);
    expect(repo.get('appr-legacy')?.appliedIntent).toBe('reject');
  });
});
