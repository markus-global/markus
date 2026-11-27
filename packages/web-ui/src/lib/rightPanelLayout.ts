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

/** Share of the shared space the right panel takes in the auto split. */
export const PANEL_AUTO_SHARE = 0.6;

export interface RightPanelBounds {
  /** Largest width the panel may take while the chat keeps its floor. */
  maxPanelWidth: number;
  /** Width the panel takes in the auto split (chat 40% / panel 60%). */
  autoPanelWidth: number;
}

/**
 * Widths for the right panel given the space it shares with the chat column
 * (container width minus the L1/L2 rails and their resize handles).
 *
 * Rule: the panel takes 60%, the chat 40%. When the container is too narrow for
 * 40% to still leave `CHAT_MIN_W` for the chat, the two columns fall back to an
 * even split so neither collapses. `maxPanelWidth` is always clamped so
 * chat + panel can never overflow the shared space.
 */
export function rightPanelBounds(spaceForChatPanel: number): RightPanelBounds {
  const space = Math.max(0, spaceForChatPanel);
  // Chat's floor: CHAT_MIN_W, but never more than its 40% share (otherwise a
  // narrow container would reserve the whole width for the chat).
  const chatReserve = Math.min(CHAT_MIN_W, Math.floor(space * (1 - PANEL_AUTO_SHARE)));
  const maxPanelWidth = Math.max(0, space - chatReserve);
  const autoShare = space >= CHAT_MIN_W / (1 - PANEL_AUTO_SHARE)
    ? Math.round(space * PANEL_AUTO_SHARE) // 40/60 split
    : Math.round(space / 2); // narrow: even split
  return {
    maxPanelWidth,
    autoPanelWidth: Math.max(0, Math.min(autoShare, maxPanelWidth)),
  };
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
