/**
 * C9-A · `facts` 表的 DB 层不变量（真实 SQLite，不是 mock）
 *
 * 这里只测**库自己**能不能守住两条规矩，不测业务层：
 *   1. 不可改写 —— 改 value/predicate/主体/身份列必须 `RAISE(ABORT)`；supersede 必须放行；
 *   2. 身份必填 —— work_unit_ref / asserted_by / source_refs_json 空（NULL 或空串）必须拒绝；
 *   3. 一个 subject + predicate 同时只有一条 active（部分唯一索引兜底）。
 *
 * 判据：把 sqlite-storage.ts 里的 FACTS_TRIGGERS_SQL 或 ux_facts_active 删掉，本文件必红。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSqlite, closeSqlite } from '../src/sqlite-storage.js';

let tempDir: string;
let db: ReturnType<typeof openSqlite>;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-facts-schema-'));
  db = openSqlite(join(tempDir, 'test.db'));
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

interface FactRow {
  id: string;
  workUnitRef?: string;
  assertedBy?: string;
  sourceRefs?: string;
  value?: string;
  predicate?: string;
  subjectId?: string;
}

function insert(row: FactRow): void {
  db.prepare(
    `INSERT INTO facts
       (id, subject_kind, subject_id, predicate, value_json,
        work_unit_ref, asserted_by, source_refs_json, created_at)
     VALUES (?, 'task', ?, ?, ?, ?, ?, ?, '2026-11-15T00:00:00.000Z')`,
  ).run(
    row.id,
    row.subjectId ?? 'tsk_1',
    row.predicate ?? 'task.completion_evidence',
    row.value ?? '{"summary":"done","evidence_refs":["dlv_1"]}',
    row.workUnitRef === undefined ? 'task:tsk_1:r1' : row.workUnitRef,
    row.assertedBy === undefined ? 'agt_a' : row.assertedBy,
    row.sourceRefs === undefined ? '["dlv_1"]' : row.sourceRefs,
  );
}

const readBack = (id: string) =>
  db.prepare('SELECT * FROM facts WHERE id = ?').get(id) as Record<string, unknown> | undefined;

describe('facts table exists in the shipped schema', () => {
  it('is created by openSqlite with both guards installed', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'facts'")
      .all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'facts'")
      .all() as Array<{ name: string }>;
    expect(triggers.map(t => t.name).sort()).toEqual(['facts_no_rewrite', 'facts_require_provenance']);
  });
});

describe('invariant 1 — a fact is never rewritten', () => {
  it('rejects UPDATE of value_json', () => {
    insert({ id: 'f1' });
    expect(() => {
      db.prepare("UPDATE facts SET value_json = '{\"summary\":\"rewritten\"}' WHERE id = 'f1'").run();
    }).toThrow(/immutable/);
    expect(JSON.parse(String(readBack('f1')!['value_json']))['summary']).toBe('done');
  });

  it('rejects moving a fact to another subject or predicate (that is a different fact)', () => {
    insert({ id: 'f2' });
    expect(() => {
      db.prepare("UPDATE facts SET predicate = 'task.rejection_reason' WHERE id = 'f2'").run();
    }).toThrow(/immutable/);
    expect(() => {
      db.prepare("UPDATE facts SET subject_id = 'tsk_other' WHERE id = 'f2'").run();
    }).toThrow(/immutable/);
  });

  it('rejects re-attributing identity (asserted_by / work_unit_ref / source_refs)', () => {
    insert({ id: 'f3' });
    expect(() => {
      db.prepare("UPDATE facts SET asserted_by = 'agt_someone_else' WHERE id = 'f3'").run();
    }).toThrow(/immutable/);
    expect(() => {
      db.prepare("UPDATE facts SET source_refs_json = '[\"dlv_999\"]' WHERE id = 'f3'").run();
    }).toThrow(/immutable/);
    expect(() => {
      db.prepare("UPDATE facts SET work_unit_ref = 'task:other:r7' WHERE id = 'f3'").run();
    }).toThrow(/immutable/);
  });

  it('allows supersede — value survives, only the marker moves', () => {
    insert({ id: 'f4' });
    // f4 与后面那条同 subject+predicate：唯一索引先拦，所以 supersede 必须先把旧行标记掉。
    expect(() => insert({ id: 'f5b' })).toThrow(/UNIQUE/);
    db.exec('BEGIN IMMEDIATE');
    db.exec('PRAGMA defer_foreign_keys = ON');
    db.prepare("UPDATE facts SET superseded_by = 'f5', superseded_at = '2026-11-15T01:00:00.000Z' WHERE id = 'f4'").run();
    insert({ id: 'f5', value: '{"summary":"newer","evidence_refs":["dlv_2"]}' });
    db.exec('COMMIT');
    const old = readBack('f4')!;
    expect(old['superseded_by']).toBe('f5');
    expect(old['superseded_at']).toBe('2026-11-15T01:00:00.000Z');
    expect(JSON.parse(String(old['value_json']))['summary']).toBe('done');
    expect(JSON.parse(String(readBack('f5')!['value_json']))['summary']).toBe('newer');
  });
});

describe('invariant 2 — identity is mandatory (empty is an error, not a default)', () => {
  it.each([
    ['work_unit_ref', ''],
    ['asserted_by', ''],
    ['source_refs_json', ''],
  ])('rejects INSERT with empty %s', (field, empty) => {
    const row: FactRow = { id: 'bad' };
    if (field === 'work_unit_ref') row.workUnitRef = empty;
    if (field === 'asserted_by') row.assertedBy = empty;
    if (field === 'source_refs_json') row.sourceRefs = empty;
    expect(() => insert(row)).toThrow(/provenance/);
    expect(readBack('bad')).toBeUndefined();
  });

  it.each([
    ['work_unit_ref'],
    ['asserted_by'],
    ['source_refs_json'],
  ])('rejects INSERT with whitespace-only %s', field => {
    const row: FactRow = { id: 'blank' };
    if (field === 'work_unit_ref') row.workUnitRef = '   ';
    if (field === 'asserted_by') row.assertedBy = '  ';
    if (field === 'source_refs_json') row.sourceRefs = ' ';
    expect(() => insert(row)).toThrow(/provenance/);
  });

  it.each([
    ['work_unit_ref'],
    ['asserted_by'],
    ['source_refs_json'],
  ])('rejects INSERT with NULL %s (column is NOT NULL as well)', field => {
    // NOT NULL 与触发器双保险：谁先命中都算拒绝，但这一行**不许**落库。
    const cols: Record<string, unknown> = {
      work_unit_ref: null,
      asserted_by: 'agt_a',
      source_refs_json: '["dlv_1"]',
    };
    cols[field] = null;
    expect(() => {
      db.prepare(
        `INSERT INTO facts
           (id, subject_kind, subject_id, predicate, value_json, work_unit_ref, asserted_by, source_refs_json, created_at)
         VALUES ('nullrow', 'task', 'tsk_1', 'task.completion_evidence', '{}', ?, ?, ?, '2026-11-15T00:00:00.000Z')`,
      ).run(
        cols['work_unit_ref'] as string | null,
        cols['asserted_by'] as string | null,
        cols['source_refs_json'] as string | null,
      );
    }).toThrow();
    expect(readBack('nullrow')).toBeUndefined();
  });

  it('accepts a fully identified row', () => {
    insert({ id: 'good' });
    expect(readBack('good')).toBeDefined();
  });
});

describe('invariant 3 — one active row per subject+predicate', () => {
  it('rejects a second active row, and allows a new one after supersede', () => {
    insert({ id: 'a1' });
    expect(() => insert({ id: 'a2' })).toThrow(/UNIQUE/);
    // FK 是立即检查的，而 superseded_by 指向的 a2 还不存在 —— 真实写路径
    // （SqliteFactService.supersede）在事务内 `PRAGMA defer_foreign_keys`，这里同口径。
    db.exec('BEGIN IMMEDIATE');
    db.exec('PRAGMA defer_foreign_keys = ON');
    db.prepare("UPDATE facts SET superseded_by = 'a2', superseded_at = 'x' WHERE id = 'a1'").run();
    insert({ id: 'a2' });
    db.exec('COMMIT');
    expect(readBack('a2')).toBeDefined();
  });

  it('keeps different predicates / different subjects independent', () => {
    insert({ id: 'p1', predicate: 'task.completion_evidence' });
    insert({ id: 'p2', predicate: 'work.defect_class' });
    insert({ id: 'p3', subjectId: 'tsk_2' });
    expect(db.prepare('SELECT COUNT(*) c FROM facts').get()).toEqual({ c: 3 });
  });
});
