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

// ═══════════════════════════════════════════════════════════════════════════
// Compaction TIMING — when does compacting pay for itself?
// ═══════════════════════════════════════════════════════════════════════════
//
// `contextActionHint` above answers "are you running out of window?" — a HARD
// limit. It does NOT answer "is compacting worth the one-time re-bill?", which
// is an ECONOMIC question with a different answer.
//
// Those are two independent invariants and must not share one number: a session
// can sit at 63% of the window and still be the single most expensive thing in
// the org (measured 2026-10-29: human_chat = 78.3% of all prompt tokens while
// the A2A scenario the owner asked about was 20.6%).
//
// The model (this block IS the derivation — there is no separate design doc):
//
//   r(h)   = h·c_hit + (1−h)·c_miss          blended $/token
//   K      = P'·c_miss − P·r(h) + S·c_out    one-time cost of compacting
//   Δ      = f·P·r(h)                        saving per subsequent call
//   payback= K / Δ                           calls needed to break even
//
// Compacting invalidates the cached prefix ONCE (the next call is a full miss),
// but every later call carries a smaller prompt. So it is worth doing exactly
// when `payback ≤ remaining calls`. Two useful closed forms:
//
//   • horizon-free:  f > 0.8·h − ε   ⟺  K < 0   (pays off even for ONE call)
//   • never:         f < 4 / N       (because m(h) = 1/(1−0.8h) ≤ 5)
//
// `m(h)` is BOUNDED by 5 (since c_hit/c_miss = 0.2), so the bar for compacting
// can never exceed 4/N — there is no such thing as "my hit rate is so good that
// I should never compact".
//
// Owner rule (2026-10-29): the AGENT only ever sees the action, never this
// arithmetic. Numbers here are tuning/audit material; putting them in the
// prompt buries the instruction the agent is supposed to execute.

/** Tokens an anchor summary is assumed to produce (shared by both call paths). */
export const COMPACTION_SUMMARY_TOKENS = 3_000;

/**
 * Messages a compaction keeps verbatim — **单一来源**。
 *
 * 三处都读这一个值：session 工具的 `keep_last` 默认、`compactSession` /
 * `compactWithAnchor` 的默认参数、以及 `estimateCompactionFractions` 的估算基准。
 *
 * 此前这个事实被抄了四份、且有两个不同的数（这里 40、工具 40、store 里 40 和 20），
 * 于是"估算会砍掉多少"与"实际砍掉多少"可能对不上。
 */
export const DEFAULT_COMPACT_KEEP_LAST = 40;

/** Accepted range for an explicit `keep_last` — bounds live here, not in the clamp. */
export const COMPACT_KEEP_LAST_MIN = 5;
export const COMPACT_KEEP_LAST_MAX = 200;

/**
 * Estimate the two proxy quantities `compactionGuidance` needs.
 *
 * Both were wrong on first ship (measured 2026-10-29, real log line:
 * `fEst:0.95, nEst:1`) — the verdict happened to be right, but only because it
 * came from the horizon-free `K ≤ 0` branch. A shallow trim would have been
 * misadvised. Extracted here so both estimators are unit-testable instead of
 * living as inline magic numbers.
 *
 * **`nEst`** (calls we still expect to make). The first version used
 * `calls / turns` — "calls per turn" is NOT "calls left in this turn"; a session
 * with 15 calls over 15 turns produced `nEst = 1`, which makes the bar
 * `f* = (m−1)/(1+m)` needlessly high. The honest proxy is *this turn's progress*:
 * a tool loop that has already issued k calls is mid-flight, and k is the
 * best available expectation of the work still ahead. We cannot know about
 * future turns, so they contribute 0 and the estimate stays conservative.
 *
 * **`fEst`** (fraction compaction actually frees). The first version counted
 * everything older than the recent tail — but `session compact` also WRITES a
 * summary, which is new prompt volume. Ignoring it inflated the benefit:
 * f=0.95 assumed a 20× shrink that cannot happen, because the summary is
 * re-sent on every later call. Summary cost is subtracted here.
 *
 * @returns `fEst` in [0, 0.95], `nEst` ≥ 1.
 */
