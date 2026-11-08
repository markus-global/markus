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
  | 'project'
  | 'deliverable'
  | 'workflow'
  | 'agent'
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
  project: '📁',
  deliverable: '📦',
  workflow: '⚙',
  agent: '🤖',
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
  'task', 'requirement', 'project', 'deliverable', 'workflow', 'agent',
  'file', 'selection', 'web', 'terminal', 'note',
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
 * Strip a legacy in-band type marker from a chip label.
 *
 * The chip pill already renders `icon + type word + title` from `kind`. Older
 * producers additionally baked the icon (and sometimes the type word) INTO the
 * label — `[📦交付物] 标题`, `📄 notes.md`, `“quoted”` — so one chip showed two
 * icons and two type words. The type has exactly one carrier now (`kind`); this
 * function retires the old shape at the single boundary every chip passes
 * through, so queued drafts and nav payloads from older builds render clean too.
 *
 * Only a leading marker is removed, and only when it is recognisably a type
 * marker (starts with an emoji, or is one of the known type words). A title that
 * merely starts with a bracket word like `[WIP] …` is left alone.
 */
const TYPE_WORDS = new Set([
  '任务', '需求', '项目', '交付物', '产出物', '工作流', '智能体', '文件', '选区', '网页', '终端', '备注',
  'Task', 'Requirement', 'Project', 'Deliverable', 'Workflow', 'Agent', 'File', 'Selection', 'Web', 'Terminal', 'Note',
]);
const EMOJI_HEAD = /^[\p{Extended_Pictographic}\u2600-\u27BF\u2318\uFE0F]+/u;

export function stripChipLabelPrefix(label: string): string {
  const original = label;
  // Legacy selection chips quoted the whole label: “word word”.
  const quoted = /^[“"]\s*([\s\S]+?)\s*[”"]$/.exec(label);
  if (quoted && quoted[1]!.trim()) return quoted[1]!.trim();
  const bracket = /^\[([^\]]{1,16})\]\s+/.exec(label);
  if (bracket) {
    const inner = bracket[1]!.trim();
    const word = inner.replace(EMOJI_HEAD, '').trim();
    const hasIcon = word !== inner;
    if (hasIcon || TYPE_WORDS.has(word)) {
      const rest = label.slice(bracket[0].length).trim();
      if (rest) return rest;
    }
    return original;
  }
  // Bare symbol prefix (`📄 notes.md`, `⌘ ls -la`) — only when something follows it.
  const stripped = label.replace(/^\s*[\p{Extended_Pictographic}\u2600-\u27BF\u2318\uFE0F]+\s*/u, '').trim();
  return stripped || original;
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
  const rawLabel = (typeof raw.label === 'string' ? raw.label : '').trim() || 'Context';
  const kind = isChipKind(raw.kind) ? raw.kind : inferChipKind(raw.content, rawLabel);
  // Kind is resolved from the ORIGINAL label (legacy prefixes still carry
  // information when no structured marker exists), then the label is cleaned.
  return { id: raw.id || makeId(), kind, label: oneLineLabel(stripChipLabelPrefix(rawLabel)), content: raw.content };
}

export function isChipKind(value: unknown): value is ChipKind {
  return typeof value === 'string' && (CHIP_KINDS as string[]).includes(value);
}

/**
 * A chip label is **one line** — it is a pill, not a paragraph.
 *
 * Reported by the owner (2026-11-08): selecting several lines in the right-panel
 * terminal and hitting "send to chat" produced a chip whose label still carried
 * the newlines, so the token drawn inside the composer (`[⌘ …]`) wrapped across
 * lines and pulled the caret with it. The label is a DISPLAY string; the payload
 * (`content`) keeps every newline the user selected — collapsing happens only here.
 */
export function oneLineLabel(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
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
      label: oneLineLabel(stripChipLabelPrefix(typeof rec.label === 'string' ? rec.label : 'Context')),
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
