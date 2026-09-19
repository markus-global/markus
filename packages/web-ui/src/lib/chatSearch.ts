/**
 * chatSearch — find-in-conversation for the current chat session.
 *
 * Scope is deliberately the *loaded* transcript of the open session, searched
 * client-side: the user asked for "search this session's history and jump to the
 * hit", which must feel instant and must land on a real rendered bubble. A
 * server round-trip would answer a different question (matches across every
 * conversation) and could not jump into a virtualized list it knows nothing
 * about. `hasMore` tells the UI when older messages exist that were not scanned.
 *
 * Pure and DOM-free so the matching rules are unit-testable.
 */

/** Which part of a message a hit came from. */
export type ChatSearchField = 'text' | 'thinking' | 'tool';

/** The minimal shape we need — `ChatMsg` and `MsgSegment` satisfy it structurally. */
export interface ChatSearchableSegment {
  type: string;
  content?: string;
  thinking?: string;
  tool?: string;
  result?: string;
  error?: string;
}

export interface ChatSearchableMessage {
  id: string;
  text?: string;
  segments?: readonly ChatSearchableSegment[];
}

export interface ChatSearchMatch {
  /** Index into the message array that was searched (i.e. the virtualizer index). */
  messageIndex: number;
  messageId: string;
  field: ChatSearchField;
  /** One-line excerpt around the hit, whitespace collapsed. */
  snippet: string;
  /** Offset of the hit inside `snippet`, for bolding it. */
  snippetMatchStart: number;
  snippetMatchLength: number;
}

export interface ChatSearchOutcome {
  matches: ChatSearchMatch[];
  /** How many messages were actually scanned. */
  scanned: number;
  /** True when the cap stopped the scan early, so the count is a lower bound. */
  truncated: boolean;
}

/** Upper bound on collected hits — a one-letter query must not build 10k rows. */
export const MAX_CHAT_SEARCH_MATCHES = 300;

const SNIPPET_RADIUS = 48;

/**
 * Fields to search for one message, mirroring what the bubble actually renders:
 * segmented replies show their segments (streamed text lives there), plain
 * messages show `text`. Searching both would double-count the same sentence.
 */
function fieldsFor(msg: ChatSearchableMessage): Array<{ field: ChatSearchField; value: string }> {
  const out: Array<{ field: ChatSearchField; value: string }> = [];
  if (msg.segments && msg.segments.length > 0) {
    for (const seg of msg.segments) {
      if (seg.type === 'text') {
        if (seg.thinking) out.push({ field: 'thinking', value: seg.thinking });
        if (seg.content) out.push({ field: 'text', value: seg.content });
      } else if (seg.type === 'tool') {
        const parts = [seg.tool, seg.result, seg.error].filter((p): p is string => !!p);
        if (parts.length > 0) out.push({ field: 'tool', value: parts.join('\n') });
      }
    }
    if (out.length > 0) return out;
  }
  if (msg.text) out.push({ field: 'text', value: msg.text });
  return out;
}

/** One-line excerpt around a hit, with the offset of the hit inside it. */
export function snippetFor(
  value: string,
  index: number,
  length: number,
  radius: number = SNIPPET_RADIUS,
): { text: string; matchStart: number; matchLength: number } {
  const start = Math.max(0, index - radius);
  const end = Math.min(value.length, index + length + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < value.length ? '…' : '';
  const before = value.slice(start, index).replace(/\s+/g, ' ');
  const matched = value.slice(index, index + length).replace(/\s+/g, ' ');
  const after = value.slice(index + length, end).replace(/\s+/g, ' ');
  return {
    text: `${prefix}${before}${matched}${after}${suffix}`,
    matchStart: prefix.length + before.length,
    matchLength: matched.length,
  };
}

/**
 * All hits for `query` in the given messages, ordered as they appear in the
 * transcript (message order, then field order, then occurrence order) so "next
 * match" always moves down the conversation.
 */
export function searchChatHistory(
  messages: readonly ChatSearchableMessage[],
  query: string,
  opts: { limit?: number } = {},
): ChatSearchOutcome {
  const limit = opts.limit ?? MAX_CHAT_SEARCH_MATCHES;
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length === 0) return { matches: [], scanned: messages.length, truncated: false };

  const matches: ChatSearchMatch[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i]!;
    for (const { field, value } of fieldsFor(msg)) {
      const haystack = value.toLocaleLowerCase();
      let from = 0;
      for (;;) {
        const hit = haystack.indexOf(needle, from);
        if (hit === -1) break;
        const snip = snippetFor(value, hit, needle.length);
        matches.push({
          messageIndex: i,
          messageId: msg.id,
          field,
          snippet: snip.text,
          snippetMatchStart: snip.matchStart,
          snippetMatchLength: snip.matchLength,
        });
        if (matches.length >= limit) return { matches, scanned: messages.length, truncated: true };
        from = hit + needle.length;
      }
    }
  }
  return { matches, scanned: messages.length, truncated: false };
}

/**
 * Wrap-around cursor for next / previous match. `-1` means "nothing selected
 * yet": a forward step starts at the first hit, a backward step at the last one.
 */
export function nextMatchCursor(current: number, delta: number, total: number): number {
  if (total <= 0) return -1;
  if (current < 0) return delta >= 0 ? 0 : total - 1;
  return ((current + delta) % total + total) % total;
}
