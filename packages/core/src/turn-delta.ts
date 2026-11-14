import {
  isAuthoritativeIntent,
  routeMailboxItem,
  type MailboxIntent,
  type MailboxItemMetadata,
  type MailboxItemType,
  type MailboxPayload,
  type LLMMessage,
} from '@markus/shared';

/**
 * In-turn delta injection (C8-B) — the *content* half of "a contradicting fact
 * lands inside the turn that is already running".
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * A turn is a long computation; the world can change while it runs. Queueing a
 * cancel behind the turn is a *scheduling* statement ("you will get your turn")
 * that silently became a *correctness* statement ("your premise is still true").
 * See `docs/records/cut8-b-turn-delta-injection-2026-11-14.md` §2.
 *
 * WHAT THIS MODULE IS NOT
 * -----------------------
 * It does not decide **whether** an item belongs to the running turn. That is
 * `work_unit_ref` equality, answered upstream by the query (C8-A: the entity,
 * not the route). Two places answering "is this mine" would be exactly the R1
 * this cut removes — so a row that reaches here is already same-entity.
 *
 * Everything below is a **pure function of its input**: no clock, no counter, no
 * randomness. That is not a style preference — criterion 3 of the card is
 * "same logical input ⇒ one byte sequence", and one `Date.now()` in the header
 * would break prompt caching without any test noticing (only `hitRate`, which is
 * noise, would move).
 */

export type TurnDeltaClass = 'contradiction' | 'authoritative' | 'decision';

/** At most this many facts are rendered as item lines; the rest become "+N more". */
export const TURN_DELTA_MAX_ITEMS = 3;
/** Hard ceiling for the whole segment (card: ≤600 characters). */
export const TURN_DELTA_MAX_CHARS = 600;
/** Per-line label cap, so one long summary cannot eat the whole budget. */
export const TURN_DELTA_MAX_LABEL_CHARS = 120;
/**
 * The one place the segment header is spelled. Callers and tests compare against
 * this constant instead of re-typing the template.
 */
export const TURN_DELTA_HEADER_PREFIX = '[LIVE UPDATE @seq=';

/**
 * The minimal shape this module needs. Structural fields only — `payload` is
 * read for the human label, never to infer structure (R3).
 */
export interface TurnDeltaRow {
  id: string;
  sourceType: MailboxItemType;
  /** Insertion ordinal assigned by `AgentMailbox` (never a clock). */
  seq: number;
  workUnitRef?: string | null;
  payload: MailboxPayload;
  metadata?: MailboxItemMetadata;
  envelope?: {
    intent?: MailboxIntent;
    /** Ids of the facts this one replaces (a correction chain). */
    supersedes?: string[] | null;
    /** This fact overturns a premise the receiver may be acting on. */
    invalidatesPremise?: boolean;
  };
}

export interface TurnDeltaEntry extends TurnDeltaRow {
  deltaClass: TurnDeltaClass;
  supersedes: string[];
  label: string;
}

export interface TurnDeltaSegment {
  snapshotSeq: number;
  /** The exact bytes appended to the session (stable template + trailing values). */
  text: string;
  /** Entries actually rendered, ordered by `seq`. */
  entries: TurnDeltaEntry[];
  /** Qualifying facts left out of `entries` (rendered as one "+N more" line). */
  omitted: number;
  decision: 'continue' | 'cancel';
  /** The contradiction that overturned the premise, when `decision === 'cancel'`. */
  decisive: TurnDeltaEntry | null;
}

