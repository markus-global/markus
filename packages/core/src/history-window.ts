/**
 * Prefix-cache-safe request-history window.
 *
 * Why this exists
 * ---------------
 * Every LLM call replays a window of the session transcript. The naive
 * implementation (`getRecentMessages(sessionId, N)`) returns the **last N**
 * messages, so once a session exceeds N the window head slides by 1–2 messages
 * on EVERY turn. The implicit prefix cache (OpenAI / DeepSeek / OpenRouter) is
 * byte-prefix based: a single changed message at the head invalidates the whole
 * replayed history (~90k tokens re-billed per call in a long agent loop).
 *
 * The fix is quantization, not a bigger N: keep at least `minMessages` and only
 * advance the window start in `block`-sized jumps. The head then stays
 * byte-identical for ~block/2 turns, so the cache keeps hitting while the
 * window is still bounded.
 *
 * Sanity: for total=399/min=400 → start 0 (no cut).
 *         total=400 → 0; total=499 → 0; total=500 → 100 (a single 100-message
 *         jump instead of 100 single-message slides).
 */
import { SESSION_REQUEST_HISTORY_BLOCK } from '@markus/shared';

/**
 * Index of the first message to replay. Always `>= 0` and `<= total - minMessages`
 * (clamped), and a multiple of `block` whenever a cut happens.
 */
export function requestHistoryStart(
  total: number,
  minMessages: number,
  block: number = SESSION_REQUEST_HISTORY_BLOCK,
): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  const safeMin = Math.max(1, Math.floor(minMessages));
  if (total <= safeMin) return 0;
  const safeBlock = Math.max(1, Math.floor(block));
  return Math.max(0, Math.floor((total - safeMin) / safeBlock) * safeBlock);
}

/** Slice `messages` down to the cache-safe request window (see module doc). */
export function requestHistoryWindow<T>(
  messages: readonly T[],
  minMessages: number,
  block?: number,
): T[] {
  return messages.slice(requestHistoryStart(messages.length, minMessages, block));
}
