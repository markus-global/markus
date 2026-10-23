/**
 * Context pressure signalling — the ONE place that decides what the agent is
 * told about its own context usage.
 *
 * Design rule (Owner, 2026-10-23)
 * ------------------------------
 * The platform does NOT trim history to make the bill smaller. Inside a turn,
 * history IS the agent's working memory; dropping it makes the agent re-derive
 * state, which costs far more than it saves.
 *
 * Measured on tsk_5d43170472f6c0440a5666a7 (2026-10-23): a single task turn ran
 * 251 LLM calls / 18.7M input tokens while re-reading the same files (223 shell
 * calls) and re-stating its own position 63 times. The untrimmed equivalent was
 * ~6M. The trim was the cost, not the saving.
 *
 * What used to live here and is now deleted
 * -----------------------------------------
 *   - per-scenario VIEW budgets (`applyViewBudget`, the POLICIES table)
 *   - the 120k absolute history ceiling and its 72k fold target
 *   - proactive compaction at 75% of the window
 *   - the double LLM summarization fallback
 *
 * What replaced it
 * ----------------
 * One physical bound only (the request must fit the model window, enforced in
 * `context-engine.ts` Stage 2) plus an ACTIONABLE signal. The agent owns the
 * decision and has real levers: `session` operation:'compact' pages history into
 * an anchor summary; operation:'pin' preserves one fact across compaction.
 *
 * A warning with no lever is worse than no warning — it trains agents to ignore
 * banners. So this function only speaks when the agent can actually act, and it
 * names the call.
 */

/** Advisory from 70%, directive from 85%. Silent below that. */
export const CONTEXT_HINT_ADVISORY_PCT = 70;
export const CONTEXT_HINT_DIRECTIVE_PCT = 85;

/**
 * Actionable companion to the `[CONTEXT n% used …]` banner.
 *
 * Returns `undefined` when the agent has no lever (memory_consolidation /
 * distillation must read everything, so telling them to compact would be a lie).
 */
export function contextActionHint(opts: { usedPct: number; canCompact: boolean }): string | undefined {
  if (!opts.canCompact) return undefined;
  if (opts.usedPct >= CONTEXT_HINT_DIRECTIVE_PCT) {
    return (
      'ACT NOW: context is nearly full. Before your next big step, call the `session` tool with ' +
      "operation:'compact' (optionally goal/done/next) to collapse stale history into an anchor " +
      "summary; use operation:'pin' for the one fact you must not lose. This costs one call now " +
      'and makes every later call cheaper.'
    );
  }
  if (opts.usedPct >= CONTEXT_HINT_ADVISORY_PCT) {
    return (
      'Context is getting heavy. If the earlier part of this session is no longer needed ' +
      "(finished sub-tasks, stale tool output), consider `session` operation:'compact' — " +
      'it pages out old history and keeps an anchor summary.'
    );
  }
  return undefined;
}
