/**
 * chatScrollFollow — the sticky-bottom contract for the chat message list.
 *
 * The rule the product wants: **while the user has not touched the viewport the
 * system keeps it glued to the newest output; the moment the user scrolls up the
 * system hands the viewport over completely, and only takes it back once the
 * user is genuinely back at the bottom.**
 *
 * That sounds trivial and was implemented twice by reasoning about *position*
 * alone ("distance from bottom < 48px → keep following"). Position alone cannot
 * work here, because during a streaming reply the content grows every frame:
 * while the user drags slowly upward the growing content keeps `distance` small
 * for many frames, so a position test keeps deciding "still at the bottom" and
 * yanks the viewport back. The result is the reported jitter — the viewport
 * fighting the gesture.
 *
 * So the decisions below are driven by *intent* (a real user gesture) plus a
 * sticky takeover flag, and position is only consulted to answer one question:
 * "has the user actually arrived back at the bottom?".
 *
 * Kept pure and DOM-free so the whole contract is unit-testable;
 * `Team.tsx` owns the refs, listeners and rAF plumbing.
 */

/** Distance (px) from the bottom still treated as "at the bottom". */
export const AT_BOTTOM_EPSILON = 12;

/**
 * How long after the last gesture event programmatic follow stays frozen.
 * Long enough to cover a wheel burst / a touch flick, short enough that the
 * viewport re-glues almost immediately when the user is done.
 */
export const GESTURE_WINDOW_MS = 400;

/**
 * Frames the follow loop is allowed to re-assert the bottom for. Rows are sized
 * from measurements, so landing on the current bottom renders rows that measure
 * taller and push the real bottom down; a handful of re-asserts converges, and a
 * hard cap keeps a pathological list from scrolling forever.
 */
export const SETTLE_MAX_FRAMES = 4;

/**
 * Window during which an explicit smooth jump owns the viewport. The per-frame
 * instant follow would otherwise cut the animation short on the next token.
 */
export const SMOOTH_JUMP_MS = 350;

/** The geometry we need from a scroll container (a DOM element satisfies it). */
export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function maxScrollTop(el: ScrollMetrics): number {
  return Math.max(0, el.scrollHeight - el.clientHeight);
}

/** Can this container be scrolled at all? Short content cannot be "taken over". */
export function isScrollable(el: ScrollMetrics): boolean {
  return maxScrollTop(el) > 1;
}

export function distanceFromBottom(el: ScrollMetrics): number {
  return maxScrollTop(el) - el.scrollTop;
}

export function isAtBottom(el: ScrollMetrics): boolean {
  return distanceFromBottom(el) <= AT_BOTTOM_EPSILON;
}

// ─── Gesture classification ──────────────────────────────────────────────────

export type GestureDirection = 'up' | 'down' | 'none';

/**
 * Wheel/trackpad direction. A horizontal-dominant delta (sideways swipe over a
 * code block) is not a vertical scroll intent and must not be read as one.
 */
export function wheelDirection(deltaX: number, deltaY: number): GestureDirection {
  if (Math.abs(deltaY) <= Math.abs(deltaX)) return 'none';
  if (deltaY < 0) return 'up';
  if (deltaY > 0) return 'down';
  return 'none';
}

const UP_KEYS = new Set(['ArrowUp', 'PageUp', 'Home']);
const DOWN_KEYS = new Set(['ArrowDown', 'PageDown', 'End']);

export function keyDirection(key: string): GestureDirection {
  if (UP_KEYS.has(key)) return 'up';
  if (DOWN_KEYS.has(key)) return 'down';
  return 'none';
}

/**
 * Touch direction: a finger moving *down* the screen is the user scrolling
 * content *up* (that is the direction that steals the viewport).
 */
export function touchDirection(prevClientY: number | null, clientY: number): GestureDirection {
  if (prevClientY == null) return 'none';
  if (clientY > prevClientY + 1) return 'up';
  if (clientY < prevClientY - 1) return 'down';
  return 'none';
}

// ─── Decisions ───────────────────────────────────────────────────────────────

export interface ScrollFollowInput {
  /** True while the user owns the viewport (sticky until they return to the bottom). */
  takeover: boolean;
  /** A user gesture event arrived within GESTURE_WINDOW_MS. */
  gestureActive: boolean;
  /** Direction of the most recent gesture. */
  gestureDirection: GestureDirection;
  /** The container can actually be scrolled. */
  scrollable: boolean;
  /** Pixels between the current position and the bottom. */
  distance: number;
  /** scrollTop delta since the previous scroll event. */
  deltaScrollTop: number;
  /** This scroll event was produced by our own follow loop. */
  programmatic: boolean;
}

export type ScrollFollowDecision =
  /** Keep following (the follow loop owns scrolling). */
  | 'follow'
  /** The user just took control — cancel any in-flight snap, show the affordance. */
  | 'handover'
  /** The user is genuinely back at the bottom — take the viewport back. */
  | 'resume'
  /** Nothing to change. */
  | 'hold';

/**
 * Decide what one scroll event (or recomputation) means for the follow contract.
 *
 * `programmatic` exists so our own snap-to-bottom cannot be mistaken for a user
 * gesture: it moves scrollTop a long way in one step, which would otherwise look
 * like the user scrolling *down* (and would wrongly let a snapped-back viewport
 * "resume" itself out of a user takeover).
 */
export function decideScrollFollow(i: ScrollFollowInput): ScrollFollowDecision {
  // Short content: there is nothing to take over, and a stray gesture must not
  // freeze the follow — otherwise the first message that finally makes the list
  // scrollable would arrive with follow silently disabled.
  if (!i.scrollable) return i.takeover ? 'resume' : 'follow';

  if (!i.takeover) {
    // While following, an explicit upward gesture is a takeover even before the
    // scroll event lands (the wheel listener fires first, and waiting for the
    // event means losing a frame to a snap).
    if (i.gestureDirection === 'up' && i.gestureActive) return 'handover';
    // Fallback for gestures whose direction we cannot read (scrollbar drag): a
    // real upward movement that we did not produce ourselves.
    if (!i.programmatic && i.deltaScrollTop < -4) return 'handover';
    return 'follow';
  }

  // Takeover: only an arrival at the bottom gives control back. Requiring the
  // last gesture to have been downwards (or directionless, i.e. a scrollbar
  // drag) keeps a leftover upward gesture from re-arming follow. One exact
  // bottom position while a virtualizer remeasure shrinks the list by accident
  // is not a user action.
  if (i.gestureDirection === 'up') return 'hold';
  return i.distance <= AT_BOTTOM_EPSILON ? 'resume' : 'hold';
}

/** May the follow loop scroll right now? */
export function canFollow(state: { takeover: boolean; gestureActive: boolean }): boolean {
  return !state.takeover && !state.gestureActive;
}

/** Should this gesture immediately hand the viewport over? */
export function gestureTakesOver(direction: GestureDirection, scrollable: boolean): boolean {
  return scrollable && direction === 'up';
}
