import type { PageId } from '../routes.ts';

/**
 * Mobile navigation depth — "is the active page showing a sub-page?"
 *
 * The mobile bottom nav belongs to TOP-LEVEL pages only. A page that drills into
 * a detail view (Team L2/L3, a task/requirement detail, a deliverable detail,
 * an artifact detail) hides it so the detail view gets the full screen.
 *
 * One fact, one writer: a page declares its own depth; `App` renders the nav.
 * The declaration is scoped by owner page so a stale `1` left behind by a page
 * you just left can never hide the nav on the page you are on now.
 */
export interface MobileNavDepth {
  owner: PageId | null;
  depth: number;
}

const TOP: MobileNavDepth = { owner: null, depth: 0 };

let snapshot: MobileNavDepth = TOP;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Declare the current depth of `page`. 0 = top level, >0 = sub-page. */
export function setMobileNavDepth(page: PageId, depth: number): void {
  const next = depth > 0 ? 1 : 0;
  if (snapshot.owner === page && snapshot.depth === next) return;
  snapshot = { owner: page, depth: next };
  emit();
}

/** Retract `page`'s declaration (page unmounted / went back to top level). */
export function clearMobileNavDepth(page: PageId): void {
  if (snapshot.owner !== page) return;
  snapshot = TOP;
  emit();
}

export function subscribeMobileNavDepth(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function getMobileNavDepth(): MobileNavDepth {
  return snapshot;
}

/** Stable SSR/hydration snapshot (identity must never change between calls). */
export function getMobileNavDepthServer(): MobileNavDepth {
  return TOP;
}
