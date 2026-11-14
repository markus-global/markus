/**
 * C9-C · the **one** place a task subject obtains its thread stage.
 *
 * The derivation itself is a pure function living in `@markus/core`
 * (`facts/derive-stage.ts`). Everything that needs IO to answer the question —
 * "is a dependency still open?", "is a human being asked something?", "is a
 * WorkUnit running?", "which facts back the claim?" — happens here, once, and is
 * handed to that function as data.
 *
 * Why IO is not allowed inside the derivation: the badge used to be assembled by
 * whichever component happened to have loaded something, which produced four
 * slightly different answers to the same question. A pure derivation plus a single
 * reader is the shape that cannot drift; it also makes the whole rule set testable
 * without a database.
 *
 * The web UI never receives the facts as a table it can re-derive from — it receives
 * a stage from the closed set plus the evidence pointers it is allowed to *show*.
 * That keeps "who is this waiting for" at exactly one writer.
 */
import { deriveStage, type Approval, type FactRecord, type FsmSnapshot, type ThreadStage } from '@markus/core';

/** Re-exported so callers (routes/tests) build the same input shape the derivation reads. */
export type { Approval };

/** The nine governance states, matching `TaskStatus` and `ThreadFsmStatus`. */
const KNOWN_FSM_STATUSES = [
  'pending',
  'in_progress',
  'blocked',
  'review',
  'completed',
  'failed',
  'rejected',
  'cancelled',
  'archived',
] as const;

type KnownFsmStatus = (typeof KNOWN_FSM_STATUSES)[number];

function toFsmStatus(status: string): KnownFsmStatus {
  // A status outside the enum means the row predates the enum or a future value
  // leaked in. Treat it as "open, someone is working on it" — the alternative
  // (`failed`) would turn a data problem into a false failure signal on the board.
  return (KNOWN_FSM_STATUSES as readonly string[]).includes(status)
    ? (status as KnownFsmStatus)
    : 'in_progress';
}

/** Minimal shapes so this module can be tested without a server. */
export interface ThreadStageTaskRow {
  id: string;
  status: string;
  blockedReason?: string | null;
  blockedBy?: string[];
}

export interface ThreadStageDeps {
  /** Dependency lookup — the *only* way a dependency's satisfaction is decided here. */
  getDependencyStatus?: (taskId: string) => string | undefined;
  /** Pending human needs targeted at this task (approvals + open questions). */
  pendingHumanNeeds?: readonly Approval[];
  /** WorkUnits in `running` for this task. Absent = 0 (see note below). */
  runningWorkUnits?: number;
  /** Active facts for the subject, already scoped by the caller. */
  facts?: readonly FactRecord[];
}

/** Evidence pointer set the UI is allowed to render ("凭什么说做完了"). */
export interface ThreadEvidenceView {
  factId: string;
  predicate: string;
  value: unknown;
  assertedBy: string;
  /** Comment / deliverable / decision ids the claim points at. Rendered as links. */
  sourceRefs: string[];
  verification: { result: 'pass' | 'fail'; verifiedBy: string } | null;
  createdAt: string;
}

export interface ThreadStageView {
  stage: ThreadStage;
  /** Current facts for the subject, newest first. Never a superseded row. */
  evidence: ThreadEvidenceView[];
}

/**
 * Derive the stage for a task row.
 *
 * Pure with respect to storage: every input arrives in `deps`. Note on
 * `runningWorkUnits`: when a caller does not supply it, the FSM row still answers
 * "is this in flight" (`in_progress` ⇒ `running`), and the missing count can only
 * ever *withhold* a promotion, never invent one. That is deliberate — this
 * workspace has seen what an optimistic "it's running" looks like.
 */
export function deriveTaskThreadStage(task: ThreadStageTaskRow, deps: ThreadStageDeps = {}): ThreadStage {
  const blockedBy = task.blockedBy ?? [];
  const unmetDependencies = blockedBy.filter(id => {
    const status = deps.getDependencyStatus?.(id);
    // Unknown dependency (row not loaded) counts as open: a stage that pretends a
    // dependency is satisfied is worse than one that says "waiting".
    if (status === undefined) return true;
    return status !== 'completed' && status !== 'archived';
  });

  const fsm: FsmSnapshot = {
    status: toFsmStatus(task.status),
    blockedReason: (task.blockedReason ?? null) as FsmSnapshot['blockedReason'],
    unmetDependencies,
    runningWorkUnits: deps.runningWorkUnits ?? 0,
  };

  return deriveStage({
    fsm,
    facts: deps.facts ?? [],
    approvals: deps.pendingHumanNeeds ?? [],
  });
}

/** Project facts for the read-only evidence fold: current rows only, newest first. */
export function toEvidenceView(facts: readonly FactRecord[]): ThreadEvidenceView[] {
  return facts
    .filter(f => !f.supersededBy && !f.supersededAt)
    .slice()
    .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1))
    .map(f => ({
      factId: f.id,
      predicate: f.predicate,
      value: f.value,
      assertedBy: f.assertedBy,
      sourceRefs: f.sourceRefs,
      verification: f.verification
        ? { result: f.verification.result, verifiedBy: f.verification.verified_by }
        : null,
      createdAt: f.createdAt,
    }));
}
