/**
 * Per-scenario VIEW budget — how much conversation history the model is allowed
 * to see on a single call.
 *
 * Why this exists
 * ---------------
 * Measured on 2026-10-19/20 (`agent_activities`): a single a2a wake-up cost
 * 1.65M input tokens = 8 LLM calls x 214k. Of that 214k, only 41.7k was the
 * fixed segment (system + tool definitions); **~170k was replayed history**.
 * The same agent's per-call context grew 4.4x in five days (57k -> 253k) purely
 * because `chat_sessions` are never reset: message N re-sends messages 1..N-1.
 *
 * The industry split is explicit: what a session STORES and what the model SEES
 * per call are two different things.
 *   - AutoGen: `BufferedChatCompletionContext` / `TokenLimitedChatCompletionContext`
 *     bound "what the model sees per call" while the team keeps full state.
 *   - LangGraph: `trim_messages(max_tokens, start_on, end_on)` cuts at message
 *     boundaries.
 *   - Google ADK: token threshold + `event_retention_size` (keep a raw tail,
 *     summarize the head).
 *   - OpenAI Agents SDK: re-feeds the whole session and noisily warns that this
 *     inflates input tokens (the shape we currently have).
 *
 * Design rule (R2/R3 avoidance)
 * -----------------------------
 * There is exactly ONE place that decides the view budget — `viewBudgetForScenario`
 * — and exactly ONE function that applies it — `applyViewBudget`. Call sites
 * cannot invent their own thresholds.
 *
 * Backward compatibility
 * ----------------------
 * Nothing here touches storage. Existing sessions keep every row; they are only
 * *presented* a tail. Returning `undefined` from `viewBudgetForScenario` restores
 * today's window-based behaviour exactly, so this can be rolled out per scenario.
 */

import type { AgentScenario } from './agent.js';

export interface ViewBudgetPolicy {
  /** Max estimated tokens of variable (history) segment the model may see. */
  viewTokens: number;
  /**
   * Always keep at least this many trailing messages verbatim, even when they
   * already exceed `viewTokens`. Guards pronoun/antecedent resolution ("那个卡")
   * and the tool-call/result pairs of the CURRENT action.
   */
  minRecentMessages: number;
}

/**
 * Default view budgets.
 *
 * Values are deliberately conservative (several x below current observed
 * per-call context) because the goal is to stop replay from dominating:
 * measured a2a was ~170k variable tokens; 30k leaves room for a real exchange
 * while removing the accumulated archive.
 */
const POLICIES: Partial<Record<AgentScenario, ViewBudgetPolicy>> = {
  heartbeat: { viewTokens: 8_000, minRecentMessages: 4 },
  peer_query: { viewTokens: 24_000, minRecentMessages: 6 },
  a2a: { viewTokens: 30_000, minRecentMessages: 8 },
  requirement_action: { viewTokens: 30_000, minRecentMessages: 6 },
  workflow_action: { viewTokens: 30_000, minRecentMessages: 6 },
  comment_response: { viewTokens: 40_000, minRecentMessages: 8 },
  deliberation: { viewTokens: 40_000, minRecentMessages: 8 },
  review: { viewTokens: 50_000, minRecentMessages: 8 },
  task_execution: { viewTokens: 60_000, minRecentMessages: 10 },
  group_chat: { viewTokens: 60_000, minRecentMessages: 8 },
  chat: { viewTokens: 120_000, minRecentMessages: 12 },
  // memory_consolidation / distillation intentionally have NO policy: they must
  // read the whole history, and trimming there would corrupt the memory itself.
};

/** Policy for a scenario, or `undefined` = "no view cap, behave as before". */
export function viewBudgetForScenario(scenario: AgentScenario | undefined): ViewBudgetPolicy | undefined {
  if (!scenario) return undefined;
  return POLICIES[scenario];
}

