import { getTextContent, type LLMMessage } from '@markus/shared';

/**
 * Where the context budget actually goes.
 *
 * WHY THIS EXISTS
 * ---------------
 * The `[CONTEXT]` banner could say `variable 120k` but not *what* that was. In a
 * long tool loop the answer is almost entirely tool results, and that is the only
 * category with a cheap fix (dedupe a re-read, spool a big output to a file,
 * elide a stale one). Without the breakdown we were guessing which lever to pull.
 *
 * Counting is delegated (`countText`) so this file cannot drift from the engine's
 * real tokenizer — two estimators would be two truths.
 */
export interface ContextComposition {
  /** User / system-injected instruction messages. */
  user: number;
  /** Assistant prose (what the model said). */
  assistant: number;
  /** JSON of assistant `toolCalls` (arguments live here). */
  toolCalls: number;
  /** Tool results — usually the bulk of a long loop. */
  toolResults: number;
  /** Sum of the above (variable segment only; fixed segments are separate). */
  total: number;
}

type CountText = (text: string) => number;

/**
 * Break the variable segment down by message role.
 *
 * `rawContent` is used where available (a tool result's stored payload) so a
 * message that was already transformed in memory is not mis-measured.
 */
export function summarizeComposition(
  messages: LLMMessage[],
  countText: CountText,
): ContextComposition {
  const c: ContextComposition = { user: 0, assistant: 0, toolCalls: 0, toolResults: 0, total: 0 };

  for (const m of messages) {
    const text = getTextContent(m.content);

    if (m.role === 'tool') {
      c.toolResults += countText(text);
      continue;
    }
    if (m.role === 'assistant') {
      if (text) c.assistant += countText(text);
      if (m.toolCalls?.length) c.toolCalls += countText(JSON.stringify(m.toolCalls));
      continue;
    }
    if (m.role === 'user') {
      c.user += countText(text);
    }
    // 'system' messages are part of the fixed segment, not the variable one.
  }

  c.total = c.user + c.assistant + c.toolCalls + c.toolResults;
  return c;
}

/**
 * One-line, percentage form for the banner and the log.
 *
 * Percentages of the VARIABLE segment (not of the window): the question this
 * answers is "what is my history made of", and the fixed segments are already
 * itemised separately in the same banner.
 */
export function formatComposition(c: ContextComposition): string {
  if (c.total <= 0) return 'empty';
  const pct = (n: number) => Math.round((n / c.total) * 100);
  const parts = [
    `tool-results ${pct(c.toolResults)}%`,
    `assistant ${pct(c.assistant)}%`,
    `tool-calls ${pct(c.toolCalls)}%`,
    `user ${pct(c.user)}%`,
  ];
  return parts.join(' · ');
}

/**
 * The share of history taken by tool results, 0..1.
 *
 * This is the single number that decides whether elision/dedupe/spooling is worth
 * doing, so it is a first-class helper rather than a subtraction at each call site.
 */
export function toolResultShare(c: ContextComposition): number {
  if (c.total <= 0) return 0;
  return c.toolResults / c.total;
}
