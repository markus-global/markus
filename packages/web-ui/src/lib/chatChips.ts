/**
 * Chat context chips — the ONE vocabulary for "what this message is referring to".
 *
 * A chip used to be `{ label, content }` where the *type* only existed as an emoji
 * prefix inside `label` (📄 / ⌘ / 🌐 / “”). That is in-band signalling: the reader
 * (a human, or the bubble renderer) had to guess the kind back out of a display
 * string, and the guess silently drifted whenever a producer changed its prefix.
 *
 * Now the kind is a first-class field. `inferChipKind` exists only for chips that
 * were persisted before this change (and for third-party callers that still send
 * `{label, content}`): it reads the STRUCTURED block marker inside `content`
 * (`[deliverable]`, `[file]`, `[terminal-selection]`, …) first, and only falls
 * back to the legacy label prefix when no marker exists. Nothing ever parses the
 * kind back out of a label once `kind` is present.
 */

/** What a chip points at. Keep the set small — each kind needs an icon + a word. */
export type ChipKind =
  | 'task'
  | 'requirement'
  | 'deliverable'
  | 'file'
  | 'selection'
  | 'web'
  | 'terminal'
  | 'note';

export interface ChatChip {
  id: string;
  kind: ChipKind;
  /** Human-facing title shown in the pill (shortened by the producer). */
  label: string;
  /** Structured payload handed to the model — never shown verbatim in the composer. */
  content: string;
}

/**
 * A chip as it travelled with a sent message: which kind it was and where its
 * content sits inside the outgoing text. Offsets are what the bubble renderer
 * uses to re-highlight the chip — it never searches the text for the label.
 */
export interface SentChip {
  kind: ChipKind;
  label: string;
  /** Start of this chip's content inside the sent text. */
  offset: number;
  /** Length of this chip's content inside the sent text. */
  length: number;
}

export const CHIP_ICONS: Record<ChipKind, string> = {
  task: '✅',
  requirement: '📌',
  deliverable: '📦',
  file: '📄',
  selection: '📝',
  web: '🌐',
  terminal: '⌘',
  note: '💬',
};

/**
 * Order used when several kinds are offered in one list. Stable and explicit so
 * two pickers cannot present the same set in two different orders.
 */
export const CHIP_KINDS: ChipKind[] = [
  'task', 'requirement', 'deliverable', 'file', 'selection', 'web', 'terminal', 'note',
];

/** Structured markers written by the producers into `content`. Order matters. */
const CONTENT_MARKERS: Array<{ marker: string; kind: ChipKind }> = [
  { marker: '[deliverable]', kind: 'deliverable' },
  { marker: '[terminal-selection]', kind: 'terminal' },
  { marker: '[terminal-output]', kind: 'terminal' },
  { marker: '[html-selection]', kind: 'web' },
  { marker: '[file]', kind: 'file' },
  { marker: '[task]', kind: 'task' },
  { marker: '[requirement]', kind: 'requirement' },
  { marker: '[selection]', kind: 'selection' },
];

/** Legacy label prefixes, read once per chip that carries no `kind`. */
const LEGACY_PREFIXES: Array<{ prefix: string; kind: ChipKind }> = [
  { prefix: '📄', kind: 'file' },
  { prefix: '⌘', kind: 'terminal' },
  { prefix: '🌐', kind: 'web' },
  { prefix: '“', kind: 'selection' },
  { prefix: '📝', kind: 'selection' },
];

/**
 * Resolve the kind of a chip that arrived without one.
 *
 * Preference order: structured marker in `content` → legacy label prefix → 'note'.
 * The marker wins because it is the same fact the server-side payload carries;
 * the emoji is a display accident that producers changed freely.
 */
export function inferChipKind(content: string, label = ''): ChipKind {
  const body = content ?? '';
  for (const { marker, kind } of CONTENT_MARKERS) {
    if (body.includes(marker)) return kind;
  }
  const head = (label ?? '').trimStart();
  for (const { prefix, kind } of LEGACY_PREFIXES) {
    if (head.startsWith(prefix)) return kind;
  }
  return 'note';
}

/**
 * Normalise anything chip-shaped into a `ChatChip`.
 *
 * Backwards compatibility lives here and only here: a legacy `{label, content}`
 * is resolved once, then everything downstream uses `kind`. `id` is generated
 * when absent so the composer can address the chip by identity (delete / range).
 */
export function normalizeChip(
  raw: { id?: string; kind?: string; label?: string; content?: string } | null | undefined,
  makeId: () => string,
): ChatChip | null {
  if (!raw || typeof raw.content !== 'string' || raw.content.trim().length === 0) return null;
  const label = (typeof raw.label === 'string' ? raw.label : '').trim() || 'Context';
  const kind = isChipKind(raw.kind) ? raw.kind : inferChipKind(raw.content, label);
  return { id: raw.id || makeId(), kind, label, content: raw.content };
}

export function isChipKind(value: unknown): value is ChipKind {
  return typeof value === 'string' && (CHIP_KINDS as string[]).includes(value);
}

/** i18n key (inside the `team` namespace) holding the kind's display word. */
export function chipKindI18nKey(kind: ChipKind): string {
  return `chatChip.kind.${kind}`;
}

/**
 * Validate the sidecar that came back from the server (or from an older client).
 *
 * The wire is untrusted: a placement must have a known kind, a finite offset and
 * a positive length, otherwise it is dropped. A missing/empty result means "render
 * this message as plain text", which is exactly what old messages need.
 */
export function normalizeSentChips(raw: unknown): SentChip[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: SentChip[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const offset = Number(rec.offset);
    const length = Number(rec.length);
    if (!Number.isFinite(offset) || !Number.isFinite(length) || offset < 0 || length <= 0) continue;
    out.push({
      kind: isChipKind(rec.kind) ? rec.kind : inferChipKind('', typeof rec.label === 'string' ? rec.label : ''),
      label: typeof rec.label === 'string' ? rec.label : 'Context',
      offset,
      length,
    });
    if (out.length >= 50) break; // bounded: a message cannot carry more chips than a person sends
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Parse the JSON array that rides navigation (`chatChips` param / localStorage).
 * Malformed JSON or an empty payload yields `[]` — callers decide whether that is
 * worth telling the user about (the composer simply has nothing to add).
 */
export function parseNavChips(raw: string | null | undefined, makeId: () => string): ChatChip[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(item => normalizeChip(item as { id?: string; kind?: string; label?: string; content?: string }, makeId))
      .filter((c): c is ChatChip => c !== null);
  } catch {
    return [];
  }
}
