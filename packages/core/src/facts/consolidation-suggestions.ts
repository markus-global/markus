/**
 * dream-cycle consolidation suggestions — the **seven** advisory actions, as data (C9-E, closes DR7).
 *
 * DR7 (master plan §3.3): the seven suggestions in `learning-loop.md §5` had no landing place other
 * than prose in `knowledge.md`, so nothing could count them, query them, or supersede them.
 * Master plan §4.5 (line 784) says they land as `facts` (or a suggestion task). This module is that
 * landing point: a **pure** derivation from structural signals plus a closed-set parser for the
 * model's own declarations.
 *
 * Three rules make this hard to drift:
 *
 *  · **Exactly seven actions.** The set lives in `@markus/shared` (`CONSOLIDATION_ACTIONS`) and is
 *    what both the value schema and the parser validate against — an eighth is a schema violation,
 *    a missing one is a failing test.
 *  · **No clock, no IO, no randomness.** The caller passes `now`/ages; a rule with no signal emits
 *    nothing. "The platform invented advice" is the R4 failure this layer exists to prevent.
 *  · **No knowledge write.** Suggestions are returned, never applied: `knowledge.md` keeps its
 *    single physical writer (`writeKnowledgeMd`) and the dream's suggestion stage calls the fact
 *    layer instead. A test pins the byte-equality of `knowledge.md` across a dream run.
 */
import { CONSOLIDATION_ACTIONS, MAX_SUGGESTIONS_PER_CYCLE, isConsolidationAction, type ConsolidationAction } from '@markus/shared';

/** Re-exported so a reader/tool imports the closed set from the module that uses it. */
export { CONSOLIDATION_ACTIONS, MAX_SUGGESTIONS_PER_CYCLE, isConsolidationAction, type ConsolidationAction };

/** One suggestion as it lands in the fact value. */
export interface ConsolidationSuggestion {
  action: ConsolidationAction;
  /** At least one; what the action points at (skill ids, observation ids, agent ids, …). */
  target_refs: string[];
}

/** A skill's usage history — the input for archive / revise / merge / negative_feedback. */
export interface SkillSignal {
  id: string;
  /** Used for duplicate detection (case/space-insensitive collision = rule 3). */
  name: string;
  tags?: readonly string[];
  usageCount: number;
  successCount: number;
  /** Age of the skill in days (caller computes it; no clock here). */
  ageDays: number;
}

/** A notebook entry with its tier budget already resolved by the caller. */
export interface NotebookSignal {
  id: string;
  /** Tier key (`agent` / `system`) — carried into `target_refs` so a reader knows which budget. */
  tier: string;
  ageMs: number;
  ttlMs: number;
}

/** 3+ observations sharing a theme (rule 5). */
export interface ObservationCluster {
  theme: string;
  observationIds: readonly string[];
}

/** ≥3 negative feedback entries on one skill (rule 6). */
export interface NegativeFeedbackSignal {
  skillId: string;
  feedbackIds: readonly string[];
}

/** ≥3 agents independently recording the same theme (rule 7). */
export interface PeerThemeSignal {
  theme: string;
  agentIds: readonly string[];
  observationIds: readonly string[];
}

export interface ConsolidationSignals {
  skills?: readonly SkillSignal[];
  notebooks?: readonly NotebookSignal[];
  observationClusters?: readonly ObservationCluster[];
  negativeFeedback?: readonly NegativeFeedbackSignal[];
  peerThemes?: readonly PeerThemeSignal[];
}

/** Thresholds from `learning-loop.md §5`, kept as named constants so the doc and the code agree. */
export const CONSOLIDATION_THRESHOLDS = {
  /** Rule 1: unused skills must also be old, or every new skill gets archived. */
  archiveMinAgeDays: 30,
  /** Rule 2: revise only after enough evidence to be a rate at all. */
  reviseMinUsage: 3,
  reviseMaxSuccessRate: 0.5,
  /** Rule 5: how many observations make a pattern. */
  promoteMinObservations: 3,
  /** Rule 6: how much negative feedback opens a revision task. */
  negativeFeedbackMin: 3,
  /** Rule 7: how many agents make a theme team-wide. */
  teamSkillMinAgents: 3,
} as const;

