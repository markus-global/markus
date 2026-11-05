/**
 * Composer chip model — an INTERVAL model, not a string-matching model.
 *
 * A chip has to be able to live anywhere in the message body, be deleted as a
 * whole, and still leave the text the model receives as plain prose. The naive
 * implementation (a separate chip array rendered above the textarea, joined into
 * a prefix on send) cannot express a chip in the middle; the other naive one
 * (`text.includes(label)` on send) is worse — it silently re-binds to any text
 * the user happens to type that matches the label.
 *
 * So a chip owns an explicit `[start, end)` range over `text`, and every edit is
 * resolved by diffing exactly one edit region (the only thing a textarea change
 * can produce). Rules:
 *
 *  1. `text` is what the textarea shows — the chip's visible token is part of it.
 *  2. Ranges are authoritative. Nothing ever parses a chip back out of `text`.
 *  3. An edit that touches any part of a range removes the WHOLE chip — this is
 *     what makes backspace "eat the chip" instead of leaving half a token behind.
 *     It also means typing *inside* a chip token discards the chip (honest: the
 *     chip's content is a block, a one-character edit inside it has no meaning).
 *  4. Sending replaces each range with the chip's `content` and reports the new
 *     offsets as the sidecar — the server/model path is unchanged (plain text),
 *     while the bubble can still highlight the chip.
 */

import { CHIP_ICONS, type ChatChip, type SentChip, type ChipKind } from './chatChips.ts';

/** A chip placed inside the composer text: `[start, end)` indexes into `text`. */
export interface DraftChip extends ChatChip {
  start: number;
  end: number;
}

export interface ChipDraft {
  text: string;
  chips: DraftChip[];
}

export interface SerializedDraft {
  /** What the model receives: chip tokens replaced by their content, in place. */
  text: string;
  /** The user's own words with every chip removed — the session-title source. */
  titleSource: string;
  /** Where each chip ended up inside `text`, for the sent-bubble renderer. */
  chips: SentChip[];
}

export function emptyDraft(): ChipDraft {
  return { text: '', chips: [] };
}