export function estimateCompactionFractions(input: {
  /** Provider-reported prompt tokens for this session. */
  promptTokens: number;
  /** Total characters across the assembled prompt. */
  totalChars: number;
  /** Characters in the messages compaction keeps verbatim (the recent tail). */
  recentChars: number;
  /** Assistant turns already issued in the current user turn. */
  callsThisTurn: number;
  summaryTokens?: number;
}): { fEst: number; nEst: number } {
  const S = input.summaryTokens ?? COMPACTION_SUMMARY_TOKENS;
  // No measurable prompt ⇒ nothing to compact. Returning 0.95 here would claim
  // "95% is compactable" from zero evidence (the exact failure mode this file's
  // `null`-not-zero rule exists to prevent).
  if (!(input.totalChars > 0) || !(input.promptTokens > 0)) {
    return { fEst: 0, nEst: Math.max(1, Math.min(50, Math.round(input.callsThisTurn))) };
  }
  const keepRatio = input.recentChars / input.totalChars;
  const summaryRatio = S / input.promptTokens;
  const fEst = Math.max(0, Math.min(0.95, 1 - keepRatio - summaryRatio));
  const nEst = Math.max(1, Math.min(50, Math.round(input.callsThisTurn)));
  return { fEst, nEst };
}

/** Re-state an unchanged verdict every N calls (bounds staleness). */
export const COMPACTION_REARM_CALLS = 20;

/**
 * Decide whether to put the compaction advisory in the prompt THIS call.
 *
 * Emitting every call is how a banner gets trained out of attention; emitting
 * only on change means an ignored advisory is never repeated. So: speak on the
 * FIRST evaluation, whenever the verdict FLIPS, and otherwise at most once per
 * `rearmCalls` (same pattern as `CONTEXT_VOLATILE_REARM_CALLS`).
 *
 * The first-emit rule is not cosmetic — the shipped version had a bug here: the
 * "no measurement" branch seeded a verdict of `'hold'` it had never computed, so
 * the first genuine `'hold'` compared equal to the seed and was swallowed. The
 * agent never saw the first advice at all. `previous.verdict` is therefore
 * optional, and `undefined` means "nothing has ever been said".
 */
export function shouldEmitCompactionHint(input: {
  previous?: { verdict?: CompactionAction; emittedAtCall: number };
  action: CompactionAction;
  /** 1-based index of this call within the session. */
  callIndex: number;
  rearmCalls?: number;
}): boolean {
  const rearm = input.rearmCalls ?? COMPACTION_REARM_CALLS;
  if (!input.previous || input.previous.verdict === undefined) return true; // first ever
  if (input.previous.verdict !== input.action) return true; // flipped
  return input.callIndex - input.previous.emittedAtCall >= rearm; // stale reminder
}

/**
 * DeepSeek v4-flash list prices, measured from model-catalog-cache.json.
 */
export const COMPACTION_PRICE = {
  /** `input_cost_per_token` (cache miss). */
  missPerToken: 0.20e-6,
  /** `cache_read_input_token_cost` (cache hit) — exactly 1/5 of a miss. */
  hitPerToken: 0.04e-6,
  /** `output_cost_per_token`. */
  outputPerToken: 0.40e-6,
} as const;

export type CompactionAction = 'compact' | 'hold';

export interface CompactionGuidance {
  action: CompactionAction;
  /** Tuning/audit only — MUST NOT be rendered into the prompt. */
  params: {
    hitRate: number;
    /** Fraction of the prompt that compaction could drop (0..1). */
    fEst: number;
    /** Estimated remaining calls at this turn's observed pace. */
    nEst: number;
    /** Break-even fraction for this `nEst`. */
    fStar: number;
    /** Calls needed to recoup `K`. `null` when Δ ≤ 0 (nothing to save). */
    paybackCalls: number | null;
    oneTimePenaltyUsd: number;
    savingPerCallUsd: number;
    blendedPerToken: number;
  };
}

/**
 * Decide whether compacting now is cheaper than not compacting.
 *
 * Pure: same input ⇒ same output, no clocks, no globals. Returns `null` when the
 * caller has no usable measurement (no hit rate / empty prompt) — the caller
 * must then stay SILENT rather than guess.
 */
