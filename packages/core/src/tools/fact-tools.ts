/**
 * The three fact tools (C9-A): `fact_assert` / `fact_supersede` / `fact_query`.
 *
 * Design notes that are easy to get wrong later:
 *
 *  · **Identity is not re-derived here.** `work_unit_ref` comes from
 *    `AgentToolContext.turnWorkUnitRef()` — the C8 chain that reads this turn's
 *    identity from memory. Re-parsing it from the payload would be a second
 *    resolver, and C8's fifth-layer defect was exactly that. Empty ⇒ the call is
 *    rejected with `missing_provenance`; empty is never a default.
 *
 *  · **No "assert on every turn" pressure.** The descriptions say when NOT to
 *    use this. The 166-turn incident came from "every turn must call an action
 *    tool"; facts must only be asserted at a terminal hook.
 *
 *  · **`fact_query` is exact matching only** and its description states the
 *    division of labour with `memory_search` — otherwise the model picks the
 *    wrong one and we are back to "one fact, N representations".
 */
import type { AgentToolHandler } from '../agent.js';
import type { FactService, FactVerification, FactQuery } from '../facts/fact-service.js';

export interface FactToolsContext {
  agentId: string;
  facts: FactService;
  /** This turn's WorkUnit ref (memory, never a DB lookup). `null` = not bound. */
  turnWorkUnitRef: () => string | null;
}

const SUBJECT_KINDS = ['task', 'requirement', 'agent', 'deliverable', 'work_unit'] as const;

type SubjectKind = (typeof SUBJECT_KINDS)[number];

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function readVerification(v: unknown): FactVerification | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const obj = v as Record<string, unknown>;
  const result = obj['result'];
  const verifiedBy = obj['verified_by'];
  if (result !== 'pass' && result !== 'fail') return undefined;
  if (typeof verifiedBy !== 'string') return undefined;
  return {
    result,
    verified_by: verifiedBy,
    evidence_refs: asStringArray(obj['evidence_refs']),
  };
}

interface FactToolInput {
  subjectKind: SubjectKind;
  subjectId: string;
  predicate: string;
  value: unknown;
  sourceRefs: string[];
  verification?: FactVerification;
  confidence?: number;
}

function readInput(args: Record<string, unknown>): FactToolInput {
  return {
    subjectKind: args['subject_kind'] as SubjectKind,
    subjectId: typeof args['subject_id'] === 'string' ? args['subject_id'] : '',
    predicate: typeof args['predicate'] === 'string' ? args['predicate'] : '',
    value: args['value'],
    sourceRefs: asStringArray(args['source_refs']),
    verification: readVerification(args['verification']),
    confidence: typeof args['confidence'] === 'number' ? args['confidence'] : undefined,
  };
}

function shapeError(input: FactToolInput): string | undefined {
  if (!SUBJECT_KINDS.includes(input.subjectKind)) {
    return `subject_kind must be one of ${SUBJECT_KINDS.join(' | ')}`;
  }
  if (input.subjectId.trim() === '') return 'subject_id is required';
  if (input.predicate.trim() === '') return 'predicate is required';
  return undefined;
}

