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
 */
import { MEMORY_DREAM_TRIGGER_PERCENT, MEMORY_DREAM_MIN_ENTRIES } from '@markus/shared';

export interface DreamTriggerInput {
  /**
   * Observation-buffer usage as a percentage (0..∞) — the SAME measure the health
   * banner reports (`MemoryHealth.observationPercent`). Primary pressure signal.
   */
  observationPercent: number;
  /** Number of entries in the observation buffer. Secondary pressure signal. */
  entryCount: number;
}

/**
 * Run the dream cycle when the buffer is over its budget (primary) OR when there are
 * so many entries that search cost matters (secondary). Never when neither holds, so we
 * do not spend an LLM call on a healthy buffer.
 */
export function shouldRunDreamCycle(input: DreamTriggerInput): boolean {
  return input.observationPercent >= MEMORY_DREAM_TRIGGER_PERCENT
    || input.entryCount >= MEMORY_DREAM_MIN_ENTRIES;
}
