/**
 * Facts layer — the **port** (C9-A).
 *
 * `@markus/core` only ever knows this interface. The single SQL writer lives in
 * `packages/org-manager/src/fact-service.ts`; keeping the port here is what lets
 * a caller be type-checked without importing a database.
 *
 * Why a port and not "just call the repo": the invariant is *one writer for the
 * facts table* in the whole repo. A port that has exactly one implementation
 * makes that a compile-time fact for every caller, and the architecture guard
 * makes it a CI fact as well.
 *
 * (This comment deliberately avoids quoting the write statements: the
 * acceptance check is a literal grep for them, and it must match exactly one
 * file — the implementation. A doc line that quotes the statement would make a
 * mechanical rule report two.)
 */
import type { FactSubjectKind } from '@markus/shared';

/** Verification is a fact about a fact; the assertor may not be its own verifier. */
export interface FactVerification {
  result: 'pass' | 'fail';
  /** Agent id of the verifier. `asserted_by` of the same row must differ. */
  verified_by: string;
  evidence_refs?: string[];
}

export interface FactRecord {
  id: string;
  subjectKind: FactSubjectKind;
  subjectId: string;
  predicate: string;
  /** Parsed `value_json`, validated by the predicate's schema at assert time. */
  value: unknown;
  workUnitRef: string;
  assertedBy: string;
  sourceRefs: string[];
  verification?: FactVerification;
  confidence: number;
  createdAt: string;
  /** Non-null ⇒ this row is history; `supersededAt` records when it stopped being current. */
  supersededBy?: string;
  supersededAt?: string;
}

export interface FactAssertInput {
  subjectKind: FactSubjectKind;
  subjectId: string;
  predicate: string;
  value: unknown;
  /**
   * The turn's WorkUnit ref. Comes from `AgentToolContext.turnWorkUnitRef()`
   * (C8 identity chain) — never re-derived from a payload. Empty ⇒ rejected.
   */
  workUnitRef: string;
  assertedBy: string;
  /** Evidence pointers (comment / deliverable / decision ids). Empty ⇒ rejected. */
  sourceRefs: string[];
  verification?: FactVerification;
  confidence?: number;
}

export interface FactSupersedeInput extends FactAssertInput {
  /** The fact being replaced. Must exist and still be active. */
  supersededFactId: string;
  /** Why the old conclusion no longer holds (goes into the new fact's provenance). */
  reason: string;
}

export type FactRejectionCode =
  | 'unknown_predicate'
  | 'schema_violation'
  | 'missing_provenance'
  | 'self_verification_forbidden'
  | 'must_supersede'
  | 'not_found'
  | 'disabled'
  | 'invalid_subject';

export interface FactRejected {
  status: 'rejected';
  code: FactRejectionCode;
  /** Actionable text — the model must be able to fix the call from this alone. */
  message: string;
  /** For `unknown_predicate`: the nearest legal predicates. */
  allowed?: string[];
  /** For `schema_violation`: the failing path, e.g. `/evidence_refs/0`. */
  path?: string;
  /** For `must_supersede` / `not_found`: the row that already exists. */
  existingFactId?: string;
}

export interface FactAsserted {
  status: 'asserted';
  fact: FactRecord;
}

export type FactWriteResult = FactAsserted | FactRejected;

export interface FactQuery {
  subjectKind?: FactSubjectKind;
  subjectId?: string;
  /** Exact predicate match. */
  predicate?: string;
  /** Structured prefix match, e.g. `task.` — not a semantic search. */
  predicatePrefix?: string;
  /** Fetch one row by id (still subject to the `activeOnly` rule). */
  factId?: string;
  /** Default true: only current rows. `false` returns superseded history too. */
  activeOnly?: boolean;
  limit?: number;
}

export interface FactService {
  assert(input: FactAssertInput): FactWriteResult;
  /** One call = "assert the new + mark the old". Never two steps. */
  supersede(input: FactSupersedeInput): FactWriteResult;
  /** Exact matching only. No fuzzy / semantic search on the fact layer. */
  queryActive(query: FactQuery): FactRecord[];
}

/** Compact one-line JSON rendering used by the prompt block (stable key order). */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
}
