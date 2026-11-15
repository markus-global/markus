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
 * ─── DR3 (2026-11-15) — 「哪一次事件、哪个窗口」instead of a bare instant ───────────
 *
 * Two fixes ago (2026-10-15, restart-duplicate) the guard was taught to consult the
 * durable `memory-meta.json#lastConsolidatedAt` in addition to the volatile
 * `Agent.lastDreamDate`. That closed the restart hole and opened three new ones, because
 * ONE untyped instant was made to answer a question about ONE event type:
 *
 *   1. `memory_organize` wrote the same field ⇒ a 09:00 manual tidy cancelled the day's
 *      dream (the guard asked "did the dream run?"; the field answered "did anyone tidy?").
 *   2. The durable key was RE-DERIVED here (`dreamWindowKey(entryCount, new Date(ts))`),
 *      so the recorded window and the compared window were two derivations of one fact,
 *      and the bloated-buffer branch depended on the CURRENT entry count, not the one the
 *      run actually used.
 *   3. `Agent` armed its volatile shadow BEFORE running the dream, so a dream that threw
 *      was "already done" for the rest of that process and re-ran only after a restart.
 *
 * The fix is typed events plus a stored key:
 *   · the guard reads `dream` ONLY (`DreamRecord = { at, windowKey }`), never an organize;
 *   · `dream.windowKey` is compared as a STRING — the value the writer computed at run
 *     time. This module never parses a timestamp to rebuild a window key;
 *   · the record is written by the caller AFTER the dream returns successfully
 *     (`IMemoryStore.recordDream`), so "not recorded" genuinely means "did not complete";
 *   · `dreamInFlightKey` is a CONCURRENCY fact (a run currently executing in this
 *     process), not a history fact — it replaces the old volatile "already ran" shadow
 *     and is cleared in a `finally`, so a throw can never leave the window armed.
 */
import { MEMORY_DREAM_TRIGGER_PERCENT, MEMORY_DREAM_MIN_ENTRIES } from '@markus/shared';
import type { DreamRecord } from './types.js';

/**
 * Above this many entries the buffer is considered "bloated": the dream is allowed up to
 * 4×/day (one per 6h bucket) instead of once per calendar day. Matches the LLM batch cap
 * in `Agent.dreamConsolidateMemory` (`MAX_ENTRIES_FOR_LLM`).
 */
export const MEMORY_DREAM_MAX_ENTRIES = 500;

/** Width of the sub-day window used when the buffer is bloated (4 windows/day). */
export const DREAM_BLOAT_WINDOW_MS = 6 * 3600_000;

/**
 * The calendar-day window key — the non-bloated branch of {@link dreamWindowKey}, and the
 * only key that can be recovered for a LEGACY untyped record (which never stored one).
 */
export function dayWindowKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * The identity of the dream window an instant belongs to.
 *  - normal buffer → the calendar day (`2026-10-15`)
 *  - bloated buffer → day + 6h bucket (`2026-10-15_58`) so up to 4 dreams/day
 *
 * Called ONCE per run, by the writer. The produced string is what gets persisted and what
 * the guard compares (DR3 invariant 3: 键即事实 — no second derivation from a timestamp).
 */
export function dreamWindowKey(entryCount: number, at: Date): string {
  const day = dayWindowKey(at);
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
   * The last COMPLETED dream, typed (`memory-meta.json#dream`). This — and only this —
   * satisfies the window guard: a manual `memory_organize` writes `organized`, which is
   * not an input here at all (DR3 invariant 1).
   */
  dream?: DreamRecord | null;
  /**
   * Window key of a dream RUNNING RIGHT NOW in this process ('' when idle). An in-flight
   * fact, not a record: it stops a slow dream and the next tick from both running, and it
   * is cleared when the run settles, so a failed run is retryable in the same process
   * (DR3 invariant 2).
   */
  dreamInFlightKey?: string;
}

/**
 * Run the dream cycle when the buffer is over its budget (primary) OR when there are
 * so many entries that search cost matters (secondary). Never when neither holds, so we
 * do not spend an LLM call on a healthy buffer.
 *
 * When `now` is supplied, additionally skip if a dream for this window already completed
 * (`dream.windowKey`, compared as a string) or is currently running
 * (`dreamInFlightKey`). That is the restart-duplicate guard, now expressed with the
 * event type it is actually about.
 */
export function shouldRunDreamCycle(input: DreamTriggerInput): boolean {
  const pressured =
    input.observationPercent >= MEMORY_DREAM_TRIGGER_PERCENT
    || input.entryCount >= MEMORY_DREAM_MIN_ENTRIES;
  if (!pressured) return false;

  if (input.now) {
    const windowKey = dreamWindowKey(input.entryCount, input.now);
    // Key-is-the-fact: a plain string comparison against what the writer stored. A record
    // whose key is empty/absent (unreadable legacy shape) simply never matches, so it can
    // only cause one extra dream — never a cancelled one.
    if (input.dream?.windowKey === windowKey) return false;
    if (input.dreamInFlightKey && input.dreamInFlightKey === windowKey) return false;
  }
  return true;
}
