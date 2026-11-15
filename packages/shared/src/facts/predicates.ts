/**
 * Facts layer — the **closed set** of predicates (C9-A).
 *
 * A predicate is a contract, not data: adding one means writing a schema, a
 * meaning, and a statement of who may assert it. So it lives in code where a
 * reviewer sees it at compile time, not in a runtime-registered table.
 *
 * There is deliberately no `custom.*` escape hatch and no registration entry
 * point. A closed set is the only thing on this path that prevents
 * "structure inferred from payload": opening the set just turns prose into
 * JSON key names.
 */

export type FactSubjectKind = 'task' | 'requirement' | 'agent' | 'deliverable' | 'work_unit';

/** Who is allowed to assert a predicate. Advisory at the tool layer, enforced by review/prompt. */
export type FactAssertorRole = 'executor' | 'reviewer' | 'verifier' | 'any';

export interface FactValidationIssue {
  /** JSON-pointer-ish path into the value, e.g. `/evidence_refs/0`. */
  path: string;
  message: string;
}

export type FactValueValidation = { ok: true } | { ok: false; issue: FactValidationIssue };

export interface FactPredicateSpec {
  /** Dotted, stable, machine-readable name. The dictionary order is the prompt order. */
  predicate: string;
  /** Subject kinds this predicate can be asserted about. */
  subjectKinds: readonly FactSubjectKind[];
  /** One sentence a human reads in the docs and the model reads in the schema. */
  summary: string;
  /** Who may assert it (§4.2 of the execution plan). */
  assertor: FactAssertorRole;
  validate(value: unknown): FactValueValidation;
}

// ─── value validators ────────────────────────────────────────────────────────
//
// Hand-rolled on purpose: `@markus/shared` has zero runtime dependencies, and
// pulling a schema library in for six shapes would add a second source of truth
// for what "valid" means somewhere third-party.

function ok(): FactValueValidation {
  return { ok: true };
}

