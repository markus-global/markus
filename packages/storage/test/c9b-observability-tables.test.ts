/**
 * C9-B — observation tables are history, not state.
 *
 * Two contracts are asserted here, both by behaviour on a real SQLite file:
 *
 *   1. **Schema** — the four observation tables (`agent_activities`,
 *      `agent_activity_logs`, `execution_stream_logs`, `task_logs`) gain a
 *      nullable `work_unit_ref` + index. An existing (pre-cut-9) database is
 *      upgraded by `ALTER TABLE ... ADD COLUMN`, keeps every row, and leaves the
 *      new column NULL — no backfill, because a backfilled identity would be a
 *      second history of "which turn produced this row".
 *
 *   2. **New write paths carry the identity** — activity rows write the ref the
 *      producer already holds; activity log lines inherit it from their activity
 *      (a log cannot belong to a different WorkUnit than the activity that
 *      emitted it); task logs / execution stream rows write the caller's ref.
 *
 * Companion contract (no read path may answer "is it running" from a missing
 * `ended_at`) is enforced by `scripts/architecture-guard.mjs` and by
 * `packages/web-ui/src/lib/workUnitLiveness.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
  openSqlite,
  closeSqlite,
  SqliteActivityRepo,
  SqliteAgentRepo,
  SqliteExecutionStreamRepo,
  SqliteOrgRepo,
  SqliteTaskLogRepo,
} from '../src/sqlite-storage.js';

let tempDir: string;
let dbPath: string;

beforeEach(() => {
  closeSqlite();
  tempDir = mkdtempSync(join(tmpdir(), 'markus-c9b-obs-'));
  dbPath = join(tempDir, 'data.db');
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

const OBSERVATION_TABLES = [
  'agent_activities',
  'agent_activity_logs',
  'execution_stream_logs',
  'task_logs',
] as const;

function columnNames(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name);
}

function indexNames(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>;
  return rows.map(r => r.name);
}

/**
 * A database in the *pre-cut-9* shape: the four observation tables exist with
 * the columns they had before this cut, and they hold rows. Nothing else is
 * needed — `openSqlite` builds the rest of the schema itself.
 */