export function createFactTools(ctx: FactToolsContext): AgentToolHandler[] {
  const provenance = (): { workUnitRef: string } | { error: string } => {
    const ref = ctx.turnWorkUnitRef();
    if (!ref || ref.trim().length === 0) {
      return {
        error: JSON.stringify({
          status: 'rejected',
          code: 'missing_provenance',
          message:
            'This turn is not bound to a WorkUnit, so nothing can be asserted about it. ' +
            'Facts are asserted inside a turn (task execution / review / verification), not outside one.',
        }),
      };
    }
    return { workUnitRef: ref };
  };

  return [
    {
      name: 'fact_assert',
      description:
        'Assert ONE structured fact about a subject you just finished work on (e.g. task.completion_evidence with evidence refs). Use at a terminal hook — before task_submit_review, or when recording a rejection reason — NOT every turn. If no new conclusion exists, assert nothing. If the predicate is already active this returns must_supersede: use fact_supersede instead.',
      inputSchema: {
        type: 'object',
        properties: {
          subject_kind: { type: 'string', enum: [...SUBJECT_KINDS], description: 'What the fact is about.' },
          subject_id: { type: 'string', description: 'Id of that subject (e.g. tsk_…).' },
          predicate: {
            type: 'string',
            description:
              'Closed set: task.completion_evidence | task.rejection_reason | requirement.acceptance_met | work.defect_class | agent.capability_claim | memory.consolidation_suggestion',
          },
          value: { type: 'object', description: "The predicate's structured value (validated against its schema)." },
          source_refs: {
            type: 'array',
            items: { type: 'string' },
            description: 'Evidence pointers (deliverable / comment / decision ids). At least one is required.',
          },
          verification: {
            type: 'object',
            description:
              'Optional verification of this fact: {result:"pass"|"fail", verified_by:"agt_…", evidence_refs:[…]}. verified_by must differ from you — self-verification is rejected.',
          },
          confidence: { type: 'number', description: '0..1, display only; does not drive derivation. Default 1.' },
        },
        required: ['subject_kind', 'subject_id', 'predicate', 'value', 'source_refs'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const input = readInput(args);
        const shape = shapeError(input);
        if (shape) return JSON.stringify({ status: 'rejected', code: 'invalid_subject', message: shape });
        const prov = provenance();
        if ('error' in prov) return prov.error;
        const res = ctx.facts.assert({
          ...input,
          workUnitRef: prov.workUnitRef,
          assertedBy: ctx.agentId,
        });
        return JSON.stringify(res);
      },
    },
    {
      name: 'fact_supersede',
      description:
        'Replace an existing fact with a new one in ONE call: asserts the new fact and marks the old row superseded (history is never rewritten). Use only when new evidence overturns the old conclusion — restating the same conclusion in different words is not new evidence. Requires superseded_fact_id + a reason.',
      inputSchema: {
        type: 'object',
        properties: {
          superseded_fact_id: { type: 'string', description: 'The active fact being replaced (from fact_query).' },
          reason: { type: 'string', description: 'Why the old conclusion no longer holds.' },
          subject_kind: { type: 'string', enum: [...SUBJECT_KINDS] },
          subject_id: { type: 'string' },
          predicate: { type: 'string', description: 'Must match the superseded fact.' },
          value: { type: 'object', description: 'The new structured value.' },
          source_refs: { type: 'array', items: { type: 'string' }, description: 'Evidence for the NEW value.' },
          verification: { type: 'object', description: '{result, verified_by, evidence_refs?} — verified_by ≠ you.' },
          confidence: { type: 'number' },
        },
        required: ['superseded_fact_id', 'reason', 'subject_kind', 'subject_id', 'predicate', 'value', 'source_refs'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const input = readInput(args);
        const shape = shapeError(input);
        if (shape) return JSON.stringify({ status: 'rejected', code: 'invalid_subject', message: shape });
        const supersededFactId = typeof args['superseded_fact_id'] === 'string' ? args['superseded_fact_id'] : '';
        const reason = typeof args['reason'] === 'string' ? args['reason'] : '';
        if (supersededFactId.trim() === '') {
          return JSON.stringify({
            status: 'rejected',
            code: 'not_found',
            message: 'superseded_fact_id is required (query it with fact_query first).',
          });
        }
        const prov = provenance();
        if ('error' in prov) return prov.error;
        const res = ctx.facts.supersede({
          ...input,
          workUnitRef: prov.workUnitRef,
          assertedBy: ctx.agentId,
          supersededFactId,
          reason,
        });
        return JSON.stringify(res);
      },
    },
    {
      name: 'fact_query',
      description:
        'Read facts (conclusions) by EXACT match: subject, predicate or predicate prefix (task.*), or one fact_id. This answers "what is concluded", not "what was discussed" — for discussion use memory_search or read task_comments; for "who is running" use work_status. No fuzzy/semantic search by design.',
      inputSchema: {
        type: 'object',
        properties: {
          subject_kind: { type: 'string', enum: [...SUBJECT_KINDS] },
          subject_id: { type: 'string' },
          predicate: { type: 'string', description: 'Exact predicate.' },
          predicate_prefix: { type: 'string', description: 'Structured prefix, e.g. "task.".' },
          fact_id: { type: 'string', description: 'Fetch one fact by id.' },
          active_only: { type: 'boolean', description: 'Default true; false includes superseded history.' },
          limit: { type: 'number', description: 'Default 200, max 1000.' },
        },
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const query: FactQuery = {
          subjectKind: args['subject_kind'] as FactQuery['subjectKind'],
          subjectId: typeof args['subject_id'] === 'string' ? args['subject_id'] : undefined,
          predicate: typeof args['predicate'] === 'string' ? args['predicate'] : undefined,
          predicatePrefix: typeof args['predicate_prefix'] === 'string' ? args['predicate_prefix'] : undefined,
          factId: typeof args['fact_id'] === 'string' ? args['fact_id'] : undefined,
          activeOnly: args['active_only'] !== false,
          limit: typeof args['limit'] === 'number' ? args['limit'] : undefined,
        };
        const facts = ctx.facts.queryActive(query);
        return JSON.stringify({ status: 'ok', count: facts.length, facts });
      },
    },
    {
      name: 'fact_verify',
      description:
        'Record YOUR independent verdict on a fact somebody else asserted — result "pass" or "fail" plus at least one evidence_ref. Use this when you are the reviewer/verifier of a claim. You CANNOT verify a fact you asserted yourself (producer != confirmer): that returns self_verification_forbidden. A verdict is write-once; to change a verdict, supersede the claim with new evidence and verify the new row. Only a "pass" from a different agent lets the thread reach "done".',
      inputSchema: {
        type: 'object',
        properties: {
          fact_id: { type: 'string', description: 'The fact you are judging (from fact_query).' },
          result: { type: 'string', enum: ['pass', 'fail'], description: 'pass = the claim holds; fail = it does not (the thread stays in_verification).' },
          evidence_refs: {
            type: 'array',
            items: { type: 'string' },
            description: 'At least one pointer that makes the verdict checkable (comment / deliverable / decision id, or a path). Required for pass AND fail.',
          },
        },
        required: ['fact_id', 'result', 'evidence_refs'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const factId = typeof args['fact_id'] === 'string' ? args['fact_id'].trim() : '';
        if (factId.length === 0) {
          return JSON.stringify({ status: 'error', error: 'fact_id is required — query it with fact_query first.' });
        }
        const prov = provenance();
        if ('error' in prov) return prov.error;
        const res = ctx.facts.verify({
          factId,
          result: args['result'] as 'pass' | 'fail',
          verifiedBy: ctx.agentId,
          evidenceRefs: asStringArray(args['evidence_refs']),
          workUnitRef: prov.workUnitRef,
        });
        return JSON.stringify(res);
      },
    },
  ];
}
