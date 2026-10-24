import { getTextContent, type LLMMessage } from '@markus/shared';

/**
 * Elide STALE tool results when the request no longer fits.
 *
 * WHY THIS IS NOT "TRIMMING HISTORY"
 * ----------------------------------
 * The platform was told, correctly, not to cut history to make the bill smaller:
 * inside a turn, history IS the agent's working memory, and dropping it makes the
 * agent re-derive state for more than it saved.
 *
 * A tool result from 200 calls ago is a different object. It is not working
 * memory — it is a payload the agent already acted on. Keeping it verbatim costs
 * the cache, the budget, and attention; the agent almost never re-reads it, and
 * when it does, re-running the tool is cheap and CORRECT (the file may have
 * changed since).
 *
 * So this elides the *bulk*, never the reasoning: assistant prose, user
 * instructions and the recent tool results are untouched.
 *
 * INVARIANTS
 * ----------
 *  - `toolCallId` is preserved on every elided message. Providers require the
 *    tool message to answer the assistant's `tool_calls` entry; dropping or
 *    changing the id would invalidate the whole message sequence (400 from the
 *    API), which is a much worse failure than a cache miss.
 *  - The current turn is never touched (the agent is actively using it).
 *  - The elision is VISIBLE in-band, with the size and how to get the data back.
 *    A silently shortened history is the failure mode we already paid for once.
 */
export interface ElideResult {
  messages: LLMMessage[];
  elided: number;
  freedChars: number;
}

export interface ElideOptions {
  /** Keep this many most-recent tool results verbatim (0 = elide all eligible). */
  keepRecent: number;
  /** Only elide results at least this long — small ones are not worth a stub. */
  minChars: number;
  /**
   * Index at which the current turn starts. Nothing at or after it is eligible:
   * those results are what the agent is reasoning about right now.
   */
  currentTurnStart: number;
}

/** Marker so a re-elision pass does not re-wrap an already-elided result. */
export const ELIDED_MARKER = '[tool result elided';

export function elideStaleToolResults(messages: LLMMessage[], opts: ElideOptions): ElideResult {
  const { keepRecent, minChars, currentTurnStart } = opts;

  // Indices (in history order) of tool messages that are eligible at all.
  const eligible: number[] = [];
  messages.forEach((m, i) => {
    if (m.role !== 'tool') return;
    if (i >= currentTurnStart) return;                       // current turn: hands off
    const text = getTextContent(m.content);
    if (text.length < minChars) return;                      // not worth a stub
    if (text.startsWith(ELIDED_MARKER)) return;               // already elided
    eligible.push(i);
  });

  // Keep the most recent N of the eligible ones verbatim.
  const toElide = keepRecent > 0 ? eligible.slice(0, Math.max(0, eligible.length - keepRecent)) : eligible;
  if (toElide.length === 0) return { messages, elided: 0, freedChars: 0 };

  const next = messages.slice();
  let freedChars = 0;

  for (const i of toElide) {
    const m = next[i]!;
    const text = getTextContent(m.content);
    freedChars += text.length;
    next[i] = {
      // Spread first: `toolCallId` and every other transport field must survive.
      ...m,
      content:
        `${ELIDED_MARKER} — ${text.length.toLocaleString()} chars, omitted to free context; ` +
        `nothing was decided from it that is not already in your later messages. ` +
        `Re-run the tool (or re-read the file) if you need it again — that also gives you ` +
        `the CURRENT state instead of this stale copy.]`,
    };
  }

  return { messages: next, elided: toElide.length, freedChars };
}
