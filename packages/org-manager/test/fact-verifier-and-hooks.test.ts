/**
 * C9-E · Independent verifier + terminal hooks — real SQLite, real TaskService.
 *
 * What this file pins (each one fails if the mechanism is removed):
 *  1. **Self-verification is rejected** — delete the check in `SqliteFactService.verify` and case
 *     "refuses the assertor" goes red (AC-1).
 *  2. **A verdict writes only `verification_json`** — value / predicate / asserted_by are untouched,
 *     and a second verdict is refused (`already_verified`); a changed verdict means superseding the
 *     claim (write-once).
 *  3. **`done` is driven by the verdict, not by the claim** — removing the verification drops the
 *     stage back to `in_verification` through C9-C's `deriveStage` (AC-2: same derivation, no copy).
 *  4. **Terminal hook 1**: `task_submit_review` refuses without an active
 *     `task.completion_evidence`, and the SAME call succeeds once the fact exists (AC-3, both
 *     directions). `FACTS_ENABLED=0` restores the old behaviour (AC-6).
 *  5. **Terminal hook 2**: an agent sending work back must assert `task.rejection_reason`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSqlite, closeSqlite } from '@markus/storage';
import { deriveStage, type FactAssertInput } from '@markus/core';
import { SqliteFactService, type FactDb } from '../src/fact-service.js';
import { TaskService } from '../src/task-service.js';

const NOW = '2026-11-15T01:00:00.000Z';
const AGENT = 'agt_worker';
const REVIEWER = 'agt_reviewer';
const ORG = 'org_default';

let tempDir: string;
let db: FactDb;
let svc: SqliteFactService;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-c9e-'));
  db = openSqlite(join(tempDir, 'test.db')) as unknown as FactDb;
  svc = new SqliteFactService(db, { now: () => NOW });
  delete process.env['FACTS_ENABLED'];
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env['FACTS_ENABLED'];
});

function assertEvidence(over: Partial<FactAssertInput> = {}) {
  return svc.assert({
    subjectKind: 'task',
    subjectId: 'tsk_1',
    predicate: 'task.completion_evidence',
    value: { summary: 'the layer landed', evidence_refs: ['dlv_1'] },
    workUnitRef: 'task:tsk_1:r1',
    assertedBy: AGENT,
    sourceRefs: ['dlv_1'],
    ...over,
  });
}

// ─── 1. independent verifier ────────────────────────────────────────────────────────────────

describe('verify() — producer != confirmer', () => {
  it('records a pass from a different agent, writing only verification_json', () => {
    const asserted = assertEvidence();
    expect(asserted.status).toBe('asserted');
    if (asserted.status !== 'asserted') return;

    const res = svc.verify({
      factId: asserted.fact.id,
      result: 'pass',
      verifiedBy: REVIEWER,
      evidenceRefs: ['cmt_42'],
      workUnitRef: 'task:tsk_1:r1:review',
    });
    expect(res.status).toBe('asserted');
    if (res.status !== 'asserted') return;

    expect(res.fact.verification).toMatchObject({
      result: 'pass',
      verified_by: REVIEWER,
      evidence_refs: ['cmt_42'],
      verified_at: NOW,
      work_unit_ref: 'task:tsk_1:r1:review',
    });
    // the claim it judged is untouched
    expect(res.fact.value).toEqual({ summary: 'the layer landed', evidence_refs: ['dlv_1'] });
    expect(res.fact.assertedBy).toBe(AGENT);
    expect(res.fact.predicate).toBe('task.completion_evidence');
  });

  it('refuses the assertor (delete this check ⇒ red)', () => {
    const asserted = assertEvidence();
    if (asserted.status !== 'asserted') throw new Error('setup');
    const res = svc.verify({
      factId: asserted.fact.id,
      result: 'pass',
      verifiedBy: AGENT, // same agent that asserted it
      evidenceRefs: ['cmt_42'],
      workUnitRef: 'task:tsk_1:r1',
    });
    expect(res.status).toBe('rejected');
    if (res.status !== 'rejected') return;
    expect(res.code).toBe('self_verification_forbidden');
    expect(res.message).toContain('producer != confirmer');
    // and nothing was written
    expect(svc.queryActive({ factId: asserted.fact.id })[0]?.verification).toBeUndefined();
  });

  it('refuses a verdict with no evidence pointer (pass and fail alike)', () => {
    const asserted = assertEvidence();
    if (asserted.status !== 'asserted') throw new Error('setup');
    for (const result of ['pass', 'fail'] as const) {
      const res = svc.verify({
        factId: asserted.fact.id,
        result,
        verifiedBy: REVIEWER,
        evidenceRefs: ['  '],
        workUnitRef: 'task:tsk_1:r1:review',
      });
      expect(res.status).toBe('rejected');
      if (res.status === 'rejected') {
        expect(res.code).toBe('schema_violation');
        expect(res.path).toBe('/evidence_refs');
      }
    }
  });

  it('is write-once: a second verdict is refused, and the fix is named', () => {
    const asserted = assertEvidence();
    if (asserted.status !== 'asserted') throw new Error('setup');
    svc.verify({
      factId: asserted.fact.id, result: 'fail', verifiedBy: REVIEWER,
      evidenceRefs: ['cmt_1'], workUnitRef: 'task:tsk_1:r1:review',
    });
    const second = svc.verify({
      factId: asserted.fact.id, result: 'pass', verifiedBy: 'agt_reviewer_2',
      evidenceRefs: ['cmt_2'], workUnitRef: 'task:tsk_1:r1:review2',
    });
    expect(second.status).toBe('rejected');
    if (second.status === 'rejected') {
      expect(second.code).toBe('already_verified');
      expect(second.message).toContain('supersede');
    }
    // the first verdict is still the only one
    expect(svc.queryActive({ factId: asserted.fact.id })[0]?.verification?.result).toBe('fail');
  });

  it('refuses to judge history (a superseded claim keeps the verdict it had)', () => {
    const asserted = assertEvidence();
    if (asserted.status !== 'asserted') throw new Error('setup');
    const replaced = svc.supersede({
      subjectKind: 'task', subjectId: 'tsk_1', predicate: 'task.completion_evidence',
      value: { summary: 'new evidence', evidence_refs: ['dlv_2'] },
      workUnitRef: 'task:tsk_1:r2', assertedBy: AGENT, sourceRefs: ['dlv_2'],
      supersededFactId: asserted.fact.id, reason: 'new evidence arrived',
    });
    expect(replaced.status).toBe('asserted');
    const res = svc.verify({
      factId: asserted.fact.id, result: 'pass', verifiedBy: REVIEWER,
      evidenceRefs: ['cmt_9'], workUnitRef: 'task:tsk_1:r2:review',
    });
    expect(res.status).toBe('rejected');
    if (res.status === 'rejected') expect(res.code).toBe('must_supersede');
  });

  it('needs identity: an empty verifier or an unbound turn is missing_provenance', () => {
    const asserted = assertEvidence();
    if (asserted.status !== 'asserted') throw new Error('setup');
    const res = svc.verify({
      factId: asserted.fact.id, result: 'pass', verifiedBy: '',
      evidenceRefs: ['cmt'], workUnitRef: 'task:tsk_1:r1',
    });
    expect(res.status).toBe('rejected');
    if (res.status === 'rejected') expect(res.code).toBe('missing_provenance');
  });
});

// ─── 2. stage derives from the verdict (C9-C, not a second copy) ────────────────────────────

describe('deriveStage consumes the verdict (one derivation, AC-2)', () => {
  const fsm = { status: 'review' as const };

  it('no verification ⇒ in_verification; independent pass ⇒ done', () => {
    const asserted = assertEvidence();
    if (asserted.status !== 'asserted') throw new Error('setup');

    const before = deriveStage({ fsm, facts: svc.queryActive({ subjectId: 'tsk_1' }), approvals: [] });
    expect(before).toBe('in_verification');

    svc.verify({
      factId: asserted.fact.id, result: 'pass', verifiedBy: REVIEWER,
      evidenceRefs: ['cmt_42'], workUnitRef: 'task:tsk_1:r1:review',
    });
    const after = deriveStage({ fsm, facts: svc.queryActive({ subjectId: 'tsk_1' }), approvals: [] });
    expect(after).toBe('done');
  });

  it('removing the verification drops the stage back to in_verification', () => {
    const asserted = assertEvidence();
    if (asserted.status !== 'asserted') throw new Error('setup');
    svc.verify({
      factId: asserted.fact.id, result: 'pass', verifiedBy: REVIEWER,
      evidenceRefs: ['cmt_42'], workUnitRef: 'task:tsk_1:r1:review',
    });
    const passed = svc.queryActive({ subjectId: 'tsk_1' }) as Array<Record<string, unknown>>;
    expect(deriveStage({ fsm, facts: passed as never, approvals: [] })).toBe('done');

    // Drop the verdict from the read model — exactly what "去掉验证事实" means.
    const withoutVerdict = passed.map(f => ({ ...f, verification: undefined }));
    expect(deriveStage({ fsm, facts: withoutVerdict as never, approvals: [] })).toBe('in_verification');
  });

  it('a `fail` verdict does NOT produce done', () => {
    const asserted = assertEvidence();
    if (asserted.status !== 'asserted') throw new Error('setup');
    svc.verify({
      factId: asserted.fact.id, result: 'fail', verifiedBy: REVIEWER,
      evidenceRefs: ['cmt_43'], workUnitRef: 'task:tsk_1:r1:review',
    });
    expect(deriveStage({ fsm, facts: svc.queryActive({ subjectId: 'tsk_1' }), approvals: [] }))
      .toBe('in_verification');
  });
});

// ─── 3. terminal hooks ─────────────────────────────────────────────────────────────────────

function makeTaskService(): TaskService {
  const ts = new TaskService();
  ts.setGovernancePolicy({
    enabled: false, defaultTier: 'auto', maxPendingTasksPerAgent: 100, maxTotalActiveTasks: 100,
    requireApprovalForPriority: [], requireRequirement: false, rules: [],
  } as never);
  ts.setFactService(svc);
  return ts;
}

function taskInProgress(ts: TaskService, id = 'tsk_hook') {
  const task = ts.createTask({
    orgId: ORG, title: 'Hook task', description: 'do it',
    assignedAgentId: AGENT, reviewerId: REVIEWER, creatorRole: 'human',
  } as never);
  ts.approveTask(task.id, 'user-1');
  const current = ts.getTask(task.id)!;
  // the id is generated; keep the caller in sync for fact assertions
  return { id: current.id || id, task: current };
}

describe('terminal hook 1 — task_submit_review needs task.completion_evidence (AC-3)', () => {
  it('refuses without the fact, with an actionable message naming fact_assert', async () => {
    const ts = makeTaskService();
    const { id } = taskInProgress(ts);
    await expect(
      ts.submitForReview(id, [{ type: 'file', reference: '/tmp/x.md', summary: 'out' }]),
    ).rejects.toThrow(/task\.completion_evidence/);
    await expect(
      ts.submitForReview(id, [{ type: 'file', reference: '/tmp/x.md', summary: 'out' }]),
    ).rejects.toThrow(/fact_assert/);
  });

  it('succeeds on the same path once the fact exists (positive half)', async () => {
    const ts = makeTaskService();
    const { id } = taskInProgress(ts);
    svc.assert({
      subjectKind: 'task', subjectId: id, predicate: 'task.completion_evidence',
      value: { summary: 'done', evidence_refs: ['dlv_9'] },
      workUnitRef: `task:${id}:r1`, assertedBy: AGENT, sourceRefs: ['dlv_9'],
    });
    const task = await ts.submitForReview(id, [{ type: 'file', reference: '/tmp/x.md', summary: 'out' }]);
    expect(task.status).toBe('review');
  });

  it('FACTS_ENABLED=0 restores the old behaviour (rollback, AC-6)', async () => {
    process.env['FACTS_ENABLED'] = '0';
    const ts = makeTaskService();
    const { id } = taskInProgress(ts);
    const task = await ts.submitForReview(id, [{ type: 'file', reference: '/tmp/x.md', summary: 'out' }]);
    expect(task.status).toBe('review');
  });

  it('an unwired TaskService (no fact port) is inert too', async () => {
    const ts = new TaskService();
    ts.setGovernancePolicy({
      enabled: false, defaultTier: 'auto', maxPendingTasksPerAgent: 100, maxTotalActiveTasks: 100,
      requireApprovalForPriority: [], requireRequirement: false, rules: [],
    } as never);
    const { id } = taskInProgress(ts);
    const task = await ts.submitForReview(id, [{ type: 'file', reference: '/tmp/x.md', summary: 'out' }]);
    expect(task.status).toBe('review');
  });
});

describe('terminal hook 2 — an agent rejection needs task.rejection_reason', () => {
  it('refuses an agent rejection without the fact, naming fact_assert', async () => {
    const ts = makeTaskService();
    const { id } = taskInProgress(ts);
    svc.assert({
      subjectKind: 'task', subjectId: id, predicate: 'task.completion_evidence',
      value: { summary: 'done', evidence_refs: ['dlv_9'] },
      workUnitRef: `task:${id}:r1`, assertedBy: AGENT, sourceRefs: ['dlv_9'],
    });
    await ts.submitForReview(id, [{ type: 'file', reference: '/tmp/x.md', summary: 'out' }]);
    await expect(ts.requestRevision(id, 'the test is faked', REVIEWER))
      .rejects.toThrow(/task\.rejection_reason/);
  });

  it('succeeds once the rejection reason fact exists', async () => {
    const ts = makeTaskService();
    const { id } = taskInProgress(ts);
    svc.assert({
      subjectKind: 'task', subjectId: id, predicate: 'task.completion_evidence',
      value: { summary: 'done', evidence_refs: ['dlv_9'] },
      workUnitRef: `task:${id}:r1`, assertedBy: AGENT, sourceRefs: ['dlv_9'],
    });
    await ts.submitForReview(id, [{ type: 'file', reference: '/tmp/x.md', summary: 'out' }]);
    svc.assert({
      subjectKind: 'task', subjectId: id, predicate: 'task.rejection_reason',
      value: { reason: 'the test is a tautology', blocking_refs: ['test:foo'] },
      workUnitRef: `task:${id}:r1:review`, assertedBy: REVIEWER, sourceRefs: ['cmt_1'],
    });
    const task = await ts.requestRevision(id, 'the test is a tautology', REVIEWER);
    expect(task.status).toBe('in_progress');
  });

  it('a HUMAN rejection is not gated (no turn identity ⇒ cannot assert)', async () => {
    const ts = makeTaskService();
    const { id } = taskInProgress(ts);
    svc.assert({
      subjectKind: 'task', subjectId: id, predicate: 'task.completion_evidence',
      value: { summary: 'done', evidence_refs: ['dlv_9'] },
      workUnitRef: `task:${id}:r1`, assertedBy: AGENT, sourceRefs: ['dlv_9'],
    });
    await ts.submitForReview(id, [{ type: 'file', reference: '/tmp/x.md', summary: 'out' }]);
    const task = await ts.requestRevision(id, 'not good enough', 'user_42');
    expect(task.status).toBe('in_progress');
  });
});

describe('queryActive time bounds (audit page filter)', () => {
  it('filters by created_at inclusively', () => {
    assertEvidence();
    expect(svc.queryActive({ createdAfter: NOW })).toHaveLength(1);
    expect(svc.queryActive({ createdBefore: '2000-01-01T00:00:00.000Z' })).toHaveLength(0);
  });
});

// keep vi referenced for type-checkers that strip unused imports
void vi;
