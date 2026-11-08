/**
 * 守卫：`blocked_reason` 必须是**可读回**的事实，而不是 write-only 的列。
 *
 * 这条测试存在的理由（真实事故形态）：那条分支上 `blocked_reason` 列早已存在、
 * `updateBlockState()` 也一直在写，但 `_map` 从不读它 —— 于是重启后 `hold`
 * 静默退化成 `deps`，界面上「有人挂起，等你决定」变成「等依赖，别管我」。
 * 一个只写不读的列，等于这个字段不存在，而且没有任何报错。
 *
 * 所以这里不测「能不能写」，测的是**写进去、关库、重新打开、读出来还是它**。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSqlite, closeSqlite, SqliteOrgRepo, SqliteAgentRepo, SqliteTaskRepo } from '../src/sqlite-storage.js';

let tempDir: string;
let dbPath: string;

beforeEach(() => {
  closeSqlite();
  tempDir = mkdtempSync(join(tmpdir(), 'markus-blocked-reason-'));
  dbPath = join(tempDir, 'test.db');
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

function seed(dbPath: string) {
  const db = openSqlite(dbPath);
  new SqliteOrgRepo(db).createOrg({ id: 'org-1', name: 'Test Org', ownerId: 'user-1' });
  new SqliteAgentRepo(db).create({
    id: 'agent-1', name: 'Worker', orgId: 'org-1', roleId: 'role-1', roleName: 'Developer',
  });
  const taskRepo = new SqliteTaskRepo(db);
  taskRepo.create({
    id: 'tsk-1', orgId: 'org-1', title: 'Blocked card',
    assignedAgentId: 'agent-1', reviewerId: 'agent-1',
  });
  return { db, taskRepo };
}

describe('tasks.blocked_reason — 写入后重新打开数据库仍然读得到', () => {
  it('hold 能跨重启存活（这正是当年丢失的那条事实）', async () => {
    const { db, taskRepo } = seed(dbPath);
    await taskRepo.updateStatus('tsk-1', 'blocked', 'user-1', 'hold');
    closeSqlite();

    const db2 = openSqlite(dbPath);
    const rows = new SqliteTaskRepo(db2).listByOrg('org-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('blocked');
    expect(rows[0]!.blockedReason).toBe('hold');
    void db;
  });

  it('deps 同样能读回，不会被写成 null', async () => {
    const { taskRepo } = seed(dbPath);
    await taskRepo.updateStatus('tsk-1', 'blocked', undefined, 'deps');
    closeSqlite();

    const rows = new SqliteTaskRepo(openSqlite(dbPath)).listByOrg('org-1');
    expect(rows[0]!.blockedReason).toBe('deps');
  });

  it('离开 blocked 时清空缘由 —— 否则下一次挂起会沿用上次的理由', async () => {
    const { taskRepo } = seed(dbPath);
    await taskRepo.updateStatus('tsk-1', 'blocked', undefined, 'hold');
    await taskRepo.updateStatus('tsk-1', 'in_progress', undefined, null);
    closeSqlite();

    const rows = new SqliteTaskRepo(openSqlite(dbPath)).listByOrg('org-1');
    expect(rows[0]!.status).toBe('in_progress');
    expect(rows[0]!.blockedReason).toBeNull();
  });
});

describe('旧库升级 — 没有该列的历史库能自动补列，且旧行读成 null', () => {
  it('迁移后旧行 blockedReason 为 null（交给前端按 blockedBy 回退，行为不变）', async () => {
    // 先造一个「旧库」：正常建库后把列删掉是不可能的，所以反过来 ——
    // 直接构造一张不含 blocked_reason 的 tasks 表，再由 openSqlite 补列。
    const { DatabaseSync } = await import('node:sqlite');
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        priority TEXT NOT NULL DEFAULT 'medium',
        assigned_agent_id TEXT NOT NULL,
        reviewer_agent_id TEXT NOT NULL,
        blocked_by TEXT DEFAULT '[]',
        subtasks TEXT DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    legacy.exec(`INSERT INTO tasks (id, org_id, title, status, assigned_agent_id, reviewer_agent_id, blocked_by)
                 VALUES ('tsk-legacy', 'org-1', 'Legacy', 'blocked', 'agent-1', 'agent-1', '["tsk-2"]')`);
    legacy.close();

    // openSqlite 走迁移清单补上 blocked_reason
    const rows = new SqliteTaskRepo(openSqlite(dbPath)).listByOrg('org-1');
    const legacyRow = rows.find(r => r.id === 'tsk-legacy');
    expect(legacyRow).toBeDefined();
    expect(legacyRow!.status).toBe('blocked');
    // 旧数据没有缘由 —— 前端回退推断，与引入该列之前逐字一致
    expect(legacyRow!.blockedReason ?? null).toBeNull();
    // 依赖信息本身不能被迁移弄丢
    expect(legacyRow!.blockedBy).toEqual(['tsk-2']);
  });
});
