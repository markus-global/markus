/**
 * C9-A · `SqliteFactService` —— 唯一写者的业务不变量（真实 SQLite）
 *
 * 本文件锁的是**拒绝路径**：五条拒绝各一条用例，且每条都断言具体 code。
 * 判据：把 `validate()` 里对应的那段判断删掉，对应用例必红（删校验 = 测试红，
 * 不是靠人记得）。
 *
 * 另外锁两件容易退化的语义：
 *   · supersede 一次调用完成「断言新 + 标记旧」，旧行 value 不被改写（历史可解释）；
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSqlite, closeSqlite } from '@markus/storage';
import { SqliteFactService, type FactDb } from '../src/fact-service.js';
import type { FactAssertInput } from '@markus/core';

let tempDir: string;
let db: FactDb;
let svc: SqliteFactService;

const NOW = '2026-11-15T01:00:00.000Z';

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-facts-svc-'));
  db = openSqlite(join(tempDir, 'test.db')) as unknown as FactDb;
  svc = new SqliteFactService(db, { now: () => NOW });
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

function input(over: Partial<FactAssertInput> = {}): FactAssertInput {
  return {
    subjectKind: 'task',
    subjectId: 'tsk_a1',
    predicate: 'task.completion_evidence',
    value: { summary: 'facts layer landed', evidence_refs: ['dlv_1'] },
    workUnitRef: 'task:tsk_a1:r1',
    assertedBy: 'agt_worker',
    sourceRefs: ['dlv_1'],
    ...over,
  };
}

describe('assert — the happy path', () => {
  it('writes one row carrying identity, evidence and the exact value', () => {
    const res = svc.assert(input());
    expect(res.status).toBe('asserted');
    if (res.status !== 'asserted') return;
    expect(res.fact.workUnitRef).toBe('task:tsk_a1:r1');
    expect(res.fact.assertedBy).toBe('agt_worker');
    expect(res.fact.sourceRefs).toEqual(['dlv_1']);
    expect(res.fact.createdAt).toBe(NOW);
    expect(res.fact.value).toEqual({ summary: 'facts layer landed', evidence_refs: ['dlv_1'] });
    expect(res.fact.supersededBy).toBeUndefined();

    const rows = db.prepare('SELECT COUNT(*) c FROM facts').get() as { c: number };
    expect(rows.c).toBe(1);
  });
});

describe('assert — rejection paths (delete the check ⇒ this goes red)', () => {
  it('1. unknown predicate: actionable, lists the nearest legal names', () => {
    const res = svc.assert(input({ predicate: 'task.completion_evidence_v2' }));
    expect(res.status).toBe('rejected');
    if (res.status !== 'rejected') return;
    expect(res.code).toBe('unknown_predicate');
    expect(res.allowed).toContain('task.completion_evidence');
    expect(res.message).toMatch(/closed set/);
  });

  it('2. schema violation: names the failing path', () => {
    const res = svc.assert(input({ value: { summary: 'x' } }));
    expect(res.status).toBe('rejected');
    if (res.status !== 'rejected') return;
    expect(res.code).toBe('schema_violation');
    expect(res.path).toBe('/evidence_refs');
  });

  it('3. missing provenance: empty work_unit_ref', () => {
    const res = svc.assert(input({ workUnitRef: '   ' }));
    expect(res.status).toBe('rejected');
    if (res.status !== 'rejected') return;
    expect(res.code).toBe('missing_provenance');
    expect(res.message).toMatch(/WorkUnit/);
    expect(db.prepare('SELECT COUNT(*) c FROM facts').get()).toEqual({ c: 0 });
  });

  it('3b. missing provenance: no source refs at all', () => {
    const res = svc.assert(input({ sourceRefs: [] }));
    expect(res.status).toBe('rejected');
    if (res.status !== 'rejected') return;
    expect(res.code).toBe('missing_provenance');
  });

  it('4. self-verification is forbidden (producer ≠ confirmer)', () => {
    const res = svc.assert(
      input({ verification: { result: 'pass', verified_by: 'agt_worker' } }),
    );
    expect(res.status).toBe('rejected');
    if (res.status !== 'rejected') return;
    expect(res.code).toBe('self_verification_forbidden');
  });

  it('4b. verification by a different agent is accepted and stored', () => {
    const res = svc.assert(
      input({ verification: { result: 'pass', verified_by: 'agt_verifier', evidence_refs: ['c1'] } }),
    );
    expect(res.status).toBe('asserted');
    if (res.status !== 'asserted') return;
    expect(res.fact.verification?.verified_by).toBe('agt_verifier');
  });

  it('5. must_supersede: an active row for the same subject+predicate is never overwritten', () => {
    const first = svc.assert(input());
    expect(first.status).toBe('asserted');
    const second = svc.assert(input({ value: { summary: 'other', evidence_refs: ['dlv_2'] } }));
    expect(second.status).toBe('rejected');
    if (second.status !== 'rejected') return;
    expect(second.code).toBe('must_supersede');
    if (first.status === 'asserted') expect(second.existingFactId).toBe(first.fact.id);
    // The old conclusion is untouched — superseding is a separate decision.
    const row = db.prepare('SELECT value_json, superseded_by FROM facts').get() as {
      value_json: string;
      superseded_by: string | null;
    };
    expect(JSON.parse(row.value_json).summary).toBe('facts layer landed');
    expect(row.superseded_by).toBeNull();
  });

  it('rejects a predicate asserted about the wrong subject kind', () => {
    const res = svc.assert(input({ subjectKind: 'agent' }));
    expect(res.status).toBe('rejected');
    if (res.status !== 'rejected') return;
    expect(res.code).toBe('invalid_subject');
  });
});

describe('supersede — one call, history preserved', () => {
  it('asserts the new fact and marks the old one in a single call', () => {
    const first = svc.assert(input());
    expect(first.status).toBe('asserted');
    if (first.status !== 'asserted') return;

    const res = svc.supersede({
      ...input({ value: { summary: 'newer evidence', evidence_refs: ['dlv_9'] } }),
      supersededFactId: first.fact.id,
      reason: 'new evidence contradicts the earlier conclusion',
    });
    expect(res.status).toBe('asserted');
    if (res.status !== 'asserted') return;

    const old = svc.queryActive({ factId: first.fact.id, activeOnly: false })[0];
    expect(old.supersededBy).toBe(res.fact.id);
    expect(old.supersededAt).toBe(NOW);
    expect((old.value as { summary: string }).summary).toBe('facts layer landed');

    const active = svc.queryActive({ subjectKind: 'task', subjectId: 'tsk_a1' });
    expect(active).toHaveLength(1);
    expect((active[0].value as { summary: string }).summary).toBe('newer evidence');
  });

  it('rejects an unknown id', () => {
    const res = svc.supersede({ ...input(), supersededFactId: 'fact_nope', reason: 'x' });
    expect(res.status).toBe('rejected');
    if (res.status !== 'rejected') return;
    expect(res.code).toBe('not_found');
  });

  it('rejects superseding an already-superseded row, naming the active one', () => {
    const first = svc.assert(input());
    if (first.status !== 'asserted') throw new Error('setup failed');
    const second = svc.supersede({
      ...input({ value: { summary: 'b', evidence_refs: ['dlv_2'] } }),
      supersededFactId: first.fact.id,
      reason: 'r1',
    });
    if (second.status !== 'asserted') throw new Error('setup failed');

    const third = svc.supersede({
      ...input({ value: { summary: 'c', evidence_refs: ['dlv_3'] } }),
      supersededFactId: first.fact.id,
      reason: 'r2',
    });
    expect(third.status).toBe('rejected');
    if (third.status !== 'rejected') return;
    expect(third.code).toBe('must_supersede');
    expect(third.existingFactId).toBe(second.fact.id);
  });

  it('rejects a supersede that changes the subject or predicate (that is a new fact)', () => {
    const first = svc.assert(input());
    if (first.status !== 'asserted') throw new Error('setup failed');
    const res = svc.supersede({
      ...input({ predicate: 'work.defect_class', value: { class: 'R1', instances: [] } }),
      supersededFactId: first.fact.id,
      reason: 'r',
    });
    expect(res.status).toBe('rejected');
    if (res.status !== 'rejected') return;
    expect(res.code).toBe('invalid_subject');
  });

  it('rejects an empty reason (history must stay explainable)', () => {
    const first = svc.assert(input());
    if (first.status !== 'asserted') throw new Error('setup failed');
    const res = svc.supersede({
      ...input({ value: { summary: 'b', evidence_refs: ['dlv_2'] } }),
      supersededFactId: first.fact.id,
      reason: '   ',
    });
    expect(res.status).toBe('rejected');
    if (res.status !== 'rejected') return;
    expect(res.code).toBe('schema_violation');
  });

  it('leaves no half-done supersede behind when the new value is invalid', () => {
    const first = svc.assert(input());
    if (first.status !== 'asserted') throw new Error('setup failed');
    const res = svc.supersede({
      ...input({ value: { summary: 'b' } }),
      supersededFactId: first.fact.id,
      reason: 'r',
    });
    expect(res.status).toBe('rejected');
    const still = svc.queryActive({ subjectKind: 'task', subjectId: 'tsk_a1' });
    expect(still).toHaveLength(1);
    expect(still[0].id).toBe(first.fact.id);
    expect(still[0].supersededBy).toBeUndefined();
  });
});

describe('queryActive — exact matching only', () => {
  beforeEach(() => {
    svc.assert(input());
    svc.assert(
      input({
        predicate: 'work.defect_class',
        value: { class: 'R1', instances: ['two writers'] },
      }),
    );
    svc.assert(
      input({
        subjectKind: 'requirement',
        subjectId: 'req_1',
        predicate: 'requirement.acceptance_met',
        value: { criteria_id: 'AC1', met: true },
      }),
    );
  });

  it('filters by subject, predicate and predicate prefix', () => {
    expect(svc.queryActive({ subjectKind: 'task', subjectId: 'tsk_a1' })).toHaveLength(2);
    expect(svc.queryActive({ predicate: 'work.defect_class' })).toHaveLength(1);
    expect(svc.queryActive({ predicatePrefix: 'task.' })).toHaveLength(1);
    expect(svc.queryActive({ subjectKind: 'requirement' })).toHaveLength(1);
  });

  it('does not do fuzzy matching: a partial predicate name matches nothing', () => {
    expect(svc.queryActive({ predicate: 'completion' })).toHaveLength(0);
  });

  it('respects the limit', () => {
    expect(svc.queryActive({ subjectKind: 'task', limit: 1 })).toHaveLength(1);
  });
});


