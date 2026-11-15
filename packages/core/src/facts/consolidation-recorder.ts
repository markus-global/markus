/**
 * Where dream suggestions actually land (C9-E, closes DR7).
 *
 * One active `memory.consolidation_suggestion` fact per agent holds the **current** suggestion
 * snapshot. A later dream cycle supersedes it, which is the same lifecycle as any other
 * conclusion: history is never rewritten, and the audit page can show "last cycle → this cycle,
 * who, when".
 *
 * Why one row per agent and not one row per action: the facts table allows **at most one active
 * row per subject+predicate** (`ux_facts_active`, C9-A §1.4). Seven active rows would need either
 * a new index (C9-A's table — out of scope) or a synthetic subject id that encodes the action,
 * i.e. structure inferred from a payload (R3). One snapshot is also what a reader needs.
 *
 * This module only talks to the `FactService` port — no SQL, no memory store. In particular it
 * never touches `knowledge.md`: that file keeps its single physical writer, and the whole point of
 * DR7 is that advice stopped being prose.
 */
import type { FactService } from './fact-service.js';
import {
  toConsolidationFactValue,
  type ConsolidationSuggestion,
} from './consolidation-suggestions.js';

/** The predicate this module owns. Declared once; the closed set lives in `@markus/shared`. */
export const CONSOLIDATION_SUGGESTION_PREDICATE = 'memory.consolidation_suggestion';

export interface ConsolidationRecordResult {
  /**
   * `asserted` — first snapshot for this agent;
   * `superseded` — replaced the previous snapshot;
   * `skipped` — nothing to suggest this cycle (asserting an empty set would be noise);
   * `rejected` — the fact layer refused it (see `code`/`message`; never swallowed silently).
   */
  status: 'asserted' | 'superseded' | 'skipped' | 'rejected';
  factId?: string;
  count: number;
  code?: string;
  message?: string;
}

/**
 * Record (or replace) this agent's suggestion snapshot.
 *
 * `workUnitRef` is the dream run's identity (`dream:<agentId>:<windowKey>`) — a dream cycle is not
 * mailbox-driven (C8-C), so there is no turn WorkUnit to inherit; the identity is still stable and
 * per-window, which is what makes repeated cycles supersede rather than accumulate.
 */
export function recordConsolidationSuggestions(deps: {
  facts: FactService;
  agentId: string;
  suggestions: readonly ConsolidationSuggestion[];
  workUnitRef: string;
  /** Provenance for the assertion (observation / skill ids it was derived from). */
  sourceRefs: readonly string[];
}): ConsolidationRecordResult {
  const { facts, agentId, suggestions, workUnitRef } = deps;
  if (suggestions.length === 0) return { status: 'skipped', count: 0 };

  const value = toConsolidationFactValue(suggestions);
  const sourceRefs = deps.sourceRefs.filter(r => typeof r === 'string' && r.trim().length > 0);
  // Provenance is mandatory on the fact layer: a suggestion with no observation/skill behind it
  // would be an assertion about nothing. Fall back to the suggestion targets themselves.
  const provenance = sourceRefs.length > 0
    ? [...sourceRefs]
    : suggestions.flatMap(s => s.target_refs);

  const existing = facts.queryActive({
    subjectKind: 'agent',
    subjectId: agentId,
    predicate: CONSOLIDATION_SUGGESTION_PREDICATE,
    activeOnly: true,
    limit: 1,
  })[0];

  const base = {
    subjectKind: 'agent' as const,
    subjectId: agentId,
    predicate: CONSOLIDATION_SUGGESTION_PREDICATE,
    value,
    workUnitRef,
    assertedBy: agentId,
    sourceRefs: provenance,
  };

  const result = existing
    ? facts.supersede({
        ...base,
        supersededFactId: existing.id,
        reason: `dream cycle ${workUnitRef} replaced the previous suggestion snapshot`,
      })
    : facts.assert(base);

  if (result.status !== 'asserted') {
    return { status: 'rejected', count: suggestions.length, code: result.code, message: result.message };
  }
  return {
    status: existing ? 'superseded' : 'asserted',
    factId: result.fact.id,
    count: suggestions.length,
  };
}