function uniqSorted(refs: Iterable<string>): string[] {
  const seen = new Set<string>();
  for (const r of refs) {
    const v = typeof r === 'string' ? r.trim() : '';
    if (v.length > 0) seen.add(v);
  }
  return [...seen].sort();
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Derive suggestions from structural signals. Deterministic: same input ⇒ same output
 * (actions in the documented order, refs sorted), so a test can assert the whole list.
 */
export function deriveConsolidationSuggestions(
  signals: ConsolidationSignals,
): ConsolidationSuggestion[] {
  const T = CONSOLIDATION_THRESHOLDS;
  const out: ConsolidationSuggestion[] = [];
  const skills = signals.skills ?? [];

  // 1 · archive — no usage and old enough that "nobody has needed it" is real information.
  const archive = skills
    .filter(s => s.usageCount === 0 && s.ageDays > T.archiveMinAgeDays)
    .map(s => s.id);
  if (archive.length > 0) out.push({ action: 'archive', target_refs: uniqSorted(archive) });

  // 2 · revise — a poor success rate over enough runs.
  const revise = skills
    .filter(s => s.usageCount >= T.reviseMinUsage && s.successCount / s.usageCount < T.reviseMaxSuccessRate)
    .map(s => s.id);
  if (revise.length > 0) out.push({ action: 'revise', target_refs: uniqSorted(revise) });

  // 3 · merge — duplicate names OR colliding tags. One suggestion per collision group would
  //     re-open "one fact, N rows", so all colliding ids ride one action.
  const mergeIds = new Set<string>();
  const byName = new Map<string, string[]>();
  for (const s of skills) {
    const key = normalizeName(s.name);
    if (key.length === 0) continue;
    byName.set(key, [...(byName.get(key) ?? []), s.id]);
  }
  for (const ids of byName.values()) if (ids.length > 1) for (const id of ids) mergeIds.add(id);
  const byTag = new Map<string, string[]>();
  for (const s of skills) {
    for (const tag of s.tags ?? []) {
      const key = normalizeName(tag);
      if (key.length === 0) continue;
      byTag.set(key, [...(byTag.get(key) ?? []), s.id]);
    }
  }
  for (const ids of byTag.values()) if (ids.length > 1) for (const id of ids) mergeIds.add(id);
  if (mergeIds.size > 0) out.push({ action: 'merge', target_refs: uniqSorted(mergeIds) });

  // 4 · ttl — notebook entries past their tier budget.
  const ttl = (signals.notebooks ?? [])
    .filter(n => n.ttlMs > 0 && n.ageMs > n.ttlMs)
    .map(n => n.id);
  if (ttl.length > 0) out.push({ action: 'ttl', target_refs: uniqSorted(ttl) });

  // 5 · promote — 3+ observations that share a theme.
  const promote = new Set<string>();
  for (const cluster of signals.observationClusters ?? []) {
    if (cluster.observationIds.length < T.promoteMinObservations) continue;
    for (const id of cluster.observationIds) promote.add(id);
  }
  if (promote.size > 0) out.push({ action: 'promote', target_refs: uniqSorted(promote) });

  // 6 · negative_feedback — enough negative signal to justify a revision task.
  const feedback = new Set<string>();
  for (const sig of signals.negativeFeedback ?? []) {
    if (sig.feedbackIds.length < T.negativeFeedbackMin) continue;
    feedback.add(sig.skillId);
    for (const id of sig.feedbackIds) feedback.add(id);
  }
  if (feedback.size > 0) out.push({ action: 'negative_feedback', target_refs: uniqSorted(feedback) });

  // 7 · team_skill — a theme independently recorded by enough agents.
  const team = new Set<string>();
  for (const sig of signals.peerThemes ?? []) {
    if (sig.agentIds.length < T.teamSkillMinAgents) continue;
    for (const id of sig.agentIds) team.add(id);
    for (const id of sig.observationIds) team.add(id);
  }
  if (team.size > 0) out.push({ action: 'team_skill', target_refs: uniqSorted(team) });

  return out;
}

/**
 * Parse the model's own declarations against the closed seven.
 *
 * Unknown actions and empty targets are **dropped and reported**, never coerced into a
 * neighbour: silently rewriting `archive` to `revise` would put a conclusion in the fact
 * layer that nobody stated. `dropped` exists so the caller can log a real signal instead of
 * quietly shipping half the plan.
 */
export function parseConsolidationSuggestions(raw: unknown): {
  suggestions: ConsolidationSuggestion[];
  dropped: Array<{ index: number; reason: string }>;
} {
  const dropped: Array<{ index: number; reason: string }> = [];
  if (!Array.isArray(raw)) return { suggestions: [], dropped };
  const suggestions: ConsolidationSuggestion[] = [];
  raw.forEach((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      dropped.push({ index, reason: 'not an object' });
      return;
    }
    const obj = item as Record<string, unknown>;
    const action = obj['action'];
    if (!isConsolidationAction(action)) {
      dropped.push({
        index,
        reason: `unknown action "${String(action)}" (legal: ${CONSOLIDATION_ACTIONS.join(' | ')})`,
      });
      return;
    }
    const refs = Array.isArray(obj['target_refs'])
      ? obj['target_refs'].filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
      : [];
    if (refs.length === 0) {
      dropped.push({ index, reason: 'no target_refs — a suggestion pointing at nothing is not actionable' });
      return;
    }
    suggestions.push({ action, target_refs: uniqSorted(refs) });
  });
  return { suggestions, dropped };
}

/**
 * Merge suggestion sets, keeping one entry per action (the action *is* the identity here — the
 * fact value is one snapshot, and two `archive` entries would be two answers to one question).
 * Targets are unioned; cap keeps the value inside `MAX_SUGGESTIONS_PER_CYCLE`.
 */
export function mergeSuggestions(
  ...sets: ReadonlyArray<readonly ConsolidationSuggestion[]>
): ConsolidationSuggestion[] {
  const byAction = new Map<ConsolidationAction, Set<string>>();
  for (const set of sets) {
    for (const s of set) {
      const bucket = byAction.get(s.action) ?? new Set<string>();
      for (const ref of s.target_refs) bucket.add(ref);
      byAction.set(s.action, bucket);
    }
  }
  // Documented action order, so two runs with the same content produce the same value bytes.
  const merged: ConsolidationSuggestion[] = [];
  for (const action of CONSOLIDATION_ACTIONS) {
    const bucket = byAction.get(action);
    if (!bucket || bucket.size === 0) continue;
    merged.push({ action, target_refs: uniqSorted(bucket) });
  }
  return merged.slice(0, MAX_SUGGESTIONS_PER_CYCLE);
}

/** The fact value for `memory.consolidation_suggestion` — one snapshot per agent. */
export function toConsolidationFactValue(suggestions: readonly ConsolidationSuggestion[]): {
  suggestions: ConsolidationSuggestion[];
} {
  return { suggestions: suggestions.map(s => ({ action: s.action, target_refs: [...s.target_refs] })) };
}

/** Human/log rendering of a dropped item, so a truncated plan is visible. */
export function describeDropped(dropped: ReadonlyArray<{ index: number; reason: string }>): string {
  return dropped.map(d => `#${d.index}: ${d.reason}`).join('; ');
}
