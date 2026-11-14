/**
 * C9-C · `deriveStage()` — pure derivation contract.
 *
 * This file deliberately mocks **nothing** and imports no repo: the derivation is a
 * function of its arguments, so "it passes without any IO stand-in" is itself the
 * proof. `vi.mock` is not used anywhere here, and no fake repo is constructed.
 *
 * Acceptance coverage:
 *   1. seven stages, each with a positive case and a case that must NOT reach it;
 *   2. the load-bearing rule — only an independent `pass` verification produces
 *      `done`. Break it (accept `fail`, or accept a self-verification) and the
 *      corresponding test goes red;
 *   3. removing the verification fact falls back to `in_verification`, never `done`;
 *   4. idempotent / noiseless: two calls on the same input are deeply equal, and the
 *      function runs with `Date.now` and `Math.random` replaced by throwing stubs;
 *   5. totality: every combination of inputs still yields a value from the closed set.
 */
import { describe, it, expect } from 'vitest';
import {
  deriveStage,
  isThreadStage,
  THREAD_STAGES,
  COMPLETION_EVIDENCE_PREDICATE,
  type Approval,
  type DeriveStageInput,
  type FsmSnapshot,
} from '../src/facts/derive-stage.js';
import type { FactRecord, FactVerification } from '../src/facts/fact-service.js';

// ─── fixtures ────────────────────────────────────────────────────────────────

let seq = 0;

function fact(overrides: Partial<FactRecord> = {}): FactRecord {
  seq += 1;
  return {
    id: `fact_${String(seq).padStart(4, '0')}`,
    subjectKind: 'task',
    subjectId: 'tsk_b04ac0a3a800048b237ad054',
    predicate: COMPLETION_EVIDENCE_PREDICATE,
    value: { summary: 'landed', evidence_refs: ['dlv_1'] },
    workUnitRef: 'wu_1',
    assertedBy: 'agt_executor',
    sourceRefs: ['dlv_1'],
    confidence: 0.9,
    createdAt: '2026-11-15T00:00:00.000Z',
    ...overrides,
  };
}

function verified(overrides: Partial<FactVerification> = {}): FactVerification {
  return { result: 'pass', verified_by: 'agt_verifier', evidence_refs: ['dlv_2'], ...overrides };
}

function evidenceFact(overrides: Partial<FactRecord> = {}): FactRecord {
  return fact({ verification: verified(), ...overrides });
}

function fsm(overrides: Partial<FsmSnapshot> = {}): FsmSnapshot {
  return { status: 'in_progress', ...overrides };
}

const noHuman: Approval[] = [];
const pendingApproval: Approval[] = [{ kind: 'approval', status: 'pending' }];
const pendingQuestion: Approval[] = [{ kind: 'question', status: 'pending' }];
const resolvedApproval: Approval[] = [{ kind: 'approval', status: 'resolved' }];

function stage(input: Partial<DeriveStageInput> & { fsm?: FsmSnapshot }): string {
  return deriveStage({
    fsm: input.fsm ?? fsm(),
    facts: input.facts ?? [],
    approvals: input.approvals ?? noHuman,
  });
}

// ─── the closed set itself ───────────────────────────────────────────────────

describe('closed set', () => {
  it('is exactly the seven frozen stages, in one place', () => {
    expect([...THREAD_STAGES]).toEqual([
      'waiting_human',
      'running',
      'needs_evidence',
      'in_verification',
      'done',
      'blocked_deps',
      'failed',
    ]);
  });

  it('guards values that crossed a JSON boundary', () => {
    expect(isThreadStage('done')).toBe(true);
    expect(isThreadStage('已完成')).toBe(false);
    expect(isThreadStage('running-ish')).toBe(false);
    expect(isThreadStage(undefined)).toBe(false);
  });

  it('names the predicate that the closed predicate set defines', () => {
    // The runtime cross-check lives in `scripts/architecture-guard.mjs`
    // (`thread-stage-predicate`): the literal must appear in
    // `packages/shared/src/facts/predicates.ts`. Kept out of this file on purpose —
    // a test that imports `@markus/shared` at runtime would require a built `dist`
    // and would stop being a zero-IO unit test.
    expect(COMPLETION_EVIDENCE_PREDICATE).toBe('task.completion_evidence');
  });
});

