/**
 * Derive a human-meaningful chat session title.
 *
 * The web client composes the outgoing message as `[context chips] + userText`
 * — terminal / HTML selections are prepended as `[xxx]` fenced blocks. Slicing
 * that raw payload therefore produces junk titles such as
 * `[terminal-selection] Terminal: …`.
 *
 * Structure must NOT be inferred from the payload: the caller supplies the
 * user's own words explicitly (`titleSource`). When that is absent and the
 * message is only injected context, we deliberately return `null` (leave the
 * title unset — the agent renames on its first turn) instead of fabricating one.
 */
const INJECTED_CHIP_MARKERS = ['[terminal-selection]', '[terminal-output]', '[html-selection]'];

/** True when the message body begins with an injected context chip. */
export function isInjectedContextMessage(text: string): boolean {
  const head = text.trimStart();
  return INJECTED_CHIP_MARKERS.some((m) => head.startsWith(m));
}

/** First non-empty line, trimmed and capped at 60 chars. */
function firstLine(text: string): string | null {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ? line.slice(0, 60) : null;
}

/**
 * @param titleSource the user's own typed text (without chips); preferred when present.
 * @param messageText the full persisted message (may contain injected chips).
 */
export function deriveSessionTitle(
  titleSource: string | undefined,
  messageText: string,
): string | null {
  const source = (titleSource ?? '').trim();
  if (source) return firstLine(source);
  if (isInjectedContextMessage(messageText)) return null;
  return firstLine(messageText);
}
