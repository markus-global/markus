/**
 * Reopening a right-panel visit-history row.
 *
 * The history dropdown has two consumers — the embedded browser's address bar
 * and the panel chrome (file / deliverable previews, which have no address bar).
 * Both must reopen a row the same way, so the dispatch lives here, once, instead
 * of being copied into each consumer.
 */
import { api, type DeliverableInfo } from '../api.ts';
import type { RightPanelPayload } from '../contexts/LayoutContext.tsx';
import type { BrowserHistoryEntry } from './browserHistory.ts';

export type OpenPanel = (payload: RightPanelPayload) => void;
export type GetDeliverable = (id: string) => Promise<{ deliverable: DeliverableInfo }>;

/**
 * What actually happened. `skipped` is a real outcome, not a failure: a
 * deliverable row whose id no longer resolves (and that has no reference to fall
 * back to) has nothing to show, and the caller usually just closes the menu.
 */
export type ReopenOutcome = 'opened' | 'skipped';

export interface ReopenDeps {
  /** `openRightPanel` from the layout context. Absent outside a panel host. */
  openPanel: OpenPanel | null | undefined;
  /** Injectable for tests; defaults to the real API client. */
  getDeliverable?: GetDeliverable;
}

/**
 * Reopen one row by kind:
 *  - `url`  → the panel opens (or focuses) a browser tab at that address
 *  - `file` → the panel previews that path
 *  - `deliverable` → re-fetch the deliverable by id and preview the fresh record;
 *    when the id is stale (deleted, or a title-derived composite target) fall back
 *    to previewing the recorded `location` path.
 *
 * The deliverable is re-fetched rather than replayed from a stored snapshot so
 * the history never resurrects an outdated title / summary / reference.
 */
export async function reopenHistoryEntry(
  entry: BrowserHistoryEntry,
  deps: ReopenDeps,
): Promise<ReopenOutcome> {
  const { openPanel } = deps;
  if (!openPanel) return 'skipped';

  if (entry.kind === 'url') {
    openPanel({ kind: 'url', url: entry.target, title: entry.title });
    return 'opened';
  }

  if (entry.kind === 'file') {
    openPanel({ kind: 'file', path: entry.target, title: entry.title });
    return 'opened';
  }

  const getDeliverable = deps.getDeliverable ?? api.deliverables.get;
  try {
    const { deliverable } = await getDeliverable(entry.target);
    if (deliverable) {
      openPanel({ kind: 'deliverable', deliverable });
      return 'opened';
    }
  } catch {
    // Stale id (deleted deliverable / composite target) → fall through.
  }

  if (entry.location) {
    openPanel({ kind: 'file', path: entry.location, title: entry.title });
    return 'opened';
  }
  return 'skipped';
}
