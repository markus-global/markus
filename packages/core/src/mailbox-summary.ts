/**
 * Mailbox item summaries — an *explicitly lossy* display excerpt of a message.
 *
 * ## Why this module exists (2026-10-22 incident)
 *
 * Every mailbox item carries two fields: `content` (the authoritative message)
 * and `summary` (what the attention section, handoff log and queue listings
 * show). `summary` used to be `content.slice(0, 100)` — a *silent* prefix copy
 * that sat right next to the truth, in the same shape, with no marker.
 *
 * That is the worst combination for a reader: a 100-char prefix of a real
 * message is indistinguishable from a genuinely short message. In the incident
 * the owner sent a 383-char message (a terminal-selection chip plus
 * 「已经合并了。创建一个新的rc版本吧。」); a downstream reader consumed the
 * 100-char copy — which ended exactly on the chip's opening `"""` fence — and
 * concluded "the message is empty". The agent then answered a question it had
 * never actually read.
 *
 * The fix is NOT a longer slice (a different length reproduces the bug with a
 * different number). The fix is to make truncation *self-evident*:
 *
 *   1. collapse to a single line, so a multi-line payload (chips, pasted logs,
 *      structured selections) can never masquerade as "the whole message" via
 *      its first few lines;
 *   2. when anything was dropped, append an explicit marker carrying how much —
 *      a reader that sees the marker knows to fetch `content`.
 *
 * Invariant (tested): `summarizeForMailbox(x)` is either byte-identical to a
 * single-line `x` (nothing was dropped) or visibly marked as lossy. There is no
 * third state, so "reads like a complete message but is not" cannot be
 * expressed.
 */

/** Marker placed at the end of an excerpt that dropped characters. */
const OMITTED_TEMPLATE = (omitted: number) => ` …[+${omitted} chars omitted]`;

/** Collapse any run of whitespace (including newlines) into a single space. */
function toSingleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Build the display excerpt for a mailbox item.
 *
 * @param content Authoritative message body.
 * @param max     Maximum characters of body to keep (default 100, matching the
 *                previous behaviour's budget). The marker is *not* counted
 *                against it — the point is readability, not an exact ceiling.
 */
export function summarizeForMailbox(content: string, max = 100): string {
  const single = toSingleLine(content ?? '');
  if (single.length <= max) return single;
  const head = single.slice(0, max).trimEnd();
  // Count what a reader cannot see. Measured in characters of the collapsed
  // body; the whitespace we collapsed is already unrecoverable from here, so we
  // only count characters present in `single`.
  const omitted = single.length - head.length;
  return `${head}${OMITTED_TEMPLATE(omitted)}`;
}

/** True when an excerpt carries the truncation marker (i.e. is lossy). */
export function isLossySummary(summary: string): boolean {
  return /…\[\+\d+ chars omitted\]$/.test(summary ?? '');
}
