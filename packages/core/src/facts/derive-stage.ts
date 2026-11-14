/**
 * Thread stage — the **only** answer to "who is this thread waiting for" (C9-C).
 *
 * One derivation, seven possible answers, zero IO. The function is pure on purpose:
 * the previous generation of this knowledge lived in four UI files that each
 * re-assembled "what is going on" from whatever they happened to have loaded
 * (approvals here, unread notices there, `blockedBy` inferred a third way). Four
 * writers, one fact, four answers — and the answer that mattered ("is it running?")
 * was derived from *whether a message existed*, which is how a stopped agent kept
 * showing as busy (C8-E lesson).
 *
 * Therefore:
 *
 * - **Every stage must be traceable to one structural row** — an FSM row, a
 *   dependency row, a WorkUnit row, an approval row, or a fact. There is no branch
 *   below that reads "did anything happen recently".
 * - **Superseded facts never participate.** History is history: a conclusion that
 *   was replaced cannot keep a thread in `done`.
 * - **The output is a closed set.** `ThreadStage` is a union, the only string this
 *   file can produce comes from `THREAD_STAGES`, and `isThreadStage()` is the guard
 *   every boundary uses instead of trusting a string that crossed JSON.
 *
 * The mapping below is the frozen table from the C9 execution plan (§6.1); the
 * precedence order is this file's one contribution and is documented per rule so
 * that "which rule won" is answerable without running the tests.
 */
import type { FactRecord, FactVerification } from './fact-service.js';

/**
 * The closed set. Order is the documentation order, not a priority order
 * (priority is the explicit sequence in `deriveStage`).
 */
export const THREAD_STAGES = [
  'waiting_human',
  'running',
  'needs_evidence',
  'in_verification',
  'done',
  'blocked_deps',
  'failed',
] as const;

export type ThreadStage = (typeof THREAD_STAGES)[number];

/** Runtime guard for stage values that crossed a JSON boundary (API response). */
export function isThreadStage(value: unknown): value is ThreadStage {
  return typeof value === 'string' && (THREAD_STAGES as readonly string[]).includes(value);
}

/**
 * The governance state of the subject — the same nine values as `TaskStatus`.
 *
 * Declared structurally (not imported from the task service) because `fsm` is a
 * *snapshot*: the caller may fill it from a task row, from a test, or from a
 * future subject kind that is also governed by an FSM. A snapshot never queries.
 */
export type ThreadFsmStatus =
  | 'pending'
  | 'in_progress'
  | 'blocked'
  | 'review'
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'cancelled'
  | 'archived';

/**
 * Everything the FSM knows about the subject, already resolved by the caller.
 *
 * `unmetDependencies` carries **ids of dependencies that are not completed yet** —
 * not the raw `blockedBy` array. Resolving that needs a lookup, and a lookup is IO;
 * doing it here would be the second writer of "is this dependency satisfied".
 */
export interface FsmSnapshot {
  status: ThreadFsmStatus;
  /**
   * The server-recorded reason for `blocked` (single discriminator, see
   * `web-ui/src/lib/blockedReason.ts`). `hold` means a human declared the pause,
   * so the thread is waiting for a human — not for the engine.
   */
  blockedReason?: 'deps' | 'hold' | 'workflow' | null;
  /** Ids of dependencies that are still open. Empty/absent = nothing to wait for. */
  unmetDependencies?: readonly string[];
  /**
   * WorkUnits currently in `running` for this subject. Positive-only signal: a
   * non-zero value promotes to `running`, zero never demotes anything.
   */
  runningWorkUnits?: number;
}

/**
 * A human need: an approval decision or an unanswered question.
 *
 * `kind` is what the human has to do, not where it came from — `request_user_input`
 * (a question) and an approval both block the same thread the same way, and both
 * belong to one input channel. Two arrays would let a caller fill one and forget
 * the other.
 */
export interface Approval {
  kind: 'approval' | 'question';
  status: 'pending' | 'resolved';
}

export interface DeriveStageInput {
  fsm: FsmSnapshot;
  /** Facts for **this subject only**. Cross-subject facts are the caller's bug, not a filter here. */
  facts: readonly FactRecord[];
  approvals: readonly Approval[];
}

/**
 * The predicate whose presence means "the executor claims this work is done".
 * Declared as data and cross-checked against the closed predicate set in the test,
 * so a rename in `@markus/shared` turns red instead of silently making every thread
 * `needs_evidence`.
 */
export const COMPLETION_EVIDENCE_PREDICATE = 'task.completion_evidence';

/** A fact is current when nothing superseded it. Both columns are written together. */
function isActive(fact: FactRecord): boolean {
  return !fact.supersededBy && !fact.supersededAt;
}

