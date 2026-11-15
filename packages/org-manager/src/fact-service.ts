/**
 * FactService — the **only** SQL writer of `facts` (C9-A).
 *
 * Invariant, machine-checked by `scripts/architecture-guard.mjs`
 * (`facts-single-writer`): the facts write statements appear in this file and
 * nowhere else under packages/<pkg>/src. A second write path is a CI failure,
 * not a review comment.
 *
 * Division of labour with the DB:
 *   · the DB guards *shape* — immutability (`facts_no_rewrite`) and mandatory
 *     provenance (`facts_require_provenance`) hold even for a future writer that
 *     forgets to validate;
 *   · this service guards *meaning* — closed predicate set, value schema,
 *     no self-verification, and "replacing a conclusion is its own decision"
 *     (`must_supersede` instead of a silent overwrite).
 *
 * Every rejection is actionable: a model that gets `unknown_predicate` back
 * receives the nearest legal names, and `schema_violation` names the JSON path.
 * Silence would leave it guessing, which is what produced prose-as-record.
 */
import {
  FACT_PREDICATES,
  findFactPredicate,
  generateId,
  nearestFactPredicates,
  validateFactValue,
  type FactSubjectKind,
} from '@markus/shared';
import type {
  FactAssertInput,
  FactQuery,
  FactRecord,
  FactService,
  FactSupersedeInput,
  FactVerification,
  FactVerifyInput,
  FactWriteResult,
} from '@markus/core';

/** Minimal structural view of the SQLite handle — no dependency on the driver type. */
export interface FactDb {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes?: number | bigint };
  };
  exec(sql: string): void;
}

export interface FactServiceOptions {
  /** Clock injection: deterministic `created_at` in tests, one source in production. */
  now?: () => string;
}

interface FactRow {
  id: string;
  subject_kind: string;
  subject_id: string;
  predicate: string;
  value_json: string;
  work_unit_ref: string;
  asserted_by: string;
  source_refs_json: string;
  verification_json: string | null;
  confidence: number | string;
  created_at: string;
  superseded_by: string | null;
  superseded_at: string | null;
}

const SUBJECT_KINDS: readonly FactSubjectKind[] = [
  'task',
  'requirement',
  'agent',
  'deliverable',
  'work_unit',
];

function trimmed(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw === null || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // A corrupt cell must not take down a prompt build or a tool call; the
    // caller sees the raw text instead of a fabricated empty value.
    return fallback;
  }
}

export class SqliteFactService implements FactService {
  private readonly now: () => string;

