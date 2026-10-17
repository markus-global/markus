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

// ── Live sub-view sources ───────────────────────────────────────────────────
// The ring must not cache what a page is showing: the page owns that fact, and a
// cached copy goes stale the moment the sub-view changes by any other path (a tap,
// a restore, a deep link) — the ring would then skip a step. Each owner registers
// a GETTER; the ring asks at gesture time and always gets the truth.
const subSources = new Map<PageId, () => RingSub | undefined>();

export function registerRingSubSource(page: PageId, getter: () => RingSub | undefined): () => void {
  subSources.set(page, getter);
  return () => {
    if (subSources.get(page) === getter) subSources.delete(page);
  };
}

export function currentRingSub(page: PageId): RingSub | undefined {
  return subSources.get(page)?.();
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
/**
 * Finger travelling from RIGHT to LEFT (dx < 0) ADVANCES; left to right steps
 * back. This is the convention the work board already had before the ring
 * existed (useSwipeTabs did the same), so the four task views keep their feel.
 */
export function ringDelta(dx: number, dy: number): 1 | -1 | 0 {
  if (Math.abs(dx) < RING_SWIPE_THRESHOLD_PX) return 0;
  const angle = (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI;
  if (angle > RING_SWIPE_ANGLE_LIMIT_DEG) return 0;
  return dx < 0 ? 1 : -1;
}

/**
 * A horizontally scrollable ancestor owns the gesture until it reaches its edge.
 * Without this, dragging the kanban board sideways would also switch views.
 * `forward` = finger right→left = content scrolling forward (scrollLeft grows).
 */
export function scrollConsumesHorizontal(
  scrollLeft: number,
  clientWidth: number,
  scrollWidth: number,
  forward: boolean,
): boolean {
  if (scrollWidth <= clientWidth + 1) return false;
  return forward ? scrollLeft + clientWidth < scrollWidth - 1 : scrollLeft > 1;
}

function horizontalScrollerConsumes(el: Element | null, forward: boolean): boolean {
  let node: Element | null = el;
  while (node && node !== document.documentElement) {
    const overflowX = getComputedStyle(node).overflowX;
    if ((overflowX === 'auto' || overflowX === 'scroll') && node.scrollWidth > node.clientWidth + 1) {
      if (scrollConsumesHorizontal(node.scrollLeft, node.clientWidth, node.scrollWidth, forward)) return true;
    }
    node = node.parentElement;
  }
  return false;
}

// ── Sub-view commands ───────────────────────────────────────────────────────
const RING_SUB_EVENT = 'markus:ring-sub';

/** Ask a page to show a specific sub-view (e.g. the tasks page → kanban). */
export function requestRingSub(page: PageId, sub: RingSub): void {
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

/**
 * Dev-only readout: what the ring decided for the last gesture. On a real phone
 * there is no console, so the decision has to be visible on screen — this is how
 * "the ring skipped a step" becomes a measurement instead of a guess.
 * Never rendered in production builds.
 */
export function ringDebugNote(text: string): void {
  if (!import.meta.env?.DEV) return;
  let el = document.getElementById('__ring_debug');
  if (!el) {
    el = document.createElement('div');
    el.id = '__ring_debug';
    el.style.cssText =
      'position:fixed;top:4px;left:4px;right:4px;z-index:2147483647;background:#111;color:#4ade80;' +
      'font:11px/1.45 ui-monospace,monospace;padding:6px 8px;border-radius:6px;opacity:.94;pointer-events:none;white-space:pre-wrap';
    document.body.appendChild(el);
  }
  el.textContent = text;
  const t = (el as HTMLElement & { _t?: number })._t;
  if (t) window.clearTimeout(t);
  (el as HTMLElement & { _t?: number })._t = window.setTimeout(() => el?.remove(), 4000);
}

// ── Gesture entry point (module-level, exactly one listener) ────────────────
// Registered ONCE for the whole app. When every hook call installed its own
// listener (or HMR left an old one behind), a single physical swipe advanced two
// steps — the ring must never move more than once per gesture.
type StepHandler = (delta: 1 | -1) => void;

let handler: StepHandler | null = null;
let installed = false;
let gestureOpen = false;
let start: { x: number; y: number } | null = null;
let startTarget: Element | null = null;

function handleTouchStart(e: TouchEvent): void {
  gestureOpen = true;
  startTarget = (e.target as Element) ?? null;
  if (ringShouldIgnore(e.target)) { start = null; return; }
  const t = e.touches[0];
  start = t ? { x: t.clientX, y: t.clientY } : null;
}

function handleTouchEnd(e: TouchEvent): void {
  if (!gestureOpen) return; // this gesture was already handled
  gestureOpen = false;
  const s = start;
  start = null;
  if (!s) return;
  const t = e.changedTouches[0];
  if (!t) return;
  const delta = ringDelta(t.clientX - s.x, t.clientY - s.y);
  if (delta === 0) return;
  // A wide table (kanban) owns the gesture while it can still scroll.
  if (horizontalScrollerConsumes(startTarget, delta === 1)) return;
  handler?.(delta);
}

function installNavRingListener(): void {
  if (installed) return;
  document.addEventListener('touchstart', handleTouchStart, { passive: true });
  document.addEventListener('touchend', handleTouchEnd, { passive: true });
  installed = true;
}

export function useNavRingSwipe(opts: { enabled: boolean; onStep: (delta: 1 | -1) => void }): void {
  const onStepRef = useRef(opts.onStep);
  onStepRef.current = opts.onStep;
  useEffect(() => {
    if (!opts.enabled) return undefined;
    const mine: StepHandler = (delta) => onStepRef.current(delta);
    handler = mine;
    installNavRingListener();
    return () => { if (handler === mine) handler = null; };
  }, [opts.enabled]);
}
