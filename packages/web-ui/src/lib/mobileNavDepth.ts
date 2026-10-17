import type { PageId } from '../routes.ts';

/**
 * Mobile navigation depth — "is this page showing a sub-page?"
 *
 * The mobile bottom nav belongs to TOP-LEVEL pages only. A page that drills into
 * a detail view (Team L2/L3, a task/requirement detail, a deliverable detail,
 * an artifact detail) declares depth > 0 and App stops rendering the nav for it.
 *
 * Depth is stored PER PAGE, not as a single "current owner" slot. A single slot
 * looks equivalent but is not: pages stay mounted while hidden, so a page that
 * keeps its detail open never re-runs its effect and would silently lose the
 * slot to whichever page declared last — the nav then reappeared on the detail
 * page it was supposed to be hidden on.
 */
export type MobileNavDepths = Readonly<Record<string, number>>;

const EMPTY: MobileNavDepths = Object.freeze({});

let snapshot: MobileNavDepths = EMPTY;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Declare the depth of `page`. 0 / clear removes the entry entirely. */
export function setMobileNavDepth(page: PageId, depth: number): void {
  const next = depth > 0 ? 1 : 0;
  if ((snapshot[page] ?? 0) === next) return;
  const draft: Record<string, number> = { ...snapshot };
  if (next > 0) draft[page] = next;
  else delete draft[page];
  snapshot = Object.freeze(draft);
  emit();
}

/** Read the depth declared by `page` (0 when it never declared one). */
export function mobileNavDepthOf(snapshotValue: MobileNavDepths, page: PageId): number {
  return snapshotValue[page] ?? 0;
}

export function subscribeMobileNavDepth(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function getMobileNavDepths(): MobileNavDepths {
  return snapshot;
}

/** Stable SSR/hydration snapshot (identity must never change between calls). */
export function getMobileNavDepthsServer(): MobileNavDepths {
  return EMPTY;
}