  constructor(
    private readonly db: FactDb,
    opts: FactServiceOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  // ─── write ────────────────────────────────────────────────────────────────

  assert(input: FactAssertInput): FactWriteResult {
    const checked = this.validate(input);
    if (checked) return checked;

    const active = this.findActive(input.subjectKind, input.subjectId, input.predicate);
    if (active) {
      return {
        status: 'rejected',
        code: 'must_supersede',
        message:
          `An active fact already states this predicate for this subject (${active.id}). ` +
          'Replacing a conclusion is its own decision: call fact_supersede with the new value and a reason.',
        existingFactId: active.id,
      };
    }

    const fact = this.insert(input);
    return { status: 'asserted', fact };
  }

  supersede(input: FactSupersedeInput): FactWriteResult {
    const checked = this.validate(input);
    if (checked) return checked;
    if (trimmed(input.reason).length === 0) {
      return {
        status: 'rejected',
        code: 'schema_violation',
        path: '/reason',
        message: 'fact_supersede needs a non-empty reason: history must stay explainable.',
      };
    }

    const old = this.getById(input.supersededFactId);
    if (!old) {
      return {
        status: 'rejected',
        code: 'not_found',
        message: `No fact with id ${input.supersededFactId}.`,
      };
    }
    if (old.supersededBy) {
      return {
        status: 'rejected',
        code: 'must_supersede',
        message: `Fact ${old.id} was already superseded by ${old.supersededBy}; supersede that one instead.`,
        existingFactId: old.supersededBy,
      };
    }
    if (
      old.subjectKind !== input.subjectKind ||
      old.subjectId !== input.subjectId ||
      old.predicate !== input.predicate
    ) {
      return {
        status: 'rejected',
        code: 'invalid_subject',
        message:
          `Fact ${old.id} is ${old.subjectKind}:${old.subjectId} ${old.predicate}; ` +
          'a supersede must state the same subject and predicate (a different one is a new fact).',
      };
    }

    // Mark-then-insert inside ONE transaction: a two-step API guarantees someone
    // does only one half. FK checks are deferred to COMMIT because the new id
    // does not exist yet at the moment the old row points at it.
    const newId = generateId('fact');
    const at = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('PRAGMA defer_foreign_keys = ON');
      this.db
        .prepare('UPDATE facts SET superseded_by = ?, superseded_at = ? WHERE id = ?')
        .run(newId, at, old.id);
      const fact = this.insert(input, newId, at);
      this.db.exec('COMMIT');
      return { status: 'asserted', fact };
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // SQLite may already have rolled back (RAISE(ROLLBACK)); the insert error is the one to report.
      }
      throw err;
    }
  }

  // ─── verify (C9-E) ───────────────────────────────────────────────────────

  /**
   * Record an independent verdict on an existing fact.
   *
   * Writes **one column**: `verification_json`. Everything the verdict judges —
   * value, predicate, subject, identity — is left alone, so a verifier can never
   * become a second writer of the conclusion (the `facts_no_rewrite` trigger would
   * abort such an update anyway).
   *
   * Write-once is deliberate: flipping a verdict in place would make one column two
   * writers over time. A changed verdict is a changed claim -> supersede the claim
   * (the new row starts unverified) and judge that.
   */
  verify(input: FactVerifyInput): FactWriteResult {
    const fact = this.getById(input.factId);
    if (!fact) {
      return {
        status: 'rejected',
        code: 'not_found',
        message: `No fact with id ${input.factId}. Use fact_query to find the active fact for this subject and predicate.`,
      };
    }
    if (fact.supersededBy) {
      return {
        status: 'rejected',
        code: 'must_supersede',
        message:
          `Fact ${fact.id} was superseded by ${fact.supersededBy}. A superseded claim keeps the verdict ` +
          'it had; verify the current row instead (fact_query with activeOnly).',
        existingFactId: fact.supersededBy,
      };
    }

    if (trimmed(input.verifiedBy).length === 0 || trimmed(input.workUnitRef).length === 0) {
      return {
        status: 'rejected',
        code: 'missing_provenance',
        message:
          'A verdict needs identity: verified_by and the verifier turn work_unit_ref ' +
          '(this turn is not bound to a WorkUnit). Empty is an error, not a default.',
      };
    }

    // The load-bearing check: producer != confirmer.
    if (trimmed(input.verifiedBy) === fact.assertedBy) {
      return {
        status: 'rejected',
        code: 'self_verification_forbidden',
        message:
          `Agent ${fact.assertedBy} asserted this fact, so it cannot verify it. ` +
          'Verification must come from a different agent (producer != confirmer): the task reviewer, ' +
          'or an agent designated by the owning team manager for cross-team work.',
      };
    }

    if (input.result !== 'pass' && input.result !== 'fail') {
      return {
        status: 'rejected',
        code: 'schema_violation',
        path: '/result',
        message: 'verification.result must be "pass" or "fail".',
      };
    }

    const evidenceRefs = (Array.isArray(input.evidenceRefs) ? input.evidenceRefs : [])
      .filter(r => trimmed(r).length > 0);
    if (evidenceRefs.length === 0) {
      return {
        status: 'rejected',
        code: 'schema_violation',
        path: '/evidence_refs',
        message:
          `A ${input.result} verdict needs at least one evidence_ref (comment / deliverable / decision id, or a path). ` +
          'A verdict with no pointer is the same unfalsifiable claim as prose.',
      };
    }

    if (fact.verification) {
      return {
        status: 'rejected',
        code: 'already_verified',
        message:
          `Fact ${fact.id} already carries a verdict (${fact.verification.result} by ${fact.verification.verified_by}). ` +
          'A changed verdict is a changed claim: supersede the claim with new evidence (fact_supersede), ' +
          'then verify the new row.',
        existingFactId: fact.id,
      };
    }

    const verification: FactVerification = {
      result: input.result,
      verified_by: trimmed(input.verifiedBy),
      evidence_refs: evidenceRefs,
      verified_at: this.now(),
      work_unit_ref: trimmed(input.workUnitRef),
    };

    this.db
      .prepare('UPDATE facts SET verification_json = ? WHERE id = ?')
      .run(JSON.stringify(verification), fact.id);

    const updated = this.getById(fact.id);
    if (!updated) throw new Error(`fact ${fact.id} vanished right after verify`);
    return { status: 'asserted', fact: updated };
  }

  // ─── read ─────────────────────────────────────────────────────────────────

  queryActive(query: FactQuery): FactRecord[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.factId !== undefined) {
      where.push('id = ?');
      params.push(query.factId);
    }
    if (query.subjectKind !== undefined) {
      where.push('subject_kind = ?');
      params.push(query.subjectKind);
    }
    if (query.subjectId !== undefined) {
      where.push('subject_id = ?');
      params.push(query.subjectId);
    }
    if (query.predicate !== undefined) {
      where.push('predicate = ?');
      params.push(query.predicate);
    }
    if (query.predicatePrefix !== undefined) {
      where.push('predicate LIKE ?');
      params.push(`${query.predicatePrefix}%`);
    }
    if (query.activeOnly !== false) where.push('superseded_by IS NULL');
    if (query.createdAfter !== undefined) {
      where.push('created_at >= ?');
      params.push(query.createdAfter);
    }
    if (query.createdBefore !== undefined) {
      where.push('created_at <= ?');
      params.push(query.createdBefore);
    }
    const limit = Math.max(1, Math.min(query.limit ?? 200, 1000));
    const sql =
      `SELECT * FROM facts` +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY predicate ASC, created_at ASC LIMIT ?';
    const rows = this.db.prepare(sql).all(...params, limit) as FactRow[];
    return rows.map(r => this.toRecord(r));
  }

  // ─── internals ────────────────────────────────────────────────────────────

  /** All meaning-level checks, in the order that gives the most actionable error. */
  private validate(input: FactAssertInput): FactWriteResult | undefined {
    if (!SUBJECT_KINDS.includes(input.subjectKind)) {
      return {
        status: 'rejected',
        code: 'invalid_subject',
        message: `Unknown subject kind "${input.subjectKind}". Legal: ${SUBJECT_KINDS.join(', ')}.`,
      };
    }
    if (trimmed(input.subjectId).length === 0) {
      return {
        status: 'rejected',
        code: 'invalid_subject',
        message: 'subject_id is required — a fact about nothing cannot be superseded or queried.',
      };
    }

    const spec = findFactPredicate(input.predicate);
    if (!spec) {
      return {
        status: 'rejected',
        code: 'unknown_predicate',
        message:
          `Unknown predicate "${input.predicate}". Predicates are a closed set — ` +
          `nearest legal: ${nearestFactPredicates(input.predicate).join(', ')}.`,
        allowed: nearestFactPredicates(input.predicate),
      };
    }
    if (!spec.subjectKinds.includes(input.subjectKind)) {
      return {
        status: 'rejected',
        code: 'invalid_subject',
        message: `${spec.predicate} applies to ${spec.subjectKinds.join('|')}, not ${input.subjectKind}.`,
      };
    }

    const valueCheck = validateFactValue(input.predicate, input.value);
    if (!valueCheck.ok) {
      return {
        status: 'rejected',
        code: 'schema_violation',
        path: valueCheck.issue.path,
        message: `${spec.predicate}${valueCheck.issue.path || ''}: ${valueCheck.issue.message}`,
        allowed: spec.predicate ? undefined : undefined,
      };
    }

    if (
      trimmed(input.workUnitRef).length === 0 ||
      trimmed(input.assertedBy).length === 0 ||
      !Array.isArray(input.sourceRefs) ||
      input.sourceRefs.filter(r => trimmed(r).length > 0).length === 0
    ) {
      return {
        status: 'rejected',
        code: 'missing_provenance',
        message:
          'A fact needs identity: work_unit_ref (this turn is not bound to a WorkUnit), ' +
          'asserted_by, and at least one source_ref. Empty is an error, not a default.',
      };
    }

    const verification = input.verification;
    if (verification && verification.verified_by === input.assertedBy) {
      return {
        status: 'rejected',
        code: 'self_verification_forbidden',
        message:
          'The assertor cannot verify its own fact. Verification must come from a different agent ' +
          '(producer ≠ confirmer).',
      };
    }

    return undefined;
  }

  private insert(input: FactAssertInput, forcedId?: string, forcedAt?: string): FactRecord {
    const id = forcedId ?? generateId('fact');
    const createdAt = forcedAt ?? this.now();
    const verification: FactVerification | undefined = input.verification;
    this.db
      .prepare(
        `INSERT INTO facts
           (id, subject_kind, subject_id, predicate, value_json, work_unit_ref,
            asserted_by, source_refs_json, verification_json, confidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.subjectKind,
        input.subjectId,
        input.predicate,
        JSON.stringify(input.value),
        trimmed(input.workUnitRef),
        trimmed(input.assertedBy),
        JSON.stringify(input.sourceRefs),
        verification ? JSON.stringify(verification) : null,
        typeof input.confidence === 'number' ? input.confidence : 1.0,
        createdAt,
      );
    const row = this.getById(id);
    if (!row) throw new Error(`fact ${id} vanished right after insert`);
    return row;
  }

  private findActive(
    subjectKind: FactSubjectKind,
    subjectId: string,
    predicate: string,
  ): FactRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM facts
          WHERE subject_kind = ? AND subject_id = ? AND predicate = ? AND superseded_by IS NULL`,
      )
      .get(subjectKind, subjectId, predicate) as FactRow | undefined;
    return row ? this.toRecord(row) : undefined;
  }

  private getById(id: string): FactRecord | undefined {
    const row = this.db.prepare('SELECT * FROM facts WHERE id = ?').get(id) as FactRow | undefined;
    return row ? this.toRecord(row) : undefined;
  }

  private toRecord(row: FactRow): FactRecord {
    const verification = parseJson<FactVerification | null>(row.verification_json, null);
    return {
      id: row.id,
      subjectKind: row.subject_kind as FactSubjectKind,
      subjectId: row.subject_id,
      predicate: row.predicate,
      value: parseJson<unknown>(row.value_json, row.value_json),
      workUnitRef: row.work_unit_ref,
      assertedBy: row.asserted_by,
      sourceRefs: parseJson<string[]>(row.source_refs_json, []),
      verification: verification ?? undefined,
      confidence: Number(row.confidence),
      createdAt: row.created_at,
      supersededBy: row.superseded_by ?? undefined,
      supersededAt: row.superseded_at ?? undefined,
    };
  }
}

/** The closed set, re-exported so gate/injection code reads ONE list. */
export const FACT_PREDICATE_LIST: readonly string[] = FACT_PREDICATES.map(p => p.predicate);