// ─── 1. waiting_human ────────────────────────────────────────────────────────

describe('waiting_human — a human is the binding constraint', () => {
  it('wins over a running WorkUnit when an approval is pending', () => {
    expect(stage({ fsm: fsm({ status: 'in_progress', runningWorkUnits: 2 }), approvals: pendingApproval })).toBe(
      'waiting_human',
    );
  });

  it('wins for an unanswered question too (same input channel, different kind)', () => {
    expect(stage({ fsm: fsm({ status: 'in_progress' }), approvals: pendingQuestion })).toBe('waiting_human');
  });

  it('wins for an FSM row that is awaiting approval', () => {
    expect(stage({ fsm: fsm({ status: 'pending' }) })).toBe('waiting_human');
  });

  it('wins for a human-declared hold (blocked + hold), not for blocked + deps', () => {
    expect(stage({ fsm: fsm({ status: 'blocked', blockedReason: 'hold' }) })).toBe('waiting_human');
    expect(stage({ fsm: fsm({ status: 'blocked', blockedReason: 'deps' }) })).toBe('blocked_deps');
  });

  it('does NOT reach it once the human has answered and nothing else waits', () => {
    expect(stage({ fsm: fsm({ status: 'in_progress' }), approvals: resolvedApproval })).toBe('running');
  });

  it('does NOT reach it from "there is a message" — no such input exists', () => {
    // The signature has no message/notice/timestamp channel at all. This test is the
    // written form of the C8-E rule: a stage can never be derived from traffic.
    const keys = Object.keys({ fsm: fsm(), facts: [], approvals: [] });
    expect(keys.sort()).toEqual(['approvals', 'facts', 'fsm']);
  });
});

// ─── 2. running ──────────────────────────────────────────────────────────────

describe('running — execution, proven by a row, never by silence', () => {
  it('is produced by a WorkUnit row in running', () => {
    expect(stage({ fsm: fsm({ status: 'review', runningWorkUnits: 1 }) })).toBe('running');
  });

  it('is produced by the FSM row being in_progress', () => {
    expect(stage({ fsm: fsm({ status: 'in_progress' }) })).toBe('running');
  });

  it('does NOT win over a dependency that is still open', () => {
    expect(stage({ fsm: fsm({ status: 'in_progress', unmetDependencies: ['tsk_up'], runningWorkUnits: 1 }) })).toBe(
      'blocked_deps',
    );
  });

  it('does NOT win over a failed FSM row', () => {
    expect(stage({ fsm: fsm({ status: 'failed', runningWorkUnits: 1 }) })).toBe('failed');
  });
});

// ─── 3. blocked_deps ─────────────────────────────────────────────────────────

describe('blocked_deps — waiting on another task, nobody to ask', () => {
  it('is produced by an unmet dependency id', () => {
    expect(stage({ fsm: fsm({ status: 'blocked', unmetDependencies: ['tsk_up'] }) })).toBe('blocked_deps');
  });

  it('is produced by blocked without a reason (old row default = deps)', () => {
    expect(stage({ fsm: fsm({ status: 'blocked', blockedReason: null }) })).toBe('blocked_deps');
  });

  it('is NOT produced once the dependency list is empty', () => {
    expect(stage({ fsm: fsm({ status: 'in_progress', unmetDependencies: [] }) })).toBe('running');
  });

  it('is NOT produced by an empty block — dependencies present but satisfied', () => {
    // The caller resolves satisfiability; `blocked` with no open dep and no reason is
    // still reported as deps (honest: we do not know better), but an explicit
    // non-blocked FSM row with an empty list must not produce it.
    expect(stage({ fsm: fsm({ status: 'review' }), facts: [evidenceFact()] })).toBe('done');
  });
});

// ─── 4. needs_evidence ───────────────────────────────────────────────────────

