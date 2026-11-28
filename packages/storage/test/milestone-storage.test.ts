/**
 * Milestone data layer — the upgrade path is the point of this file.
 *
 * Owner requirement (2026-11-28): **旧版本数据必须能完美兼容升级**. So the first test does not
 * start from a fresh DB: it builds a LEGACY `requirements` table (pre-`milestone_id`), opens it
 * with the real storage entry point, and asserts (a) the column and its index appear, (b) old
 * rows read back as "unassigned", (c) the repo writes/clears the new field.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openSqlite, closeSqlite, SqliteRequirementRepo, SqliteMilestoneRepo } from '../src/sqlite-storage.js';

let tempDir: string;
let dbPath: string;

beforeEach(() => {
  closeSqlite();
  tempDir = mkdtempSync(join(tmpdir(), 'markus-milestone-'));
  dbPath = join(tempDir, 'data.db');
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

/** Build a v0.12.x-shaped requirements table: everything except milestone_id. */
function createLegacyDb(path: string, withRow: boolean): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE requirements (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      project_id TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      priority TEXT NOT NULL DEFAULT 'medium',
      source TEXT NOT NULL DEFAULT 'user',
      created_by TEXT NOT NULL,
      approved_by TEXT,
      approved_at TEXT,
      rejected_reason TEXT,
      rejected_by TEXT,
      tags TEXT DEFAULT '[]',
      goal_config TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  if (withRow) {
    db.prepare(
      "INSERT INTO requirements (id, org_id, project_id, title, description, status, priority, source, created_by, tags, created_at, updated_at) VALUES ('req_legacy', 'default', 'proj_legacy', 'Legacy req', 'd', 'in_progress', 'medium', 'user', 'usr_owner', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')"
    ).run();
  }
  db.close();
}

/**
 * FK is enforced at the DB level too (`milestones.project_id REFERENCES projects(id)`), so a
 * milestone cannot be persisted into a non-existent project even if the service guard were
 * bypassed — that is the structural backstop, and the fixture has to satisfy it honestly.
 */
function seedOrgAndProject(db: DatabaseSync, projectId: string): void {
  db.prepare("INSERT OR IGNORE INTO organizations (id, name, owner_id) VALUES ('default', 'Default', 'usr_owner')").run();
  db.prepare("INSERT OR IGNORE INTO projects (id, org_id, name) VALUES (?, 'default', ?)").run(projectId, projectId);
}

describe('legacy database upgrade', () => {  it('adds requirements.milestone_id + its index, and keeps old rows readable as unassigned', async () => {
    createLegacyDb(dbPath, true);
    const db = openSqlite(dbPath);
    seedOrgAndProject(db, 'proj_legacy');

    const columns = (db.prepare('PRAGMA table_info(requirements)').all() as Array<{ name: string }>).map(c => c.name);
    expect(columns).toContain('milestone_id');

    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='requirements'").all() as Array<{ name: string }>)
      .map(i => i.name);
    expect(indexes).toContain('idx_requirements_milestone');

    // The upgrade must not rewrite data: the pre-existing row survives and reads as unassigned.
    const repo = new SqliteRequirementRepo(db);
    const legacy = repo.findById('req_legacy');
    expect(legacy).toBeDefined();
    expect(legacy!.title).toBe('Legacy req');
    expect(legacy!.milestoneId).toBeNull();

    // Creating a milestone on the upgraded DB works (new table exists after upgrade).
    const milestones = new SqliteMilestoneRepo(db);
    const created = await milestones.create({
      id: 'ms_1', orgId: 'default', projectId: 'proj_legacy', name: 'Upgraded', dueDate: '2026-12-31',
    });
    expect(created.id).toBe('ms_1');
  });
});

describe('milestone repo + requirement link', () => {
  it('round-trips dueDate (including null), orders by creation, and detaches only members', async () => {
    const db = openSqlite(dbPath);
    seedOrgAndProject(db, 'proj_a');

    const milestones = new SqliteMilestoneRepo(db);
    await milestones.create({ id: 'ms_a', orgId: 'default', projectId: 'proj_a', name: 'A', description: 'desc', dueDate: '2026-05-01' });
    await milestones.create({ id: 'ms_b', orgId: 'default', projectId: 'proj_a', name: 'B' });

    expect(milestones.findById('ms_a')!.dueDate).toBe('2026-05-01');
    expect(milestones.findById('ms_b')!.dueDate).toBeNull();
    expect(milestones.listByProject('proj_a').map(m => m.id)).toEqual(['ms_a', 'ms_b']);

    const reqs = new SqliteRequirementRepo(db);
    const create = (id: string, milestoneId?: string) =>
      reqs.create({ id, orgId: 'default', title: id, description: '', source: 'user', createdBy: 'usr_owner', projectId: 'proj_a', milestoneId });

    await create('req_1', 'ms_a');
    await create('req_2', 'ms_a');
    await create('req_3', 'ms_b');
    await create('req_4');

    // Clearing the date is an explicit null, not "leave as is".
    await milestones.update('ms_a', { dueDate: null });
    expect(milestones.findById('ms_a')!.dueDate).toBeNull();

    expect(reqs.detachMilestone('ms_a')).toEqual(['req_1', 'req_2']);
    expect(reqs.findById('req_1')!.milestoneId).toBeNull();
    // Requirements are NOT deleted, and other milestones are untouched.
    expect(reqs.findById('req_1')).toBeDefined();
    expect(reqs.findById('req_3')!.milestoneId).toBe('ms_b');
    expect(reqs.findById('req_4')!.milestoneId).toBeNull();
  });
});
