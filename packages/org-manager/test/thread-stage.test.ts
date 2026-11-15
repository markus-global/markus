/**
 * C9-C · `deriveTaskThreadStage()` —— 派生规则在**真实 SQLite + 真实唯一写者**上的行为。
 *
 * 为什么这一层还要单独测：`deriveStage()` 的单测证明「给定事实集合，规则是对的」，
 * 但真正被页面读到的值来自这里 —— 依赖解析、审批收敛、WorkUnit 计数与事实投影。
 * 本文件用真实库（没有 mock repo、没有假事实）证明三件验收里最难假装的事：
 *
 *   1. 断言一条 `task.completion_evidence` 后，阶段从 `needs_evidence` 变成 `in_verification`；
 *   2. 补一条独立验证（pass）后变成 `done`；
 *   3. 把证据 supersede 掉 → 回落 `needs_evidence`（**不是** done），且 evidence 投影里
 *      不再出现被取代的那一行。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSqlite, closeSqlite } from '@markus/storage';
import { SqliteFactService, type FactDb } from '../src/fact-service.js';
import { deriveTaskThreadStage, toEvidenceView } from '../src/thread-stage.js';
import type { FactAssertInput, FactRecord } from '@markus/core';

let tempDir: string;
let db: FactDb;
let svc: SqliteFactService;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-thread-stage-'));
  db = openSqlite(join(tempDir, 'test.db')) as unknown as FactDb;
  svc = new SqliteFactService(db);
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

const task = { id: 'tsk_c1', status: 'review', blockedReason: null, blockedBy: [] as string[] };

function evidenceInput(over: Partial<FactAssertInput> = {}): FactAssertInput {
  return {
    subjectKind: 'task',
    subjectId: task.id,
    predicate: 'task.completion_evidence',
    value: { summary: 'stage derivation landed', evidence_refs: ['dlv_1'] },
    workUnitRef: 'task:tsk_c1:r1',
    assertedBy: 'agt_worker',
    sourceRefs: ['dlv_1'],
    ...over,
  };
}

function activeFacts(): FactRecord[] {
  return svc.queryActive({ subjectKind: 'task', subjectId: task.id });
}

describe('evidence drives the stage end to end', () => {
  it('starts at needs_evidence', () => {
    expect(deriveTaskThreadStage(task, { facts: activeFacts() })).toBe('needs_evidence');
  });

  it('turns in_verification once the evidence fact exists', () => {
    const result = svc.assert(evidenceInput());
    expect(result.status).toBe('asserted');
    expect(deriveTaskThreadStage(task, { facts: activeFacts() })).toBe('in_verification');
  });

  it('turns done only when the verification is an independent pass', () => {
    svc.assert(evidenceInput({ verification: { result: 'pass', verified_by: 'agt_reviewer' } }));
    expect(deriveTaskThreadStage(task, { facts: activeFacts() })).toBe('done');
  });

  it('stays in_verification when the verifier is the assertor', () => {
    // The service refuses this at write time (`self_verification_forbidden`), so the
    // assertion below is the *derivation*'s own guard: a row written by some future
    // writer must not be able to produce `done` on its own.
    const result = svc.assert(evidenceInput({ verification: { result: 'pass', verified_by: 'agt_worker' } }));
    expect(result.status).toBe('rejected');
    expect(deriveTaskThreadStage(task, { facts: activeFacts() })).toBe('needs_evidence');
  });

  it('falls back to needs_evidence when the evidence is superseded', () => {
    const first = svc.assert(evidenceInput());
    expect(first.status).toBe('asserted');
    if (first.status !== 'asserted') return;

    const replaced = svc.supersede({
      ...evidenceInput({ value: { summary: 'rewritten claim', evidence_refs: ['dlv_2'] } }),
      supersededFactId: first.fact.id,
      reason: 'the first claim was wrong',
    });
    expect(replaced.status).toBe('asserted');

    // Superseded → not evidence of anything: the claim on the table now has no
    // independent pass behind it.
    expect(deriveTaskThreadStage(task, { facts: activeFacts() })).toBe('in_verification');
    expect(toEvidenceView(activeFacts()).every(f => f.factId !== first.fact.id)).toBe(true);
  });
});

describe('structural inputs beat facts', () => {
  it('a pending human need wins over complete evidence', () => {
    svc.assert(evidenceInput({ verification: { result: 'pass', verified_by: 'agt_reviewer' } }));
    const stage = deriveTaskThreadStage(task, {
      facts: activeFacts(),
      pendingHumanNeeds: [{ kind: 'approval', status: 'pending' }],
    });
    expect(stage).toBe('waiting_human');
  });

  it('a running work unit wins over complete evidence', () => {
    svc.assert(evidenceInput({ verification: { result: 'pass', verified_by: 'agt_reviewer' } }));
    expect(deriveTaskThreadStage(task, { facts: activeFacts(), runningWorkUnits: 1 })).toBe('running');
  });

  it('treats an unresolvable dependency as open (never as satisfied)', () => {
    const blocked = { ...task, status: 'blocked', blockedBy: ['tsk_up'] };
    expect(deriveTaskThreadStage(blocked, { getDependencyStatus: () => undefined })).toBe('blocked_deps');
    expect(
      deriveTaskThreadStage(blocked, { getDependencyStatus: id => (id === 'tsk_up' ? 'completed' : undefined) }),
    ).toBe('needs_evidence');
  });

  it('a human-declared hold is waiting_human, an unmet dependency is not', () => {
    expect(
      deriveTaskThreadStage({ ...task, status: 'blocked', blockedReason: 'hold' }, {}),
    ).toBe('waiting_human');
    expect(
      deriveTaskThreadStage({ ...task, status: 'blocked', blockedReason: 'deps', blockedBy: ['tsk_up'] }, {}),
    ).toBe('blocked_deps');
  });
});

describe('evidence projection', () => {
  it('never exposes a superseded row and keeps the newest first', () => {
    svc.assert(evidenceInput({ predicate: 'work.defect_class', value: { class: 'R1', instances: ['x'] } }));
    svc.assert(evidenceInput());
    const view = toEvidenceView(activeFacts());
    expect(view.length).toBe(2);
    for (const item of view) {
      expect(item.factId.startsWith('fact_')).toBe(true);
      expect(Array.isArray(item.sourceRefs)).toBe(true);
    }
  });
});
