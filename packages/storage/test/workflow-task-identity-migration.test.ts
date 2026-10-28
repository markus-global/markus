/**
 * 旧库升级守卫：把历史工作流任务的 in-band 身份搬进结构列。
 *
 * 这是"从前只能靠文本推断"到"结构列"的唯一过渡点，也是**最后一次**读
 * `notes` 里的 `step: <id>` 标记。如果这条迁移错了，老用户的 DAG 会永久显示
 * "步骤未匹配"——而新代码里已经没有任何 fallback 可以兜住，所以它必须被测住。
 */
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrateWorkflowTaskIdentity } from '../src/migration-runner.js';

function freshDb() {
  const db = new DatabaseSync(':memory:');
  // 迁移的前置条件：结构升级（ALTER）已经跑过，两列已存在。
  // 这里如实建模，避免"迁移替 schema 兜底"的假通过。
  db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, notes TEXT, workflow_run_id TEXT, workflow_step_id TEXT)');
  db.exec('CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, task_ids TEXT)');
  return db;
}

function run(db: DatabaseSync, cursor = 0, batchSize = 10) {
  return migrateWorkflowTaskIdentity.run({ db, cursor, batchSize } as never);
}

describe('migrateWorkflowTaskIdentity', () => {
  it('copies run id + step id from the legacy marker into the columns', () => {
    const db = freshDb();
    db.prepare('INSERT INTO workflow_runs (id, task_ids) VALUES (?, ?)')
      .run('wfr_1', JSON.stringify(['t1', 't2']));
    db.prepare('INSERT INTO tasks (id, notes) VALUES (?, ?)')
      .run('t1', JSON.stringify(['[Workflow] demo run #1, step: research']));
    db.prepare('INSERT INTO tasks (id, notes) VALUES (?, ?)')
      .run('t2', JSON.stringify(['[Workflow] demo run #1, step: review']));

    const result = run(db);
    expect(result.processed).toBe(2);
    expect(result.errors).toEqual([]);

    const rows = db.prepare('SELECT id, workflow_run_id, workflow_step_id FROM tasks ORDER BY id').all() as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      { id: 't1', workflow_run_id: 'wfr_1', workflow_step_id: 'research' },
      { id: 't2', workflow_run_id: 'wfr_1', workflow_step_id: 'review' },
    ]);
  });

  it('is idempotent and never overwrites existing values', () => {
    const db = freshDb();
    db.prepare('INSERT INTO tasks (id, notes) VALUES (?, ?)')
      .run('t1', JSON.stringify(['step: legacy']));
    db.prepare('UPDATE tasks SET workflow_run_id = ?, workflow_step_id = ? WHERE id = ?')
      .run('wfr_manual', 'manual-step', 't1');
    db.prepare('INSERT INTO workflow_runs (id, task_ids) VALUES (?, ?)')
      .run('wfr_1', JSON.stringify(['t1']));

    run(db);
    run(db); // 断点续跑/重复执行

    const row = db.prepare('SELECT workflow_run_id, workflow_step_id FROM tasks WHERE id = ?').get('t1') as Record<string, unknown>;
    expect(row['workflow_run_id']).toBe('wfr_manual');
    expect(row['workflow_step_id']).toBe('manual-step');
  });

  it('leaves the step id empty rather than guessing when notes are unreadable', () => {
    const db = freshDb();
    db.prepare('INSERT INTO tasks (id, notes) VALUES (?, ?)').run('t1', 'not json at all');
    db.prepare('INSERT INTO workflow_runs (id, task_ids) VALUES (?, ?)').run('wfr_1', JSON.stringify(['t1']));

    run(db);

    const row = db.prepare('SELECT workflow_run_id, workflow_step_id FROM tasks WHERE id = ?').get('t1') as Record<string, unknown>;
    expect(row['workflow_run_id']).toBe('wfr_1'); // the run link is structural (task_ids), still safe
    expect(row['workflow_step_id']).toBeNull();
  });

  it('is a no-op on a database without workflow runs', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, notes TEXT)');
    const result = run(db);
    expect(result.done).toBe(true);
    expect(result.processed).toBe(0);
  });

  it('walks in batches and reports a resumable cursor', () => {
    const db = freshDb();
    for (let i = 0; i < 5; i++) {
      db.prepare('INSERT INTO workflow_runs (id, task_ids) VALUES (?, ?)')
        .run(`wfr_${i}`, JSON.stringify([`t${i}`]));
      db.prepare('INSERT INTO tasks (id, notes) VALUES (?, ?)')
        .run(`t${i}`, JSON.stringify([`step: s${i}`]));
    }

    const first = run(db, 0, 2);
    expect(first.done).toBe(false);
    expect(first.processed).toBe(2);

    const second = run(db, first.nextCursor, 10);
    expect(second.processed).toBe(3);
  });
});
