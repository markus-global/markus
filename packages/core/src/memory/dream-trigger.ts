/**
 * Dream-cycle trigger — the ONE place that decides whether the periodic semantic
 * memory consolidation should run.
 *
 * Why this is its own pure module (H14): the trigger used to live inline in
 * `Agent.consolidateMemory()` as `entries.length >= 50` — an **entry count** — while
 * the observation buffer's budget is measured in **characters**
 * (`MEMORY_OBSERVATIONS_MAX_CHARS`). Two unrelated measures for one budget is the same
 * anti-pattern fixed in H1–H3/H12, and it made the dream *structurally dead* for any
 * agent whose entries are large: a buffer of ~31 real entries (each carrying `data-meta`
 * JSON, ≈960 chars) sits at 99% of its 30 000-char budget, so the count never reaches 50
 * and the dream never runs.
 *
 * Keeping the decision here, pure and tested, means the trigger and the in-prompt health
 * banner provably share one measure (`MEMORY_DREAM_TRIGGER_PERCENT ===
 * MEMORY_HEALTH_WARN_PERCENT`) and cannot drift apart again.
 *
 * 2026-10-15 (restart-duplicate fix): the "already ran this window" guard used to be an
 * in-memory, per-Agent-instance field (`lastDreamDate`). A process restart re-armed it
 * (observed: two `memory_consolidation` runs 2.5 min apart across a restart), because the
 * guard never consulted the DURABLE `memory-meta.json#lastConsolidatedAt` that already
 * existed. That is the classic R1 shape again — one fact (did we consolidate?) with two
 * sources, and the guard read the volatile one. The dedup now also consults the durable
 * timestamp; the window key derivation lives here so "now" and "the recorded instant"
 * are compared with a single implementation.
 */
import { MEMORY_DREAM_TRIGGER_PERCENT, MEMORY_DREAM_MIN_ENTRIES } from '@markus/shared';

/**
 * Above this many entries the buffer is considered "bloated": the dream is allowed up to
 * 4×/day (one per 6h bucket) instead of once per calendar day. Matches the LLM batch cap
 * in `Agent.dreamConsolidateMemory` (`MAX_ENTRIES_FOR_LLM`).
 */
export const MEMORY_DREAM_MAX_ENTRIES = 500;

/** Width of the sub-day window used when the buffer is bloated (4 windows/day). */
export const DREAM_BLOAT_WINDOW_MS = 6 * 3600_000;

/**
 * The identity of the dream window an instant belongs to.
 *  - normal buffer → the calendar day (`2026-10-15`)
 *  - bloated buffer → day + 6h bucket (`2026-10-15_8`) so up to 4 dreams/day
 *
 * Pure: the SAME function keys "now" and a recorded `lastConsolidatedAt`, so the durable
 * check cannot drift from the trigger.
 */
export function dreamWindowKey(entryCount: number, at: Date): string {
  const day = at.toISOString().slice(0, 10);
  return entryCount > MEMORY_DREAM_MAX_ENTRIES
    ? `${day}_${Math.floor(at.getTime() / DREAM_BLOAT_WINDOW_MS)}`
    : day;
}

export interface DreamTriggerInput {
  /**
   * Observation-buffer usage as a percentage (0..∞) — the SAME measure the health
   * banner reports (`MemoryHealth.observationPercent`). Primary pressure signal.
   */
  observationPercent: number;
  /** Number of entries in the observation buffer. Secondary pressure signal. */
  entryCount: number;
  /**
   * Optional clock. When supplied, the window-dedup below applies; when omitted the
   * call is a pure pressure check (back-compat for callers/tests that only need that).
   */
  now?: Date;
  /**
   * Durable "last consolidation happened" timestamp (`memory-meta.json#lastConsolidatedAt`,
   * ISO) or null. Survives restarts — this is what stops a restarted agent re-dreaming.
   */
  lastConsolidatedAt?: string | null;
  /** Volatile in-memory key of the last dream THIS process ran ('' if none). */
  lastInMemoryWindowKey?: string;
}

/**
 * Run the dream cycle when the buffer is over its budget (primary) OR when there are
 * so many entries that search cost matters (secondary). Never when neither holds, so we
 * do not spend an LLM call on a healthy buffer.
 *
 * When `now` is supplied, additionally skip if a consolidation for this window already
 * happened — either recorded durably (`lastConsolidatedAt`) or run by this process
 * (`lastInMemoryWindowKey`). That is the restart-duplicate guard.
 */
export function shouldRunDreamCycle(input: DreamTriggerInput): boolean {
  const pressured =
    input.observationPercent >= MEMORY_DREAM_TRIGGER_PERCENT
    || input.entryCount >= MEMORY_DREAM_MIN_ENTRIES;
  if (!pressured) return false;

  if (input.now) {
    const windowKey = dreamWindowKey(input.entryCount, input.now);
    if (input.lastInMemoryWindowKey === windowKey) return false;
    const durable = input.lastConsolidatedAt ? Date.parse(input.lastConsolidatedAt) : NaN;
    if (!Number.isNaN(durable) && dreamWindowKey(input.entryCount, new Date(durable)) === windowKey) {
      return false;
    }
  }
  return true;
}
