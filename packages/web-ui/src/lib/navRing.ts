/**
 * The horizontal swipe ring — ONE ordered list of top-level destinations.
 *
 * Owner's model (2026-10-17): a thumb-driven ring that walks the app on a single
 * axis, so no view is a dead end and no gesture has two meanings at page level.
 *
 *   overview → team L1 → approvals → notifications
 *            → tasks/backlog → tasks/kanban → tasks/dag → tasks/workflows
 *            → deliverables → (back to overview)
 *
 * Swipe RIGHT advances one step, swipe LEFT steps back; both wrap. Nested
 * horizontal gestures (chat session tabs, detail tabs, store tabs, deliverables
 * groups) opt out by putting `data-swipe-owner` on their container — inner
 * gestures win, and only that container is excused.
 *
 * Why a module and not per-page handlers: one definition means the ring cannot
 * drift out of sync with itself, and "where am I" + "where do I go next" are
 * answered by the same pure functions (see navRing.test.ts).
 */
import { useEffect, useRef } from 'react';
import { PAGE, type PageId } from '../routes.ts';

/** Sub-view inside a page that owns more than one ring step. */
export type RingSub =
  | 'l1'
  | 'approvals'
  | 'notifications'
  | 'backlog'
  | 'kanban'
  | 'dag'
  | 'workflows';

export interface RingStep {
  id: string;
  page: PageId;
  sub?: RingSub;
}

export const NAV_RING: readonly RingStep[] = [
  { id: 'overview', page: PAGE.HOME },
  { id: 'team-l1', page: PAGE.TEAM, sub: 'l1' },
  { id: 'approvals', page: PAGE.NOTIFICATIONS, sub: 'approvals' },
  { id: 'notifications', page: PAGE.NOTIFICATIONS, sub: 'notifications' },
  { id: 'tasks-backlog', page: PAGE.WORK, sub: 'backlog' },
  { id: 'tasks-kanban', page: PAGE.WORK, sub: 'kanban' },
  { id: 'tasks-dag', page: PAGE.WORK, sub: 'dag' },
  { id: 'tasks-workflows', page: PAGE.WORK, sub: 'workflows' },
  { id: 'deliverables', page: PAGE.DELIVERABLES },
];

/** Minimum horizontal travel for a swipe to count. Matches useSwipeTabs. */
export const RING_SWIPE_THRESHOLD_PX = 50;
/** Reject gestures that are more vertical than this. Matches useSwipeTabs. */
export const RING_SWIPE_ANGLE_LIMIT_DEG = 30;

// ── Live sub-view registry ──────────────────────────────────────────────────
// Pages stay mounted, so the ring cannot read their sub-state from the URL. Each
// owner publishes what it is showing; the ring reads it at gesture time.
const subs = new Map<PageId, RingSub>();

export function publishRingSub(page: PageId, sub: RingSub): void {
  subs.set(page, sub);
}

export function currentRingSub(page: PageId): RingSub | undefined {
  return subs.get(page);
}

/**
 * Where the current location sits on the ring, or -1 when the page is not on it
 * (settings, search, store, builder — swiping there must do nothing rather than
 * teleport the user somewhere unexpected).
 */
export function ringIndex(page: PageId, sub?: RingSub): number {
  const exact = NAV_RING.findIndex(s => s.page === page && s.sub === sub);
  if (exact !== -1) return exact;
  // A page with several steps that has not published a sub-view (or published a
  // stale one) resolves to its first step, so the gesture stays predictable.
  return NAV_RING.findIndex(s => s.page === page);
}

/** Neighbouring step, wrapping at both ends. null when the page is off-ring. */
export function ringStep(page: PageId, sub: RingSub | undefined, delta: 1 | -1): RingStep | null {
  const idx = ringIndex(page, sub);
  if (idx === -1) return null;
  const next = (idx + delta + NAV_RING.length) % NAV_RING.length;
  return NAV_RING[next] ?? null;
}

/** Finger moves right (+1, forward) or left (-1, back). */
export function ringDelta(dx: number, dy: number): 1 | -1 | 0 {
  if (Math.abs(dx) < RING_SWIPE_THRESHOLD_PX) return 0;
  const angle = (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI;
  if (angle > RING_SWIPE_ANGLE_LIMIT_DEG) return 0;
  return dx > 0 ? 1 : -1;
}

// ── Sub-view commands ───────────────────────────────────────────────────────
const RING_SUB_EVENT = 'markus:ring-sub';

/** Ask a page to show a specific sub-view (e.g. the tasks page → kanban). */
export function requestRingSub(page: PageId, sub: RingSub): void {
  publishRingSub(page, sub);
  window.dispatchEvent(new CustomEvent(RING_SUB_EVENT, { detail: { page, sub } }));
}

export function onRingSubRequest(cb: (page: PageId, sub: RingSub) => void): () => void {
  const h = (e: Event) => {
    const d = (e as CustomEvent<{ page: PageId; sub: RingSub }>).detail;
    if (d) cb(d.page, d.sub);
  };
  window.addEventListener(RING_SUB_EVENT, h);
  return () => window.removeEventListener(RING_SUB_EVENT, h);
}

// ── Gesture entry point ─────────────────────────────────────────────────────

/**
 * True when this gesture belongs to something else: a container that declares
 * itself the owner of horizontal gestures, or any open dialog/sheet (a modal is
 * a different context — stepping the page behind it would be surprising).
 */
export function ringShouldIgnore(target: EventTarget | null): boolean {
  const el = target as Element | null;
  if (el && typeof el.closest === 'function' && el.closest('[data-swipe-owner]')) return true;
  const overlays = document.querySelectorAll('[role="dialog"], [aria-modal="true"]');
  for (const node of overlays) {
    const r = (node as HTMLElement).getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return true;
  }
  return false;
}

export function useNavRingSwipe(opts: { enabled: boolean; onStep: (delta: 1 | -1) => void }): void {
  const start = useRef<{ x: number; y: number } | null>(null);
  const onStepRef = useRef(opts.onStep);
  onStepRef.current = opts.onStep;

  useEffect(() => {
    if (!opts.enabled) return undefined;
    const onStart = (e: TouchEvent) => {
      if (ringShouldIgnore(e.target)) { start.current = null; return; }
      const t = e.touches[0];
      start.current = t ? { x: t.clientX, y: t.clientY } : null;
    };
    const onEnd = (e: TouchEvent) => {
      const s = start.current;
      start.current = null;
      if (!s) return;
      const t = e.changedTouches[0];
      if (!t) return;
      const delta = ringDelta(t.clientX - s.x, t.clientY - s.y);
      if (delta !== 0) onStepRef.current(delta);
    };
    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchend', onEnd);
    };
  }, [opts.enabled]);
}
