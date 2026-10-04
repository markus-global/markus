import type { Agent } from './agent.js';

/**
 * H9 — structured visibility for "agent references a skill that is not installed".
 *
 * Before this module the two places that build agents (create + restore) each did
 * their own `config.skills.filter(s => !registry.get(s))` and then **only**
 * `log.warn`-ed the result. With dozens of agents restored on startup that meant
 * dozens of warnings buried in the log and *zero* visibility in the UI: every
 * affected agent silently degraded (its tools never registered) and looked fine.
 *
 * This module is the single source of truth for that computation:
 *   • `resolveMissingSkills` — one predicate, shared by both call sites.
 *   • `buildSkillWarnings`   — missing + a truncated `available` catalog.
 *   • a per-`Agent` store (`setAgentSkillWarnings` / `getAgentSkillWarnings`)
 *     so the state is readable off the agent instance itself.
 *
 * NOTE: `packages/core/src/agent.ts` is intentionally left untouched (it is being
 * edited elsewhere). The per-agent state therefore lives in a `WeakMap` keyed by
 * the `Agent` instance instead of a field on the class — same observable
 * behaviour (`agent` → warnings), no change to `Agent`.
 */

export interface SkillWarnings {
  /** Assigned skill names the registry has no entry for. */
  missing: string[];
  /** Names present in the registry (truncated — see `SKILL_WARNINGS_AVAILABLE_LIMIT`). */
  available: string[];
}

/**
 * Structural subset of `SkillRegistry` needed to resolve missing skills. Kept
 * minimal so tests can pass a tiny stub instead of a full registry.
 */
export interface SkillLookup {
  get(name: string): unknown;
  list(): Array<{ name: string }>;
}

/** Cap on the `available` list so a per-agent payload stays small. */
export const SKILL_WARNINGS_AVAILABLE_LIMIT = 50;

/**
 * Single computation point for "which assigned skills are missing".
 *
 * A skill is missing when the registry has no entry for it. When there is no
 * registry at all (e.g. a mis-wired manager), every assigned skill counts as
 * missing — that is a real degradation and must not be hidden.
 */
export function resolveMissingSkills(
  config: { skills?: string[] } | null | undefined,
  registry: SkillLookup | null | undefined,
): string[] {
  const assigned = config?.skills ?? [];
  if (assigned.length === 0) return [];
  if (!registry) return [...assigned];
  return assigned.filter((name) => !registry.get(name));
}

/**
 * Build the full warning payload (missing + truncated available catalog) used to
 * stamp an agent and to serve the API.
 */
export function buildSkillWarnings(
  config: { skills?: string[] } | null | undefined,
  registry: SkillLookup | null | undefined,
): SkillWarnings {
  const missing = resolveMissingSkills(config, registry);
  const available = registry
    ? registry.list().map((s) => s.name).slice(0, SKILL_WARNINGS_AVAILABLE_LIMIT)
    : [];
  return { missing, available };
}

const store = new WeakMap<Agent, SkillWarnings>();

/** Attach the resolved skill warnings to an agent instance. */
export function setAgentSkillWarnings(agent: Agent, warnings: SkillWarnings): void {
  store.set(agent, {
    missing: [...warnings.missing],
    available: [...warnings.available],
  });
}

/**
 * Read the skill warnings previously attached to an agent instance, if any.
 *
 * Returns a defensive copy: callers embed this into API responses, and a shared
 * reference would let any downstream mutation silently corrupt the stored state
 * (reads are per-request, so the copy is free in practice).
 */
export function getAgentSkillWarnings(agent: Agent): SkillWarnings | undefined {
  const stored = store.get(agent);
  if (!stored) return undefined;
  return { missing: [...stored.missing], available: [...stored.available] };
}
