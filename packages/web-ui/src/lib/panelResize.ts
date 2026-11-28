/**
 * Panel resize math — ONE definition of "which way is wider".
 *
 * A panel anchored on the LEFT grows when the pointer moves right; a panel anchored on the
 * RIGHT grows when the pointer moves left. That is the whole rule, and it used to live twice:
 * `useResizablePanel` had it (with a `side` prop) while the Work page's detail-width handler
 * hard-coded the right-anchored form. When the project detail panel moved to the left of the
 * board it kept the right-anchored formula, so dragging its handle moved the split the wrong
 * way (Owner report 2026-11-28).
 *
 * Keeping the sign here means a panel's position is data (a `side` argument), never a copy of
 * the arithmetic.
 */
export type PanelSide = 'left' | 'right';

export interface ResizeArgs {
  /** Width when the drag started. */
  startWidth: number;
  /** Pointer movement in pixels, positive to the right. */
  dx: number;
  /** Where the panel sits: its own anchored edge. */
  side: PanelSide;
  min?: number;
  max?: number;
}

export function resizedWidth({ startWidth, dx, side, min = 0, max = Number.POSITIVE_INFINITY }: ResizeArgs): number {
  // Left-anchored: rightward drag widens. Right-anchored: leftward drag widens.
  const delta = side === 'left' ? dx : -dx;
  return Math.max(min, Math.min(max, startWidth + delta));
}