function createLegacyDatabase(): void {
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE agent_activities (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      mailbox_item_id TEXT,
      type TEXT NOT NULL,
      label TEXT NOT NULL,
      task_id TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      total_tokens INTEGER DEFAULT 0,
      total_tools INTEGER DEFAULT 0,
      success INTEGER DEFAULT 1,
      summary TEXT DEFAULT '',
      keywords TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE agent_activity_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      metadata TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE execution_stream_logs (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      type TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      metadata TEXT DEFAULT '{}',
      execution_round INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE task_logs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      type TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      metadata TEXT DEFAULT '{}',
      execution_round INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO agent_activities (id, agent_id, type, label, started_at, ended_at)
      VALUES ('act-legacy-zombie', 'agt_x', 'chat', 'legacy zombie row', '2026-11-01T00:00:00Z', NULL),
             ('act-legacy-done', 'agt_x', 'task', 'legacy finished row', '2026-11-01T01:00:00Z', '2026-11-01T01:05:00Z');
    INSERT INTO agent_activity_logs (activity_id, seq, type, content)
      VALUES ('act-legacy-done', 0, 'status', 'Started');
    INSERT INTO execution_stream_logs (id, source_type, source_id, agent_id, seq, type, content)
      VALUES ('esl-legacy-1', 'task', 'tsk_legacy', 'agt_x', 0, 'text', 'hello');
    INSERT INTO task_logs (id, task_id, agent_id, seq, type, content)
      VALUES ('tlog-legacy-1', 'tsk_legacy', 'agt_x', 0, 'text', 'hello');
  `);
  legacy.close();
}

describe('C9-B 老库升级：四张观测表补可空 work_unit_ref + 索引（不回填、不丢数据）', () => {
  it('既有库打开后四表都多出 work_unit_ref，历史行全为 NULL 且一行不少', () => {
    createLegacyDatabase();

    const db = openSqlite(dbPath);

    for (const table of OBSERVATION_TABLES) {
      expect(columnNames(db, table), `${table} 缺 work_unit_ref`).toContain('work_unit_ref');
      expect(indexNames(db, table), `${table} 缺 work_unit_ref 索引`).toContain(`idx_${table}_wu`);
    }

    // 历史行还在，且没有被回填 —— NULL 是「本行早于身份链」的合法取值。
    const activities = db
      .prepare('SELECT id, work_unit_ref FROM agent_activities ORDER BY id')
      .all() as Array<{ id: string; work_unit_ref: string | null }>;
    expect(activities.map(a => a.id)).toEqual(['act-legacy-done', 'act-legacy-zombie']);
    expect(activities.every(a => a.work_unit_ref === null)).toBe(true);

    const counts = {
      agent_activity_logs: (db.prepare('SELECT COUNT(*) AS n FROM agent_activity_logs').get() as { n: number }).n,
      execution_stream_logs: (db.prepare('SELECT COUNT(*) AS n FROM execution_stream_logs').get() as { n: number }).n,
      task_logs: (db.prepare('SELECT COUNT(*) AS n FROM task_logs').get() as { n: number }).n,
    };
    expect(counts).toEqual({ agent_activity_logs: 1, execution_stream_logs: 1, task_logs: 1 });
  });

  it('重复打开同一个库不报错、不重建表、不改动已有数据（迁移幂等）', () => {
    createLegacyDatabase();
    const first = openSqlite(dbPath);
    const before = first.prepare('SELECT id, work_unit_ref FROM agent_activities ORDER BY id').all();
    closeSqlite();

    const second = openSqlite(dbPath);
    const after = second.prepare('SELECT id, work_unit_ref FROM agent_activities ORDER BY id').all();
    expect(after).toEqual(before);
    for (const table of OBSERVATION_TABLES) {
      expect(columnNames(second, table)).toContain('work_unit_ref');
    }
  });
});

describe('C9-B 新写路径带身份：activity / activity_logs / execution stream / task_logs', () => {
  it('activity 写入 work_unit_ref；activity log 从所属 activity 继承同一个 ref', () => {
    const db = openSqlite(dbPath);
    const repo = new SqliteActivityRepo(db);

    repo.insertActivity({
      id: 'act-new-1',
      agentId: 'agt_x',
      type: 'task',
      label: 'Run task',
      startedAt: '2026-11-15T00:00:00Z',
      workUnitRef: 'task_tsk_abc_r2',
    });
    // 没有身份的回合（老链路 / 无 WorkUnit）显式留空，仍然是合法行。
    repo.insertActivity({
      id: 'act-new-noidentity',
      agentId: 'agt_x',
      type: 'heartbeat',
      label: 'Heartbeat',
      startedAt: '2026-11-15T00:01:00Z',
    });
    repo.insertActivityLog({ activityId: 'act-new-1', seq: 0, type: 'status', content: 'Started' });
    repo.insertActivityLog({ activityId: 'act-new-noidentity', seq: 0, type: 'status', content: 'Started' });

    expect(repo.getActivity('act-new-1')?.workUnitRef).toBe('task_tsk_abc_r2');
    expect(repo.getActivity('act-new-noidentity')?.workUnitRef).toBeNull();

    const refs = db
      .prepare('SELECT activity_id, work_unit_ref FROM agent_activity_logs ORDER BY activity_id')
      .all() as Array<{ activity_id: string; work_unit_ref: string | null }>;
    expect(refs).toEqual([
      { activity_id: 'act-new-1', work_unit_ref: 'task_tsk_abc_r2' },
      { activity_id: 'act-new-noidentity', work_unit_ref: null },
    ]);
  });

  it('execution stream 与 task log 写入调用方给的 ref（不自己再推一遍）', () => {
    const db = openSqlite(dbPath);
    const stream = new SqliteExecutionStreamRepo(db);
    const taskLogs = new SqliteTaskLogRepo(db);

    // task_logs.task_id 有外键，先造组织/agent/任务三行（真实链路里它们本来就在）。
    new SqliteOrgRepo(db).createOrg({ id: 'org-1', name: 'Test Org', ownerId: 'user-1', plan: 'pro', maxAgents: 20 });
    new SqliteAgentRepo(db).create({
      id: 'agt_x',
      name: 'Worker',
      orgId: 'org-1',
      roleId: 'role-1',
      roleName: 'Developer',
      agentRole: 'worker',
      skills: [],
      llmConfig: {},
      computeConfig: {},
      heartbeatIntervalMs: 30000,
    });
    db.prepare(
      "INSERT INTO tasks (id, org_id, title, status, priority, assigned_agent_id, reviewer_agent_id, created_at, updated_at) " +
        "VALUES ('tsk_abc', 'org-1', 'Task', 'in_progress', 'medium', 'agt_x', '', datetime('now'), datetime('now'))",
    ).run();

    stream.append({
      sourceType: 'task',
      sourceId: 'tsk_abc',
      agentId: 'agt_x',
      seq: 0,
      type: 'text',
      content: 'working',
      executionRound: 2,
      workUnitRef: 'task_tsk_abc_r2',
    });
    stream.append({
      sourceType: 'chat',
      sourceId: 'msg_1',
      agentId: 'agt_x',
      seq: 0,
      type: 'text',
      content: 'hi',
    });
    stream.flush();

    const streamRefs = db
      .prepare('SELECT source_id, work_unit_ref FROM execution_stream_logs ORDER BY source_id')
      .all() as Array<{ source_id: string; work_unit_ref: string | null }>;
    expect(streamRefs).toEqual([
      { source_id: 'msg_1', work_unit_ref: null },
      { source_id: 'tsk_abc', work_unit_ref: 'task_tsk_abc_r2' },
    ]);

    taskLogs.append({
      taskId: 'tsk_abc',
      agentId: 'agt_x',
      seq: 0,
      type: 'text',
      content: 'working',
      executionRound: 2,
      workUnitRef: 'task_tsk_abc_r2',
    });
    const taskLogRef = db
      .prepare("SELECT work_unit_ref FROM task_logs WHERE task_id = 'tsk_abc'")
      .get() as { work_unit_ref: string | null };
    expect(taskLogRef.work_unit_ref).toBe('task_tsk_abc_r2');
  });
});

describe('C9-B 删机制：不再有「收口僵尸 activity」的后台改状态路径', () => {
  it('activityRepo 不再暴露 closeOrphansAgainstTerminalMailbox', () => {
    const db = openSqlite(dbPath);
    const repo = new SqliteActivityRepo(db);
    // 「未结束」是这条事件自身的属性，不是状态。曾经有个 sweep 帮它补写 ended_at，
    // 好让「ended_at 为空 = 还在跑」这个错误读法看起来成立；读法删了，sweep 也必须删。
    expect((repo as unknown as Record<string, unknown>)['closeOrphansAgainstTerminalMailbox']).toBeUndefined();
  });
});
