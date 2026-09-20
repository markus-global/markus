/**
 * chatScrollRestore — per-view scroll memory for the chat transcript.
 *
 * ── The problem this solves ──────────────────────────────────────────────────
 *
 * Every conversation (agent DM, team channel, human DM) and every session tab is
 * rendered into the SAME long-lived scroll container. Switching views therefore
 * used to inherit whatever `scrollTop` the previous view happened to leave
 * behind: land in a session you had never scrolled and find yourself in the
 * middle of it. Two things were missing:
 *
 *   1. no memory of where each view was left, and
 *   2. no re-assertion after a view's history arrives — rows are measured
 *      lazily, so a "scroll to the bottom once" write lands short of the real
 *      bottom as soon as the freshly mounted markdown rows turn out to be
 *      taller than their estimate.
 *
 * ── The contract ─────────────────────────────────────────────────────────────
 *
 *   • Leaving a view records where it was (see `captureChatScrollAnchor`).
 *   • Re-entering restores exactly that spot; a view with no record goes to the
 *     bottom, i.e. the newest output.
 *   • The record lives in a module-level Map — **process lifetime only**. A
 *     restart therefore has no records and every view opens at the bottom, which
 *     is exactly the product rule.
 *
 * ── Why a row anchor and not a raw `scrollTop` ───────────────────────────────
 *
 * A stored pixel offset is only meaningful against the layout it was measured
 * in. Row heights here are estimated until measured (code blocks, tables and
 * tool cards routinely land 2–3× off), so a raw offset drifts as the list
 * settles. An anchor of "this message id, scrolled this far past the viewport
 * top" is layout-independent: the caller re-derives the target from wherever
 * that row currently sits, so each retry pass converges instead of drifting.
 *
 * Kept DOM-light and side-effect-free (the one DOM helper takes an element) so
 * the whole contract is unit-testable; `Team.tsx` owns the refs, timers and
 * virtualizer plumbing.
 */
import { isAtBottom } from './chatScrollFollow.ts';

/** Where a view was left: glued to the bottom, or parked on a specific row. */
export type ScrollAnchor =
  | { kind: 'bottom' }
  | { kind: 'row'; id: string; delta: number };

/** A row's top edge, expressed as an offset inside the scroll content. */
export interface RowOffset {
  id: string;
  start: number;
}

/** The geometry we need from a scroll container (a DOM element satisfies it). */
export interface ScrollViewState {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * Memory key for one view. `convKey` alone is not enough: a single agent holds
 * several session tabs, and each one must remember its own position.
 */
export function scrollMemoryKey(convKey: string, sessionId: string | null | undefined): string {
  return `${convKey || '_'}::${sessionId ?? ''}`;
}

/**
 * The row sitting at the viewport top: the last row whose start is at or above
 * `scrollTop`. Falls back to the first rendered row when the viewport starts
 * above every row (can happen right after a prepend), and to `null` when nothing
 * is measurable.
 */
export function pickAnchorRow(rows: RowOffset[], scrollTop: number): RowOffset | null {
  let best: RowOffset | null = null;
  for (const row of rows) {
    if (row.start > scrollTop + 1) continue;
    if (!best || row.start > best.start) best = row;
  }
  return best ?? rows[0] ?? null;
}

/**
 * Snapshot a view. At (or near) the bottom the anchor is simply `bottom` — the
 * follow loop then owns the position and a later restore glues to the newest
 * output instead of freezing an offset that keeps growing while a reply streams.
 */
export function captureChatScrollAnchor(rows: RowOffset[], view: ScrollViewState): ScrollAnchor {
  if (isAtBottom(view)) return { kind: 'bottom' };
  const row = pickAnchorRow(rows, view.scrollTop);
  if (!row) return { kind: 'bottom' };
  return { kind: 'row', id: row.id, delta: view.scrollTop - row.start };
}

/**
 * How much to move `scrollTop` by so the anchored row ends up exactly `delta`
 * px above the viewport top again.
 *
 * `rowTopInViewport` is the row's current distance from the container's top
 * edge (negative once its top has scrolled past). Because both capture and
 * restore express the anchor the same way, the correction is a plain delta and
 * repeated passes drive the error to zero.
 */
export function rowCorrection(rowTopInViewport: number, delta: number): number {
  return rowTopInViewport + delta;
}

/** Rows currently mounted in the container, in content order. */
export function readRenderedRowOffsets(el: HTMLElement): RowOffset[] {
  const containerTop = el.getBoundingClientRect().top;
  const scrollTop = el.scrollTop;
  const rows: RowOffset[] = [];
  for (const node of Array.from(el.querySelectorAll<HTMLElement>('[data-index]'))) {
    const labelled = node.querySelector<HTMLElement>('[id^="msg-"]');
    const id = labelled?.id?.slice('msg-'.length);
    if (!id) continue;
    rows.push({ id, start: scrollTop + (node.getBoundingClientRect().top - containerTop) });
  }
  rows.sort((a, b) => a.start - b.start);
  return rows;
}

/**
 * The anchored message's current distance from the container's top edge, or
 * `null` while it is not mounted (virtualized away — the caller should jump
 * approximately first, then correct on a later pass).
 */
export function findRowTopInViewport(el: HTMLElement, id: string): number | null {
  const containerTop = el.getBoundingClientRect().top;
  const wanted = `msg-${id}`;
  for (const node of Array.from(el.querySelectorAll<HTMLElement>('[id^="msg-"]'))) {
    if (node.id === wanted) return node.getBoundingClientRect().top - containerTop;
  }
  return null;
}

/**
 * In-memory (process lifetime) store of per-view scroll anchors.
 *
 * Bounded and least-recently-used: a long session visits hundreds of views and
 * this must not grow without limit. Eviction is invisible to the user (an
 * evicted view simply opens at the bottom, like after a restart).
 */
export class ChatScrollMemory {
  private readonly entries = new Map<string, ScrollAnchor>();

  constructor(private readonly capacity = 120) {}

  save(key: string, anchor: ScrollAnchor): void {
    if (!key) return;
    // Re-insert so the Map's iteration order stays least→most recently used.
    this.entries.delete(key);
    this.entries.set(key, anchor);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  get(key: string): ScrollAnchor | null {
    if (!key) return null;
    const anchor = this.entries.get(key);
    if (!anchor) return null;
    // Touch: a view you just looked at is the least likely one to be evicted.
    this.entries.delete(key);
    this.entries.set(key, anchor);
    return anchor;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Process-lifetime default store (see the header: a restart starts at bottom). */
export const chatScrollMemory = new ChatScrollMemory();

/**
 * How long a pending restore intent stays worth honouring. Long enough to
 * outlive a slow transcript round-trip, short enough that an intent nobody could
 * satisfy (a failed load) cannot hijack a later repaint of the same view.
 */
export const RESTORE_INTENT_TTL_MS = 10_000;

export function isRestoreIntentStale(at: number, now: number): boolean {
  return now - at > RESTORE_INTENT_TTL_MS;
}
