/**
 * Background-callback lineage must be DURABLE.
 *
 * Defect background: the launching turn's scenario / work-unit identity used to
 * live only in parallel in-memory maps on the Agent. A restart orphaned every
 * persisted `pending_callbacks` row from its lineage, so completions fell back
 * to the heartbeat reflex pack (no task tools) and landed on no entity.
 *
 * The fix writes lineage into the ONE durable store (this table). These tests
 * pin: (1) the roundtrip, (2) the auto-migration on a pre-existing database,
 * (3) legacy rows without the columns stay readable — no data rewrite.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSqlite, closeSqlite, SqlitePendingCallbackRepo } from '../src/sqlite-storage.js';
import type { DatabaseSync } from 'node:sqlite';

let dir: string;
let dbPath: string;
let db: DatabaseSync;
let repo: SqlitePendingCallbackRepo;

beforeEach(() => {
  closeSqlite();
  dir = mkdtempSync(join(tmpdir(), 'cb-lineage-'));
  dbPath = join(dir, 'data.db');
  db = openSqlite(dbPath);
  repo = new SqlitePendingCallbackRepo(db);
});
afterEach(() => {
  closeSqlite();
  rmSync(dir, { recursive: true, force: true });
});

const bgRow = (id: string) => ({
  id,
  agentId: 'agt_a',
  originSessionId: 'task_t1_r1',
  type: 'background_exec',
  originScenario: 'task_execution',
  workUnitRef: 'task:tsk_1#round=2',
  registeredAt: Date.now(),
  timeoutMs: 600_000,
});

describe('pending_callbacks lineage columns', () => {
  it('originScenario + workUnitRef survive save → loadAll', () => {
    repo.save(bgRow('cb_1'));
    const loaded = repo.loadAll().find(r => r.id === 'cb_1');
    expect(loaded?.originScenario).toBe('task_execution');
    expect(loaded?.workUnitRef).toBe('task:tsk_1#round=2');
    expect(loaded?.originSessionId).toBe('task_t1_r1');
  });

  it('rows saved without lineage load as undefined (legacy shape, no crash)', () => {
    repo.save({
      id: 'cb_plain', agentId: 'agt_a', originSessionId: 'sess_1',
      type: 'background_exec', registeredAt: 1, timeoutMs: 2,
    });
    const loaded = repo.loadAll().find(r => r.id === 'cb_plain');
    expect(loaded).toBeDefined();
    expect(loaded?.originScenario).toBeUndefined();
    expect(loaded?.workUnitRef).toBeUndefined();
  });

  it('auto-migration adds the columns to a PRE-EXISTING database and keeps old rows readable', () => {
    // Simulate a database written by the old build: drop the new columns and
    // insert a row through the old shape, then reopen — openSqlite must migrate.
    db.exec('ALTER TABLE pending_callbacks DROP COLUMN origin_scenario');
    db.exec('ALTER TABLE pending_callbacks DROP COLUMN work_unit_ref');
    db.prepare(
      `INSERT INTO pending_callbacks (id, agent_id, origin_session_id, type, delivery_mode, registered_at, timeout_ms)
       VALUES ('cb_legacy', 'agt_a', 'sess_old', 'background_exec', 'in_session', 1, 2)`,
    ).run();
    closeSqlite();

    db = openSqlite(dbPath);
    repo = new SqlitePendingCallbackRepo(db);

    const legacy = repo.loadAll().find(r => r.id === 'cb_legacy');
    expect(legacy).toBeDefined();
    expect(legacy?.originSessionId).toBe('sess_old');
    expect(legacy?.originScenario).toBeUndefined();
    expect(legacy?.workUnitRef).toBeUndefined();

    // And the migrated table accepts new lineage writes.
    repo.save(bgRow('cb_new'));
    const fresh = repo.loadAll().find(r => r.id === 'cb_new');
    expect(fresh?.originScenario).toBe('task_execution');
    expect(fresh?.workUnitRef).toBe('task:tsk_1#round=2');
  });
});