/** The token a chip renders as inside the textarea. Display only — never parsed. */
export function chipDisplayText(chip: Pick<DraftChip, 'kind' | 'label'>): string {
  return `[${CHIP_ICONS[chip.kind]} ${chip.label}]`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/** Sort + clamp ranges so callers can assume ascending, non-overlapping chips. */
function tidy(text: string, chips: DraftChip[]): DraftChip[] {
  const sorted = [...chips]
    .map(c => {
      const start = clamp(c.start, 0, text.length);
      const end = clamp(c.end, start, text.length);
      return { ...c, start, end };
    })
    .filter(c => c.end > c.start)
    .sort((a, b) => a.start - b.start);
  // Drop overlaps defensively: a range model that can hold two chips on the same
  // characters cannot be serialised deterministically.
  const out: DraftChip[] = [];
  for (const c of sorted) {
    const prev = out[out.length - 1];
    if (prev && c.start < prev.end) continue;
    out.push(c);
  }
  return out;
}

/**
 * Insert a chip at `at` (the caret). Returns the new draft AND the caret position
 * the textarea should be left at (right after the inserted token + one space).
 */
export function insertChip(
  draft: ChipDraft,
  chip: ChatChip,
  at: number,
): { draft: ChipDraft; caret: number } {
  const pos = clamp(at, 0, draft.text.length);
  // A caret INSIDE an existing chip's token cannot be honoured: the token is one
  // indivisible pill, so there is no meaningful place to put a second one. Invariant
  // 3 says an edit touching a range removes the whole chip — this path used to shift
  // only chips with `start >= pos`, leaving the straddled chip's range stale, which
  // serialised into a corrupted payload (`[file] a.ts] a.ts]`). Remove first, then
  // insert at the collapsed position; same rule as `reconcileEdit`.
  const straddled = draft.chips.find(c => pos > c.start && pos < c.end);
  if (straddled) {
    const cleaned = removeChip(draft, straddled.id);
    return insertChip(cleaned.draft, chip, cleaned.caret);
  }
  const token = `${chipDisplayText(chip)}`;
  // Spaces are added only where the token would otherwise glue to a word — the
  // composer must not turn "hello world" into "hello [chip]  world" (double gap).
  const lead = pos > 0 && !/\s/.test(draft.text[pos - 1] ?? '') ? ' ' : '';
  const next = draft.text[pos];
  const trail = pos >= draft.text.length || (next !== undefined && !/\s/.test(next)) ? ' ' : '';
  const inserted = `${lead}${token}${trail}`;
  const text = draft.text.slice(0, pos) + inserted + draft.text.slice(pos);
  const tokenStart = pos + lead.length;
  const shifted = draft.chips.map(c => (c.start >= pos
    ? { ...c, start: c.start + inserted.length, end: c.end + inserted.length }
    : c));
  shifted.push({ ...chip, start: tokenStart, end: tokenStart + token.length });
  return { draft: { text, chips: tidy(text, shifted) }, caret: pos + inserted.length };
}

/** Remove one chip (and its token) by id. */
export function removeChip(draft: ChipDraft, id: string): { draft: ChipDraft; caret: number } {
  const target = draft.chips.find(c => c.id === id);
  if (!target) return { draft, caret: draft.text.length };
  const removed = target.end - target.start;
  const text = draft.text.slice(0, target.start) + draft.text.slice(target.end);
  const chips = draft.chips
    .filter(c => c.id !== id)
    .map(c => (c.start >= target.end ? { ...c, start: c.start - removed, end: c.end - removed } : c));
  return { draft: { text, chips: tidy(text, chips) }, caret: target.start };
}

/** Remove the chip that contains `index`, if any (used by the delete key paths). */
export function removeChipAt(draft: ChipDraft, index: number): { draft: ChipDraft; caret: number } | null {
  const hit = draft.chips.find(c => index >= c.start && index < c.end);
  return hit ? removeChip(draft, hit.id) : null;
}

function commonPrefixLen(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

function commonSuffixLen(a: string, b: string, limit: number): number {
  let i = 0;
  while (i < limit && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

/**
 * Resolve a textarea change against the chip ranges.
 *
 * Every `onChange` is one contiguous replacement: `old[p, old.length - s)` became
 * `new[p, new.length - s)`. Chips fully before that region keep their ranges;
 * chips at/after it shift by the length delta; chips that intersect it are gone
 * — including the "one character deleted from inside a chip" case, which is the
 * whole-token-backspace behaviour.
 */
export function reconcileEdit(prev: ChipDraft, nextText: string): ChipDraft {
  if (nextText === prev.text) return prev;
  const old = prev.text;
  const p = commonPrefixLen(old, nextText);
  const suffixLimit = Math.min(old.length - p, nextText.length - p);
  const s = commonSuffixLen(old, nextText, suffixLimit);
  const removedStart = p;
  const removedEnd = old.length - s;
  const insertedLen = nextText.length - p - s;
  const delta = insertedLen - (removedEnd - removedStart);
  const chips: DraftChip[] = [];
  for (const c of prev.chips) {
    const intersects = c.start < removedEnd && c.end > removedStart;
    if (intersects) continue;
    if (c.start >= removedEnd) chips.push({ ...c, start: c.start + delta, end: c.end + delta });
    else chips.push(c);
  }
  return { text: nextText, chips: tidy(nextText, chips) };
}

/**
 * Build the outgoing payload.
 *
 * `text` keeps the user's prose and substitutes each chip's structured content
 * where the chip sits — same information as the old "prefix all chips" behaviour,
 * but at the position the user chose. `titleSource` drops chips entirely so the
 * server can derive a clean session title (this is what killed titles like
 * `[terminal-selection] Terminal: …`). `chips` carries offsets for the bubble.
 */
export function serializeDraft(draft: ChipDraft): SerializedDraft {
  const chips = tidy(draft.text, draft.chips);
  let text = '';
  let titleSource = '';
  let cursor = 0;
  const sent: SentChip[] = [];
  for (const c of chips) {
    const plain = draft.text.slice(cursor, c.start);
    titleSource += plain;
    sent.push({ kind: c.kind, label: c.label, offset: text.length + plain.length, length: c.content.length });
    text += plain + c.content;
    cursor = c.end;
  }
  const tail = draft.text.slice(cursor);
  titleSource += tail;
  text += tail;
  return {
    text,
    titleSource: titleSource.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim(),
    chips: sent,
  };
}

/**
 * Trim a draft without lying about where the chips are.
 *
 * `send()` has always normalised the body (leading/trailing whitespace is not part
 * of what the user meant to say). Once chips carry offsets, that normalisation is
 * a *range* transformation, not a string operation: every chip shifts left by the
 * leading whitespace, and a chip whose range only partially survives the trim is
 * dropped — half a pill highlights the wrong span, which is worse than none.
 */
export function trimDraft(draft: ChipDraft): ChipDraft {
  const text = draft.text;
  const start = text.length - text.trimStart().length;
  const end = text.trimEnd().length;
  if (start === 0 && end === text.length) return draft;
  const trimmed = text.slice(start, end);
  const chips = draft.chips.flatMap(c => {
    const s = c.start - start;
    const e = c.end - start;
    if (s < 0 || e > trimmed.length) return [];
    return [{ ...c, start: s, end: e }];
  });
  return { text: trimmed, chips: tidy(trimmed, chips) };
}

/**
 * The ONE function `useChatStream.send()` calls.
 *
 * Order matters and this is the whole point of the function: normalise FIRST, then
 * serialise, so the sidecar offsets describe the text that actually goes on the
 * wire. Computing them against the raw draft and trimming afterwards shifts every
 * offset by the amount of leading whitespace — in bounds it renders the wrong pill
 * title, out of bounds the placement is dropped server-side and the bubble dumps
 * the raw `[file] Path: …` payload. Keeping the two steps in one function makes
 * that ordering impossible to get wrong at the call site.
 *
 * The returned `text` is already normalised, so callers must NOT trim it again
 * (a second trim would re-open the same gap for content that happens to end in
 * whitespace).
 */
export function serializeDraftForSend(draft: ChipDraft): SerializedDraft {
  return serializeDraft(trimDraft(draft));
}

/**
 * Split a SENT message back into prose + chips for rendering.
 *
 * Offsets come from the stored sidecar; a chip whose offsets do not fit the text
 * (older/foreign payload, clipped content) is dropped rather than guessed at, and
 * the caller falls back to rendering the message as plain text.
 */
export type ChipSegment =
  | { type: 'text'; text: string }
  | { type: 'chip'; chip: SentChip };

export function chipSegments(text: string, chips: SentChip[] | undefined): ChipSegment[] | null {
  if (!chips || chips.length === 0) return null;
  const ordered = [...chips]
    .filter(c => Number.isFinite(c.offset) && Number.isFinite(c.length) && c.length > 0)
    .sort((a, b) => a.offset - b.offset);
  const out: ChipSegment[] = [];
  let cursor = 0;
  for (const chip of ordered) {
    if (chip.offset < cursor || chip.offset + chip.length > text.length) return null;
    if (chip.offset > cursor) out.push({ type: 'text', text: text.slice(cursor, chip.offset) });
    out.push({ type: 'chip', chip });
    cursor = chip.offset + chip.length;
  }
  if (cursor < text.length) out.push({ type: 'text', text: text.slice(cursor) });
  return out;
}

/**
 * Convert a list of "appended at the end" chips (right panel / navigation) into a
 * draft over the current text. Chips are appended in order, one per line, which
 * is where the old chip row effectively put them.
 */
export function appendChips(draft: ChipDraft, chips: ChatChip[]): { draft: ChipDraft; caret: number } {
  let next = draft;
  let caret = next.text.length;
  for (const chip of chips) {
    // One chip per line: the old chip row appended visually, so appended chips
    // stay readable instead of gluing onto the end of a sentence.
    const needsNewline = next.text.length > 0 && !next.text.endsWith('\n');
    if (needsNewline) next = { text: `${next.text}\n`, chips: next.chips };
    const res = insertChip(next, chip, next.text.length);
    next = res.draft;
    caret = res.caret;
  }
  return { draft: next, caret };
}

/** Kind list helper for UI code that only needs the icon. */
export function chipIcon(kind: ChipKind): string {
  return CHIP_ICONS[kind];
}