function fail(path: string, message: string): FactValueValidation {
  return { ok: false, issue: { path, message } };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireObject(value: unknown, allowed: readonly string[]): FactValueValidation {
  if (!isPlainObject(value)) return fail('', 'must be an object');
  const extra = Object.keys(value).filter(k => !allowed.includes(k));
  if (extra.length > 0) return fail(`/${extra[0]}`, `unknown field "${extra[0]}"`);
  return ok();
}

function nonEmptyString(v: unknown, path: string): FactValidationIssue | undefined {
  if (typeof v !== 'string') return { path, message: 'must be a non-empty string' };
  if (v.trim().length === 0) return { path, message: 'must be a non-empty string' };
  return undefined;
}

function stringArray(v: unknown, path: string, minItems: number): FactValidationIssue | undefined {
  if (!Array.isArray(v)) return { path, message: 'must be an array of strings' };
  if (v.length < minItems) return { path, message: `needs at least ${minItems} item(s)` };
  for (let i = 0; i < v.length; i += 1) {
    const issue = nonEmptyString(v[i], `${path}/${i}`);
    if (issue) return issue;
  }
  return undefined;
}

/** Shorthand: build a validator from required field checks, stopping at the first issue. */
function objectWith(
  allowed: readonly string[],
  required: readonly string[],
  check: (obj: Record<string, unknown>) => FactValidationIssue | undefined,
): (value: unknown) => FactValueValidation {
  return (value: unknown): FactValueValidation => {
    const shape = requireObject(value, allowed);
    if (!shape.ok) return shape;
    const obj = value as Record<string, unknown>;
    for (const field of required) {
      if (obj[field] === undefined) return fail(`/${field}`, 'is required');
    }
    const issue = check(obj);
    return issue ? { ok: false, issue } : ok();
  };
}

const validateCompletionEvidence = objectWith(
  ['summary', 'evidence_refs'],
  ['summary', 'evidence_refs'],
  obj => nonEmptyString(obj['summary'], '/summary') ?? stringArray(obj['evidence_refs'], '/evidence_refs', 1),
);

const validateRejectionReason = objectWith(
  ['reason', 'blocking_refs'],
  ['reason', 'blocking_refs'],
  obj => nonEmptyString(obj['reason'], '/reason') ?? stringArray(obj['blocking_refs'], '/blocking_refs', 0),
);

const validateAcceptanceMet = objectWith(
  ['criteria_id', 'met', 'note'],
  ['criteria_id', 'met'],
  obj => {
    const idIssue = nonEmptyString(obj['criteria_id'], '/criteria_id');
    if (idIssue) return idIssue;
    if (typeof obj['met'] !== 'boolean') return { path: '/met', message: 'must be a boolean' };
    if (obj['note'] !== undefined && typeof obj['note'] !== 'string') {
      return { path: '/note', message: 'must be a string' };
    }
    return undefined;
  },
);

const DEFECT_CLASSES = ['R1', 'R2', 'R3', 'R4'] as const;

const validateDefectClass = objectWith(
  ['class', 'instances'],
  ['class', 'instances'],
  obj => {
    if (!DEFECT_CLASSES.includes(obj['class'] as (typeof DEFECT_CLASSES)[number])) {
      return { path: '/class', message: `must be one of ${DEFECT_CLASSES.join('|')}` };
    }
    return stringArray(obj['instances'], '/instances', 0);
  },
);

const validateCapabilityClaim = objectWith(
  ['capability', 'evidence_refs'],
  ['capability', 'evidence_refs'],
  obj => nonEmptyString(obj['capability'], '/capability') ?? stringArray(obj['evidence_refs'], '/evidence_refs', 0),
);

const validateConsolidationSuggestion = objectWith(
  ['action', 'target_refs'],
  ['action', 'target_refs'],
  obj => nonEmptyString(obj['action'], '/action') ?? stringArray(obj['target_refs'], '/target_refs', 0),
);

// ─── the closed set ──────────────────────────────────────────────────────────

const ALL_SUBJECTS: readonly FactSubjectKind[] = [
  'task',
  'requirement',
  'agent',
  'deliverable',
  'work_unit',
];

export const FACT_PREDICATES: readonly FactPredicateSpec[] = [
  {
    predicate: 'task.completion_evidence',
    subjectKinds: ['task'],
    summary: 'What this piece of work proved, and the evidence it points at.',
    assertor: 'executor',
    validate: validateCompletionEvidence,
  },
  {
    predicate: 'task.rejection_reason',
    subjectKinds: ['task'],
    summary: 'The structured reason a reviewer sent the work back (not prose).',
    assertor: 'reviewer',
    validate: validateRejectionReason,
  },
  {
    predicate: 'requirement.acceptance_met',
    subjectKinds: ['requirement'],
    summary: 'Whether one named acceptance criterion is met.',
    assertor: 'reviewer',
    validate: validateAcceptanceMet,
  },
  {
    predicate: 'work.defect_class',
    subjectKinds: ALL_SUBJECTS,
    summary: 'Which root-cause class (R1–R4) a defect belongs to.',
    assertor: 'any',
    validate: validateDefectClass,
  },
  {
    predicate: 'agent.capability_claim',
    subjectKinds: ['agent'],
    summary: 'A capability the agent claims, with the evidence for it.',
    assertor: 'any',
    validate: validateCapabilityClaim,
  },
  {
    predicate: 'memory.consolidation_suggestion',
    subjectKinds: ['agent', 'task'],
    summary: 'A dream-cycle consolidation suggestion (closes DR7).',
    assertor: 'any',
    validate: validateConsolidationSuggestion,
  },
];

/** The names, in dictionary order — the one list gates and prompts read. */
export const FACT_PREDICATE_NAMES: readonly string[] = FACT_PREDICATES
  .map(p => p.predicate)
  .sort();

export function findFactPredicate(predicate: string): FactPredicateSpec | undefined {
  return FACT_PREDICATES.find(p => p.predicate === predicate);
}

/** Validate a value against its predicate's schema. Unknown predicate ⇒ `unknown_predicate`. */
export function validateFactValue(
  predicate: string,
  value: unknown,
): FactValueValidation & { reason?: 'unknown_predicate' } {
  const spec = findFactPredicate(predicate);
  if (!spec) return { ok: false, reason: 'unknown_predicate', issue: { path: '', message: 'unknown predicate' } };
  return spec.validate(value);
}

/**
 * The nearest legal predicates, for the actionable half of an `unknown_predicate`
 * rejection. Deterministic (same input ⇒ same list) so a test can assert it.
 *
 * Ranking: same last segment (`*.completion_evidence`) first, then same first
 * segment (`task.*`), then the rest, each group in dictionary order.
 */
export function nearestFactPredicates(predicate: string, limit = 3): string[] {
  const wanted = predicate.toLowerCase();
  const first = (p: string) => p.slice(0, p.indexOf('.'));
  const last = (p: string) => p.slice(p.lastIndexOf('.') + 1);
  const wantedFirst = wanted.includes('.') ? first(wanted) : '';
  const wantedLast = wanted.includes('.') ? last(wanted) : wanted;
  const scored = FACT_PREDICATE_NAMES.map(name => {
    let score = 3;
    if (last(name) === wantedLast) score = 0;
    else if (wantedFirst && first(name) === wantedFirst) score = 1;
    else if (name.includes(wantedLast) || wantedLast.includes(last(name))) score = 2;
    return { name, score };
  });
  return scored
    .sort((a, b) => (a.score - b.score) || a.name.localeCompare(b.name))
    .slice(0, Math.max(0, limit))
    .map(s => s.name);
}

/**
 * `FACTS_ENABLED` — the one and only reader of the rollback flag.
 *
 * Default ON. `FACTS_ENABLED=0` (exactly "0") turns the layer off: no tools, no
 * prompt block, no reads/writes, so `DROP TABLE facts` is a complete rollback.
 */
export function isFactsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['FACTS_ENABLED'] !== '0';
}
