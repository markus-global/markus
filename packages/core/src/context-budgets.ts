import { DEFAULT_REQUEST_MAX_TOKENS } from './llm/provider.js';

/**
 * Budget numbers that are DERIVED, not chosen.
 *
 * Why this file exists
 * --------------------
 * The context budget used to reserve the model catalog's maximum output for the
 * reply — 384,000 tokens on this machine — while sending at most 32,768 on the
 * wire and observing a maximum of 2,607 tokens across sampled calls. That locked
 * 37% of a 1,000k window for an output that never happens, and it was invisible:
 * the banner showed a percentage against the shrunken budget without saying why.
 *
 * The rule that replaces it:
 *
 *   reserve = min(catalogMax, max(wireCap, observedP99 * headroom, floor))
 *
 * Every term has an owner:
 *   catalogMax  — the provider's real limit (never exceed it)
 *   wireCap     — the `max_tokens` we actually send; the reserve may never be
 *                 smaller than this or the request can be rejected
 *   observedP99 — measured output length (telemetry: outputTokens per call)
 *   floor       — protects against thin telemetry
 *
 * Nothing here is a hand-tuned preference, and the same numbers drive what we
 * send and what we reserve (one variable, not two measures).
 */
export interface OutputReserveInput {
  /** Provider catalog ceiling for this model (may be undefined — unknown model). */
  catalogMaxOutput?: number;
  /** Explicit per-agent `maxTokens` config, if any. */
  configuredMaxTokens?: number;
  /** P99 of observed output tokens; 0/undefined when telemetry is thin. */
  observedP99?: number;
  /** Chosen floor when telemetry can't justify more. */
  floor?: number;
}

/** Headroom over observed P99 — one bad long reply must not truncate. */
export const OUTPUT_RESERVE_P99_HEADROOM = 1.5;

/** Default floor: the same value four providers already use on the wire. */
export const OUTPUT_RESERVE_FLOOR = DEFAULT_REQUEST_MAX_TOKENS;

export function resolveOutputReserve(input: OutputReserveInput): number {
  const floor = Math.max(1, input.floor ?? OUTPUT_RESERVE_FLOOR);
  // What we will actually ask for. When neither the agent nor the provider sets
  // it, the wire default applies (Anthropic/OpenAI/Google all send it).
  //
  // The floor is the DEFAULT WIRE CAP, not an extra max() term: an agent that
  // explicitly configures a smaller max_tokens has already told us the answer,
  // and forcing the floor on top would silently reserve 4x more than it asked
  // for — the original bug, one size smaller.
  const wireCap = Math.max(1, input.configuredMaxTokens ?? floor);
  const fromP99 = input.observedP99 && input.observedP99 > 0
    ? Math.ceil(input.observedP99 * OUTPUT_RESERVE_P99_HEADROOM)
    : 0;

  const wanted = Math.max(wireCap, fromP99);
  const ceiling = input.catalogMaxOutput && input.catalogMaxOutput > 0
    ? input.catalogMaxOutput
    : wanted;
  return Math.min(ceiling, wanted);
}

/**
 * Is a remembered provider report plausible for the pack we just built?
 *
 * The report is recorded at RESPONSE time against the agent's *current* session
 * (`noteReportedInputTokens(this.currentSessionId, …)`), which is not necessarily
 * the session that was packed — with concurrent workers the two differ. The value
 * then gets read back for a different pack.
 *
 * Measured damage: the water level jumped between 10% and 60% for the same
 * content, and reports appeared at 1.84x and 0.31x of their pack. A vendor count
 * for the previous call sits ~1.15x our own estimate (50 same-call samples), so
 * anything outside a generous band is not a measurement of this request.
 *
 * Rejecting it falls back to our estimate, which is honest: "we do not have a
 * reading" beats "we have the wrong reading".
 */
export const REPORTED_PLAUSIBLE_MIN_RATIO = 0.6;
export const REPORTED_PLAUSIBLE_MAX_RATIO = 1.5;

export function isPlausibleReported(reported: number | undefined, estimate: number): boolean {
  if (!reported || reported <= 0 || estimate <= 0) return false;
  const ratio = reported / estimate;
  return ratio >= REPORTED_PLAUSIBLE_MIN_RATIO && ratio <= REPORTED_PLAUSIBLE_MAX_RATIO;
}

/**
 * A truncation that does not announce itself is worse than no truncation: the
 * agent does not know its view of the world is partial, so it reasons from a
 * subset as if it were the whole.
 *
 * Every list cap in the system prompt must pass through here.
 */
export function omittedNotice(shown: number, total: number, hint: string): string | undefined {
  if (total <= shown || shown < 0) return undefined;
  const hidden = total - shown;
  return `… ${hidden} more not shown — ${hint}`;
}

/**
 * Truncate a block of text so the cut is VISIBLE and actionable.
 *
 * Used by every per-section character cap (SOPS, long-term memory, deliverables,
 * daily log, profile, CONTEXT.md…). Those caps exist for a good reason — an
 * unbounded document would dominate every single prompt — but a silent cut makes
 * the agent reason from a fragment it believes is whole.
 */
export function truncateWithNotice(
  text: string,
  maxChars: number,
  hint: string,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const cut = Math.max(0, maxChars);
  return {
    text: `${text.slice(0, cut)}\n…[+${(text.length - cut).toLocaleString()} chars not shown — ${hint}]`,
    truncated: true,
  };
}