export interface ViewBudgetResult<T> {
  messages: T[];
  /** Number of leading messages dropped (0 = no trimming happened). */
  dropped: number;
  /** True when a trim marker was prepended. */
  trimmed: boolean;
}

type RoleBearing = { role?: string };

/**
 * Keep the tail of `messages` within `policy.viewTokens`, cutting only at
 * message boundaries.
 *
 * Structural safety (this is the part that must not be relaxed):
 *   - never start the kept window with a `tool` message — that would leave a
 *     tool result without its originating assistant tool_call, which providers
 *     reject and which silently corrupts the turn;
 *   - always keep the final message (it is the current trigger / latest result);
 *   - always honour `minRecentMessages`.
 *
 * `estimateTokens` is injected so this stays a pure function with no tokenizer
 * coupling (callers pass the engine's own counter, so estimates agree).
 */
export function applyViewBudget<T extends RoleBearing>(
  messages: T[],
  policy: ViewBudgetPolicy | undefined,
  opts: {
    estimateTokens: (msg: T) => number;
    /** Marker factory; return undefined to skip prepending a marker. */
    makeMarker?: (dropped: number) => T | undefined;
  },
): ViewBudgetResult<T> {
  if (!policy || messages.length === 0) {
    return { messages, dropped: 0, trimmed: false };
  }

  const { viewTokens, minRecentMessages } = policy;
  const keep = Math.max(0, minRecentMessages);

  // Always keep the trailing `keep` messages; then extend backwards while the
  // budget allows.
  let start = Math.max(0, messages.length - keep);
  let used = 0;
  for (let i = start; i < messages.length; i++) used += opts.estimateTokens(messages[i]);

  while (start > 0) {
    const cost = opts.estimateTokens(messages[start - 1]);
    if (used + cost > viewTokens) break;
    used += cost;
    start--;
  }

  // Structural repair: a kept window may not begin with a tool result.
  while (start < messages.length && messages[start]?.role === 'tool') {
    start++;
  }

  // Never drop the last message.
  if (start >= messages.length) start = messages.length - 1;

  const dropped = start;
  if (dropped <= 0) {
    return { messages, dropped: 0, trimmed: false };
  }

  const kept = messages.slice(start);
  const marker = opts.makeMarker?.(dropped);
  return {
    messages: marker ? [marker, ...kept] : kept,
    dropped,
    trimmed: !!marker,
  };
}

/** Human-readable marker text, mirroring the existing restore-time wording. */
export function viewBudgetMarkerText(dropped: number, viewTokens: number): string {
  return (
    `[Earlier conversation trimmed — ${dropped} older messages omitted to keep this turn's ` +
    `context under ${viewTokens} tokens. The full history is still stored: use ` +
    `task_get / recall_activity / session if you need a specific earlier detail.]`
  );
}

/**
 * Actionable companion to the `[CONTEXT n% used …]` banner.
 *
 * The banner alone reports a number the agent cannot act on — the platform's own
 * rule is that an always-lit warning with no lever is worse than none, because
 * it trains agents to ignore banners. This function only speaks when the agent
 * has a real lever (session compact / session pin) and names the call.
 *
 * Thresholds: advisory at 70%, directive at 85%. Below that, stay silent.
 */
export function contextActionHint(opts: { usedPct: number; canCompact: boolean }): string | undefined {
  if (!opts.canCompact) return undefined;
  if (opts.usedPct >= 85) {
    return (
      'ACT NOW: context is nearly full. Before your next big step, call the `session` tool with ' +
      "operation:'compact' (optionally goal/done/next) to collapse stale history into an anchor " +
      "summary; use operation:'pin' for the one fact you must not lose. This costs one call now " +
      'and makes every later call cheaper.'
    );
  }
  if (opts.usedPct >= 70) {
    return (
      'Context is getting heavy. If the earlier part of this session is no longer needed ' +
      "(finished sub-tasks, stale tool output), consider `session` operation:'compact' — " +
      'it pages out old history and keeps an anchor summary.'
    );
  }
  return undefined;
}