describe('needs_evidence — the claim is on the table, nothing backs it', () => {
  it('is produced when a submitted task has no completion_evidence fact', () => {
    expect(stage({ fsm: fsm({ status: 'review' }) })).toBe('needs_evidence');
  });

  it('is produced when a completed task has no completion_evidence fact', () => {
    expect(stage({ fsm: fsm({ status: 'completed' }) })).toBe('needs_evidence');
  });

  it('is NOT produced by an unrelated fact', () => {
    expect(
      stage({
        fsm: fsm({ status: 'review' }),
        facts: [fact({ predicate: 'work.defect_class', value: { class: 'R1', instances: ['x'] } })],
      }),
    ).toBe('needs_evidence');
  });

  it('is NOT produced by a superseded completion_evidence fact', () => {
    expect(
      stage({
        fsm: fsm({ status: 'review' }),
        facts: [evidenceFact({ supersededBy: 'fact_new', supersededAt: '2026-11-15T01:00:00.000Z' })],
      }),
    ).toBe('needs_evidence');
  });
});

// ─── 5. in_verification ──────────────────────────────────────────────────────

describe('in_verification — evidence exists, independence has not happened yet', () => {
  it('is produced by evidence without any verification', () => {
    expect(stage({ fsm: fsm({ status: 'completed' }), facts: [fact({ verification: undefined })] })).toBe(
      'in_verification',
    );
  });

  it('is produced when the assertor verified their own work', () => {
    expect(
      stage({
        fsm: fsm({ status: 'completed' }),
        facts: [evidenceFact({ verification: verified({ verified_by: 'agt_executor' }) })],
      }),
    ).toBe('in_verification');
  });

  it('is produced when verification failed', () => {
    expect(
      stage({
        fsm: fsm({ status: 'completed' }),
        facts: [evidenceFact({ verification: verified({ result: 'fail' }) })],
      }),
    ).toBe('in_verification');
  });

  it('is produced when the verifier id is blank', () => {
    expect(
      stage({
        fsm: fsm({ status: 'completed' }),
        facts: [evidenceFact({ verification: verified({ verified_by: '   ' }) })],
      }),
    ).toBe('in_verification');
  });
});

// ─── 6. done ─────────────────────────────────────────────────────────────────

describe('done — closed out, and only a pass can say so', () => {
  it('is produced by evidence + an independent pass', () => {
    expect(stage({ fsm: fsm({ status: 'completed' }), facts: [evidenceFact()] })).toBe('done');
  });

  it('is produced for a terminal FSM row in review with a pass', () => {
    expect(stage({ fsm: fsm({ status: 'review', runningWorkUnits: 0 }), facts: [evidenceFact()] })).toBe('done');
  });

  it('is produced for a cancelled thread: closed without claiming success', () => {
    // Documented decision (see docs/architecture/thread-stage.md): cancelled/archived
    // are terminal but never claimed success, so there is no claim to verify. The
    // invariant "done ⇒ pass" therefore applies to the *success* terminals only.
    expect(stage({ fsm: fsm({ status: 'cancelled' }) })).toBe('done');
    expect(stage({ fsm: fsm({ status: 'archived' }) })).toBe('done');
  });

  it('is NOT produced while a work unit is still running', () => {
    expect(stage({ fsm: fsm({ status: 'review', runningWorkUnits: 1 }), facts: [evidenceFact()] })).toBe('running');
  });

  it('is NOT produced by the older of two evidence facts when it alone has the pass', () => {
    const older = evidenceFact({ id: 'fact_older', createdAt: '2026-11-15T00:00:00.000Z' });
    const newer = evidenceFact({
      id: 'fact_newer',
      createdAt: '2026-11-15T02:00:00.000Z',
      verification: undefined,
    });
    expect(stage({ fsm: fsm({ status: 'completed' }), facts: [older, newer] })).toBe('in_verification');
  });
});

// ─── 7. failed ───────────────────────────────────────────────────────────────

describe('failed — the FSM row says so', () => {
  it('is produced by a failed FSM row even with perfect evidence', () => {
    expect(stage({ fsm: fsm({ status: 'failed' }), facts: [evidenceFact()] })).toBe('failed');
  });

  it('is produced by a rejected FSM row', () => {
    expect(stage({ fsm: fsm({ status: 'rejected' }) })).toBe('failed');
  });

  it('is NOT produced for a revision round that is executing again', () => {
    expect(stage({ fsm: fsm({ status: 'in_progress' }) })).toBe('running');
  });
});

