/**
 * `[FACTS:<subject>]` — the prompt block for the current subject's facts (C9-A).
 *
 * PURE. No IO, no clock, no randomness. Same subject + same fact set ⇒ the same
 * bytes, always. That is not cosmetic: this block rides the per-turn volatile
 * tail, and a block that reshuffles itself on every turn is a cache miss on
 * every turn.
 *
 * Why the volatile tail and not the system prompt: facts are large and
 * distributed per subject. Pushing them into the byte-stable system text would
 * both flood the prompt and invalidate the cached prefix whenever one fact
 * changes — the 198 % memory-banner incident is exactly that road.
 *
 * Budget: ≤ 20 facts and ≤ 2000 characters. Over budget, facts are chosen by
 * priority (`task.completion_evidence` > `task.rejection_reason` >
 * `verification.result` > others), then rendered in dictionary order, and the
 * block ends with an explicit `+N more (use fact_query)` — never a silent cut.
 *
 * Empty set ⇒ a stable empty form. "Omit the block when empty" is forbidden:
 * two shapes for one state means two cache entries for the same truth.
 */
import type { FactSubjectKind } from '@markus/shared';
import { stableJson, type FactRecord } from './fact-service.js';

export const FACTS_BLOCK_MAX_FACTS = 20;
export const FACTS_BLOCK_MAX_CHARS = 2000;

/** The slice of a fact this renderer needs — enough to keep it testable without a service. */
export interface FactView {
  predicate: string;
  value: unknown;
  verification?: { result?: string };
  /** Evidence count shown instead of dumping every ref. */
  sourceRefCount?: number;
}

export interface FactsBlockOptions {
  maxFacts?: number;
  maxChars?: number;
}

/** `<kind>_<id>`, e.g. `task_tsk_a208c5c7` — the header's subject label. */
export function factsSubjectLabel(subjectKind: FactSubjectKind, subjectId: string): string {
  return `${subjectKind}_${subjectId}`;
}

function priorityOf(fact: FactView): number {
  if (fact.predicate === 'task.completion_evidence') return 0;
  if (fact.predicate === 'task.rejection_reason') return 1;
  if (fact.verification?.result) return 2;
  return 3;
}

function lineOf(fact: FactView): string {
  const refs = fact.sourceRefCount ?? 0;
  const suffix = refs > 0 ? ` (refs: ${refs})` : '';
  return `· ${fact.predicate} ${stableJson(fact.value)}${suffix}`;
}

/**
 * Render the block. The first line is ALWAYS `[FACTS:<subject>]`, present or not.
 */
export function renderFactsBlock(
  subjectKind: FactSubjectKind,
  subjectId: string,
  facts: readonly FactView[],
  opts: FactsBlockOptions = {},
): string {
  const maxFacts = opts.maxFacts ?? FACTS_BLOCK_MAX_FACTS;
  const maxChars = opts.maxChars ?? FACTS_BLOCK_MAX_CHARS;
  const header = `[FACTS:${factsSubjectLabel(subjectKind, subjectId)}]`;

  if (facts.length === 0) return `${header}\n(no facts yet)`;

  // 1) Choose what fits: priority first, then dictionary order as a stable tiebreak.
  const ranked = [...facts].sort((a, b) => {
    const p = priorityOf(a) - priorityOf(b);
    return p !== 0 ? p : a.predicate.localeCompare(b.predicate);
  });

  const kept: FactView[] = [];
  let chars = header.length;
  for (const fact of ranked) {
    if (kept.length >= maxFacts) break;
    const lineLen = lineOf(fact).length + 1; // + newline
    if (chars + lineLen > maxChars) break;
    kept.push(fact);
    chars += lineLen;
  }

  // 2) Render in dictionary order — the ordering guarantee is about output, not about selection.
  kept.sort((a, b) => a.predicate.localeCompare(b.predicate));

  const lines = [header, ...kept.map(lineOf)];
  const omitted = facts.length - kept.length;
  if (omitted > 0) lines.push(`+${omitted} more (use fact_query)`);
  return lines.join('\n');
}

/** Convenience adapter: a `FactRecord` is a `FactView` plus metadata this block does not print. */
export function toFactView(fact: FactRecord): FactView {
  return {
    predicate: fact.predicate,
    value: fact.value,
    verification: fact.verification ? { result: fact.verification.result } : undefined,
    sourceRefCount: fact.sourceRefs.length,
  };
}

/**
 * What the context engine is handed by its provider: the CURRENT subject and its
 * active facts. Deliberately one subject only — rendering facts of unrelated
 * subjects would pollute an agent working on task A with task B's history.
 */
export interface FactsPromptContext {
  subjectKind: FactSubjectKind;
  subjectId: string;
  facts: readonly FactView[];
}

/** Render a provider result. Kept next to the renderer so there is one formatter. */
export function renderFactsContext(
  ctx: FactsPromptContext,
  opts: FactsBlockOptions = {},
): string {
  return renderFactsBlock(ctx.subjectKind, ctx.subjectId, ctx.facts, opts);
}
