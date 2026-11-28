/**
 * Which detail slot is open — ONE derivation, unit-tested.
 *
 * History (2026-11-28, Owner-reported blank right pane): the page used to gate the right panel
 * with `hasDetail = mode !== 'closed'`, which was written when "panel open" implied "a panel with
 * content". Clicking a project then started setting `mode = 'project'` (its detail panel lives on
 * the LEFT), so the right container rendered while none of its content branches matched — an empty
 * column that also squeezed the item list.
 *
 * The three-state confusion came from re-deriving "is something open?" from a mode enum in two
 * places. It is answered once, here:
 *   - desktop: the PROJECT panel is its own left slot; the right slot is only ever an item/empty
 *     panel. The two can never be open at the same time (max three columns).
 *   - mobile: there is no L1 column, so the single detail slot shows whichever panel `mode` names.
 */
export type RightDetailMode = 'closed' | 'project' | 'item' | 'empty';

export interface DetailSlots {
  /** Desktop-only left slot (the project detail panel). Always false on mobile. */
  showProjectSlot: boolean;
  /** The item / empty / (mobile) project slot. */
  showDetailSlot: boolean;
}

export function resolveDetailSlots(opts: {
  isMobile: boolean;
  mode: RightDetailMode;
  hasSelectedItem: boolean;
  hasProject: boolean;
  mobileShowDetail: boolean;
}): DetailSlots {
  if (opts.isMobile) {
    return { showProjectSlot: false, showDetailSlot: opts.mobileShowDetail };
  }
  return {
    showProjectSlot: opts.mode === 'project' && opts.hasProject,
    // `mode === 'item'` without a selection cannot render anything — treat it as closed rather
    // than mounting an empty container (that is exactly the bug this function exists to prevent).
    showDetailSlot: opts.mode === 'empty' || (opts.mode === 'item' && opts.hasSelectedItem),
  };
}
