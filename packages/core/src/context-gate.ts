/**
 * Hard context gate — the enforcement point for context pressure.
 *
 * ## Why this exists
 *
 * The platform already told agents to compact: the `[CONTEXT]` banner escalates
 * from advisory (70%) to directive "ACT NOW" (85%) to "the next request may not
 * fit" (95%). On 2026-10-26 two agents still sent prompts past a 1M window
 * (1,072,931 and 1,848,862 tokens) and the provider rejected both with HTTP 400.
 * Both were a2a/mailbox-driven turns.
 *
 * The diagnosis is not "the warning was too quiet". A warning that carries no
 * consequence is decoration, and a banner nobody must obey teaches agents to
 * ignore banners. What was missing is a point where the platform *stops* the
 * turn from growing instead of asking the model nicely.
 *
 * ## What it does, and what it deliberately does not
 *
 * At/above {@link CONTEXT_GATE_RATIO} the turn is restricted to the two levers
 * that reduce or end context:
 *
 *   • `session`  — compact (collapse stale history) or pin (freeze one fact)
 *   • `end_turn` — stop cleanly instead of being forced to act
 *
 * The choice between compact and pin stays with the agent (Owner decision): the
 * gate removes "ignore it and carry on", not agency.
 *
 * The platform never compacts on the agent's behalf (Owner decision, 2026-10-26).
 * Deciding what to forget is the agent's judgement call; the platform only
 * refuses to keep growing a prompt that will not fit.
 *
 * ## Fail-open
 *
 * With no provider measurement for a session there is no water level to gate on.
 * The gate stays off rather than estimating a prompt size — estimation was
 * deliberately removed from this platform, and a guess would fire either too
 * late (the failure we are fixing) or too early (blocking healthy work).
 */
import { CONTEXT_GATE_RATIO } from '@markus/shared';

/**
 * Tools that remain callable under the gate. Both shrink or end the turn;
 * neither grows the prompt. This is an allowlist, not a blocklist: a new tool
 * added later must be *deliberately* exempted rather than silently slipping past
 * the gate.
 */
export const CONTEXT_GATE_ALLOWED_TOOLS: ReadonlySet<string> = new Set(['session', 'end_turn']);

/** True when the measured context usage is at/above the hard gate. */
export function isContextGateActive(measuredPct: number | undefined): boolean {
  if (measuredPct === undefined || !Number.isFinite(measuredPct)) return false;
  return measuredPct >= CONTEXT_GATE_RATIO * 100;
}

/**
 * The refusal returned to the model when the gate blocks a call, or `undefined`
 * when the call may proceed.
 *
 * The message is the whole recovery path: a model that only sees "blocked" will
 * retry the same tool. So it names the permitted calls, states that nothing was
 * compacted for it, and says the decision is still the agent's.
 */
export function contextGateRefusal(
  toolName: string,
  measuredPct: number | undefined,
): string | undefined {
  if (CONTEXT_GATE_ALLOWED_TOOLS.has(toolName)) return undefined;
  if (!isContextGateActive(measuredPct)) return undefined;
  const pct = measuredPct as number;
  return JSON.stringify({
    status: 'error',
    code: 'CONTEXT_GATE',
    blockedTool: toolName,
    contextPercent: pct,
    allowedTools: [...CONTEXT_GATE_ALLOWED_TOOLS],
    message:
      `Blocked: this session is at ${pct}% of the model window (hard gate ${CONTEXT_GATE_RATIO * 100}%). ` +
      'Only `session` and `end_turn` may be called now. ' +
      "Call the `session` tool with operation:'compact' (optionally goal/done/next) to collapse " +
      "stale history into an anchor summary, or operation:'pin' to freeze the one fact you must " +
      'not lose, then continue your work. ' +
      'Nothing was compacted automatically — that decision is yours, but it cannot be skipped.',
  });
}