function supersedesOf(row: TurnDeltaRow): string[] {
  const raw = row.envelope?.supersedes;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

function labelOf(row: TurnDeltaRow): string {
  const raw = typeof row.payload?.summary === 'string' && row.payload.summary.trim()
    ? row.payload.summary
    : row.id;
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > TURN_DELTA_MAX_LABEL_CHARS
    ? `${oneLine.slice(0, TURN_DELTA_MAX_LABEL_CHARS - 1)}…`
    : oneLine;
}

/**
 * Classify one same-entity row into the three classes the card allows, or
 * `null` for "queue only, never in-turn".
 *
 * Order matters: a contradiction outranks an authoritative instruction (a
 * cancelled task is not an instruction to keep going).
 *
 * `defer` is deliberately absent from the result domain: "belongs to something
 * else" is answered by the entity filter before this module runs. Adding a
 * `defer` branch here would be a second place answering "is this mine".
 */
export function classifyTurnDelta(row: TurnDeltaRow): TurnDeltaClass | null {
  const env = row.envelope;
  if (env?.invalidatesPremise === true || supersedesOf(row).length > 0) return 'contradiction';
  if (isAuthoritativeIntent(env?.intent)) return 'authoritative';

  // "A new decision about the same entity" — read from the registry's one
  // signal-class mapper, not from a hand-written type list. `record` /
  // `governance_event` are the formal state-machine classes; `system`, `chat`,
  // `a2a`, `callback` are not decisions the running turn must re-read.
  const signalClass = routeMailboxItem({
    sourceType: row.sourceType,
    payload: row.payload,
    metadata: row.metadata,
    ...(env?.intent ? { envelope: { intent: env.intent } } : {}),
  }).signalClass;
  if (signalClass === 'record' || signalClass === 'governance_event') return 'decision';
  return null;
}

function formatEntryLine(entry: TurnDeltaEntry): string {
  const head = `- ${entry.deltaClass}/${entry.sourceType}: ${entry.label} (item ${entry.id})`;
  return entry.supersedes.length > 0
    ? `${head} supersedes: ${entry.supersedes.join(', ')}`
    : head;
}

/**
 * Build the tail-appended segment.
 *
 * Shape (the whole point: variable values are at the END of a stable template):
 *
 * ```
 * [LIVE UPDATE @seq=<snapshot>]
 * count: <n>
 * - <class>/<sourceType>: <label> (item <id>)[ supersedes: a, b]
 * ...
 * - (+N more — call check_mailbox to list them)
 * ```
 *
 * When nothing qualifies the segment is **still emitted** (`count: 0` +
 * `none`). Omitting it would make the message array's shape depend on the data,
 * so two logically identical inputs would serialise differently — the defect
 * criterion 3 exists to catch.
 */
export function buildTurnDeltaSegment(input: {
  snapshotSeq: number;
  rows: readonly TurnDeltaRow[];
}): TurnDeltaSegment {
  const classified: TurnDeltaEntry[] = [];
  for (const row of input.rows) {
    const deltaClass = classifyTurnDelta(row);
    if (!deltaClass) continue;
    classified.push({ ...row, deltaClass, supersedes: supersedesOf(row), label: labelOf(row) });
  }
  classified.sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));

  const header = `${TURN_DELTA_HEADER_PREFIX}${input.snapshotSeq}]`;
  const countLine = `count: ${classified.length}`;
  const entries: TurnDeltaEntry[] = [];
  const body: string[] = [];
  // Reserve room for a possible "+N more" line before accepting another item.
  const omittedReserve = 64;

  for (const entry of classified) {
    if (entries.length >= TURN_DELTA_MAX_ITEMS) break;
    const line = formatEntryLine(entry);
    const wouldBe = [header, countLine, ...body, line].join('\n');
    if (wouldBe.length + omittedReserve > TURN_DELTA_MAX_CHARS) break;
    body.push(line);
    entries.push(entry);
  }

  const omitted = classified.length - entries.length;
  const lines = [header, countLine, ...body];
  if (entries.length === 0) {
    lines.push('none');
  } else if (omitted > 0) {
    lines.push(`- (+${omitted} more — call check_mailbox to list them)`);
  }

  let text = lines.join('\n');
  if (text.length > TURN_DELTA_MAX_CHARS) text = text.slice(0, TURN_DELTA_MAX_CHARS);

  // The decision must be read from **all** qualifying facts, not only the
  // rendered ones: a cancel sitting at position 5 is not less of a cancel
  // because the segment only prints three lines.
  const decisive = classified.find(e => e.deltaClass === 'contradiction') ?? null;
  return {
    snapshotSeq: input.snapshotSeq,
    text,
    entries,
    omitted,
    decision: decisive ? 'cancel' : 'continue',
    decisive,
  };
}

/** The session message this segment is appended as. Tail append by construction. */
export function turnDeltaMessage(segment: TurnDeltaSegment): LLMMessage {
  return { role: 'user', content: segment.text };
}
