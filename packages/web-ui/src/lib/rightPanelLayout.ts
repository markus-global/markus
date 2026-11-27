/**
 * Team Chat layout math — pure, no DOM, no React.
 *
 * Why this is a module and not inline arithmetic in `pages/Team.tsx`: the split
 * rule is a product contract ("of the space the L1/L2 rails leave, chat gets
 * 40% and the right panel 60%"), and the same numbers feed the drag clamp. Left
 * inline in a 6 700-line component it could only ever be verified by eyeballing
 * the browser — the contract would be untestable and would silently drift.
 */

/** Chat column floor (px) — below this the composer stops being usable. */
export const CHAT_MIN_W = 400;

/** Right panel floor (px) for manual drags. */
export const PANEL_MIN_W = 320;

/** Chat's share of the space the rails leave (the panel takes the rest). */
export const CHAT_SHARE = 0.4;

export interface RightPanelBounds {
  /** Largest width the panel may take while the chat keeps its floor. */
  maxPanelWidth: number;
}

/**
 * Hard cap for the right panel, given the space it shares with the chat column
 * (container width minus the L1/L2 rails and their resize handles).
 *
 * Only the CAP lives here — it clamps a pixel width the user pinned by dragging.
 * The auto 40/60 split is **not** computed in JS: it is a flex ratio on the row
 * (chat `flex-[4_1_0%]`, panel `grow-[6]`). Reason (Owner 2026-11-27): the JS
 * version derived its width from measured inputs (`containerWidth` from a
 * ResizeObserver, rail widths from state), and in the real app those inputs were
 * wrong — the panel rendered at ~50% while the arithmetic reported 60%. A ratio
 * owned by the layout engine cannot drift like that.
 */
export function rightPanelMaxWidth(spaceForChatPanel: number): number {
  const space = Math.max(0, spaceForChatPanel);
  const chatReserve = Math.min(CHAT_MIN_W, Math.floor(space * CHAT_SHARE));
  return Math.max(0, space - chatReserve);
}

/** What the L1/L2 rails should do on a right-panel open/close transition. */
export type RailsAction = 'collapse' | 'restore' | 'none';

/**
 * Decide the rail action for a right-panel transition.
 *
 * - opening  → collapse both rails: the panel needs the space.
 * - closing  → restore them **only if they were open before the panel took
 *   them**. A rail set the user had already collapsed (Cmd+B, or the persisted
 *   preference) stays collapsed — a manual collapse is never undone behind the
 *   user's back.
 *
 * Only *transitions* act, so a manual Cmd+B performed while the panel is closed
 * is not fought by a later render.
 */
export function railsActionOnPanelTransition(
  prevOpen: boolean,
  open: boolean,
  railsCollapsedBeforePanel: boolean | null,
): RailsAction {
  if (open && !prevOpen) return 'collapse';
  if (!open && prevOpen) return railsCollapsedBeforePanel === false ? 'restore' : 'none';
  return 'none';
}