/**
 * Below this prompt size, compaction is never worth advising.
 *
 * The ratio model above is scale-free: it answers "does this pay back in N calls",
 * which is the right question only when the absolute saving is material. At 68k
 * tokens it optimizes pennies while the summary is lossy — and, because `fEst` is
 * optimistically seeded at 0.95 for the first calls of a turn, it fired
 * "now is the cheapest time to compact" at the START of every turn on sessions
 * that had just been compacted. A banner that flickers on and off teaches agents
 * to ignore it, which is the exact failure this file exists to prevent.
 *
 * 150k ≈ $0.006 per cache-miss call at list price; below that the saving is noise.
 */
export const COMPACTION_MIN_PROMPT_TOKENS = 150_000;

export function compactionGuidance(input: {
  /** Provider-reported prompt tokens for this session. */
  promptTokens: number;
  /** Observed cache hit rate (0..1). */
  hitRate: number;
  /** Fraction of the prompt compaction could drop (0..1). */
  fEst: number;
  /** Estimated remaining calls (≥ 1). */
  nEst: number;
  /** Tokens the anchor summary will produce (default 3000). */
  summaryTokens?: number;
}): CompactionGuidance | null {
  const { missPerToken: cMiss, hitPerToken: cHit, outputPerToken: cOut } = COMPACTION_PRICE;
  const P = input.promptTokens;
  const h = input.hitRate;
  const f = input.fEst;
  const n = input.nEst;
  if (!(P > 0) || !Number.isFinite(h) || !Number.isFinite(f) || !(n >= 1)) return null;
  // Absolute floor — see COMPACTION_MIN_PROMPT_TOKENS. Silences the whole signal
  // (no line, no state) where the ratio math would only optimize pennies.
  if (P < COMPACTION_MIN_PROMPT_TOKENS) return null;
  if (h < 0 || h > 1 || f <= 0 || f >= 1) return null;

  const S = input.summaryTokens ?? 3000;
  const blend = h * cHit + (1 - h) * cMiss; // r(h)
  if (!(blend > 0)) return null;

  const pAfter = P * (1 - f);
  // One-time: next call is a full miss on the SMALLER prompt, minus what this
  // call would have cost anyway, plus the summary we have to generate.
  const oneTimePenaltyUsd = pAfter * cMiss - P * blend + S * cOut;
  const savingPerCallUsd = f * P * blend;
  const paybackCalls = savingPerCallUsd > 0 ? oneTimePenaltyUsd / savingPerCallUsd : null;

  // m(h) = c_miss / r(h) ∈ [1, 5]; fStar = (m−1)/(n+m)
  const m = cMiss / blend;
  const fStar = (m - 1) / (n + m);

  // Compact when it recoups within the calls we expect to make. `K ≤ 0` is the
  // horizon-free case (worth it even if this is the last call).
  const action: CompactionAction =
    oneTimePenaltyUsd <= 0 || f > fStar || (paybackCalls !== null && paybackCalls <= n)
      ? 'compact'
      : 'hold';

  return {
    action,
    params: { hitRate: h, fEst: f, nEst: n, fStar, paybackCalls, oneTimePenaltyUsd, savingPerCallUsd, blendedPerToken: blend },
  };
}

/**
 * The ONLY compaction text the agent ever sees: the action, and the lever.
 *
 * Deliberately carries no numbers — see the cost-model block above. The reason
 * clause differs (cheapest-now vs the window is about to overflow) but there is
 * exactly ONE line, because both reasons prescribe the SAME action. Two lines
 * would be two execution points for one invariant.
 */
export function compactionActionLine(
  action: CompactionAction,
  opts?: { overflow?: boolean },
): string {
  if (action === 'compact') {
    const reason = opts?.overflow
      ? 'The next request may not fit in the window'
      : 'Now is the cheapest time to compact — one call now makes every later call cheaper';
    return `[COMPACT] ${reason}. Use \`session\` operation:'compact' (optionally goal/done/next); operation:'pin' for the one fact you must not lose.`;
  }
  return '[COMPACT] Not worth it yet — keep going (a partial trim costs more than it saves).';
}


// `contextActionHint()` deleted 2026-10-29: it was the SECOND execution point
// for "should I compact" — it spoke at ≥70% window pressure while
// `compactionGuidance()` decides the same action economically, so the agent got
// two differently-worded instructions for one action. Window pressure survives
// as the `overflow` reason inside that single decision.