/**
 * Current fact for a predicate. Deterministic: newest `createdAt` wins, and ties are
 * broken by id so two calls on the same set can never disagree (no clock, no sort
 * instability).
 */
function latestActive(facts: readonly FactRecord[], predicate: string): FactRecord | undefined {
  let best: FactRecord | undefined;
  for (const fact of facts) {
    if (fact.predicate !== predicate || !isActive(fact)) continue;
    if (!best) {
      best = fact;
      continue;
    }
    if (fact.createdAt > best.createdAt) best = fact;
    else if (fact.createdAt === best.createdAt && fact.id > best.id) best = fact;
  }
  return best;
}

/**
 * "An independent verifier passed it."
 *
 * The check is repeated here even though `FactService.assert` already rejects
 * self-verification and the identity audit has a gate for it: this function reads a
 * table that a future writer could fill without going through either. A read path
 * that trusts the row is exactly how "I verified my own work" comes back.
 */
function independentPass(verification: FactVerification | undefined, assertedBy: string): boolean {
  if (!verification) return false;
  if (verification.result !== 'pass') return false;
  const verifier = verification.verified_by?.trim();
  if (!verifier) return false;
  return verifier !== assertedBy;
}

function isOnHold(fsm: FsmSnapshot): boolean {
  return fsm.status === 'blocked' && fsm.blockedReason === 'hold';
}

function hasUnmetDependencies(fsm: FsmSnapshot): boolean {
  // An explicit resolution wins — including the answer "nothing is open". The caller
  // that resolved the graph knows more than the coarse `blocked` flag does; a task
  // still flagged `blocked` with every dependency complete is an engine anomaly, and
  // reporting it as "waiting on deps" would tell the reader to wait for something
  // that already finished.
  if (fsm.unmetDependencies !== undefined) return fsm.unmetDependencies.length > 0;
  // Nobody resolved the graph (old row / caller without it): fall back to the FSM's
  // own flag, using the same default the rest of the codebase uses for an unknown
  // reason (`web-ui/src/lib/blockedReason.ts`: absent reason = `deps`).
  return fsm.status === 'blocked';
}

/**
 * Derive the stage. Total: every input produces exactly one of the seven values.
 *
 * Precedence (first match wins) — each rule names its structural source:
 *
 *  1. `failed`            ← FSM row is failed / rejected. Terminal: nothing else matters.
 *  2. `waiting_human`     ← a pending approval/question row, the FSM row is `pending`
 *                           (awaiting approval), or the FSM row is `blocked` + `hold`
 *                           (a human declared the pause). A human is the binding
 *                           constraint, so this outranks execution.
 *  3. `blocked_deps`      ← an open dependency row. The engine resumes this by itself;
 *                           no human is involved, which is why it is not `waiting_human`.
 *  4. `running`           ← a WorkUnit row in `running`, or the FSM row is `in_progress`.
 *                           Positive-only: absence of a WorkUnit proves nothing (a turn
 *                           boundary is not a state change).
 *  5. `done` (closed)     ← FSM row is cancelled/archived. The thread was closed
 *                           without anyone claiming success, so there is no claim to
 *                           verify; what matters to a reader is that nobody is waiting.
 *  6. `needs_evidence`    ← no active `task.completion_evidence` fact. The claim is
 *                           on the table (status is review/completed) and nothing
 *                           backs it.
 *  7. `in_verification`   ← evidence exists but no independent `pass` verification.
 *                           Note `fail` also lands here: a disproven claim is still
 *                           unevidenced, and the load-bearing rule is that only a
 *                           pass can produce `done`.
 *  8. `done`              ← evidence + independent pass.
 */
export function deriveStage(input: DeriveStageInput): ThreadStage {
  const { fsm, facts, approvals } = input;

  if (fsm.status === 'failed' || fsm.status === 'rejected') return 'failed';

  const pendingHuman = approvals.some(a => a.status === 'pending');
  if (pendingHuman || fsm.status === 'pending' || isOnHold(fsm)) return 'waiting_human';

  if (hasUnmetDependencies(fsm)) return 'blocked_deps';

  if ((fsm.runningWorkUnits ?? 0) > 0 || fsm.status === 'in_progress') return 'running';

  if (fsm.status === 'cancelled' || fsm.status === 'archived') return 'done';

  const evidence = latestActive(facts, COMPLETION_EVIDENCE_PREDICATE);
  if (!evidence) return 'needs_evidence';

  if (!independentPass(evidence.verification, evidence.assertedBy)) return 'in_verification';

  return 'done';
}