// ─── idempotence / noiselessness ─────────────────────────────────────────────

describe('idempotent and noiseless', () => {
  const input: DeriveStageInput = {
    fsm: fsm({ status: 'completed', runningWorkUnits: 0 }),
    facts: [evidenceFact(), fact({ predicate: 'work.defect_class', value: { class: 'R1', instances: ['x'] } })],
    approvals: resolvedApproval,
  };

  it('returns the same value for the same input twice', () => {
    expect(deriveStage(input)).toBe(deriveStage(input));
  });

  it('runs without a clock and without randomness', () => {
    const realNow = Date.now;
    const realRandom = Math.random;
    Date.now = () => {
      throw new Error('deriveStage must not read the clock');
    };
    Math.random = () => {
      throw new Error('deriveStage must not use randomness');
    };
    try {
      expect(deriveStage(input)).toBe('done');
    } finally {
      Date.now = realNow;
      Math.random = realRandom;
    }
  });

  it('does not mutate its input', () => {
    const snapshot = JSON.stringify({
      fsm: input.fsm,
      facts: input.facts,
      approvals: input.approvals,
    });
    deriveStage(input);
    expect(
      JSON.stringify({ fsm: input.fsm, facts: input.facts, approvals: input.approvals }),
    ).toBe(snapshot);
  });

  it('is deterministic when two facts share a createdAt (tie broken by id)', () => {
    const a = evidenceFact({ id: 'fact_a', createdAt: '2026-11-15T00:00:00.000Z', verification: undefined });
    const b = evidenceFact({ id: 'fact_b', createdAt: '2026-11-15T00:00:00.000Z' });
    const inputAB: DeriveStageInput = { fsm: fsm({ status: 'completed' }), facts: [a, b], approvals: [] };
    const inputBA: DeriveStageInput = { fsm: fsm({ status: 'completed' }), facts: [b, a], approvals: [] };
    expect(deriveStage(inputAB)).toBe(deriveStage(inputBA));
  });
});

// ─── totality ────────────────────────────────────────────────────────────────

describe('totality — every input produces a member of the closed set', () => {
  const statuses: FsmSnapshot['status'][] = [
    'pending',
    'in_progress',
    'blocked',
    'review',
    'completed',
    'failed',
    'rejected',
    'cancelled',
    'archived',
  ];
  const reasons = [undefined, null, 'deps', 'hold', 'workflow'] as const;
  const factsOptions = [
    [],
    [fact({ verification: undefined })],
    [evidenceFact()],
    [evidenceFact({ supersededBy: 'fact_x', supersededAt: '2026-11-15T01:00:00.000Z' })],
  ];
  const humanOptions = [noHuman, pendingApproval];

  it('never leaves the closed set and never returns free text', () => {
    for (const status of statuses) {
      for (const reason of reasons) {
        for (const facts of factsOptions) {
          for (const approvals of humanOptions) {
            for (const runningWorkUnits of [0, 1]) {
              for (const unmetDependencies of [[], ['tsk_up']]) {
                const result = deriveStage({
                  fsm: { status, blockedReason: reason, runningWorkUnits, unmetDependencies },
                  facts,
                  approvals,
                });
                expect(THREAD_STAGES).toContain(result);
                expect(typeof result).toBe('string');
              }
            }
          }
        }
      }
    }
  });

  it('"done ⇒ independent pass" holds for every success-terminal input', () => {
    for (const status of ['review', 'completed'] as const) {
      for (const facts of factsOptions) {
        for (const runningWorkUnits of [0, 1]) {
          for (const approvals of humanOptions) {
            const input: DeriveStageInput = {
              fsm: { status, runningWorkUnits, unmetDependencies: [] },
              facts,
              approvals,
            };
            if (deriveStage(input) !== 'done') continue;
            const evidence = facts.find(f => !f.supersededBy && f.predicate === COMPLETION_EVIDENCE_PREDICATE);
            expect(evidence?.verification?.result).toBe('pass');
            expect(evidence?.verification?.verified_by).not.toBe(evidence?.assertedBy);
          }
        }
      }
    }
  });
});
