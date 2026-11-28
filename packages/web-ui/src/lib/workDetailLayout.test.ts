/**
 * Detail-slot gate — the regression test for the blank right pane (Owner report, 2026-11-28).
 *
 * The old gate was `mode !== 'closed'`, so opening the project panel (which lives on the LEFT)
 * also mounted the right container with no content inside. These assertions pin the rule
 * "a slot is open only when it has something to render", on both layouts.
 */
import { describe, it, expect } from 'vitest';
import { resolveDetailSlots, type RightDetailMode } from './workDetailLayout.ts';

const desktop = (mode: RightDetailMode, hasSelectedItem = false, hasProject = true) =>
  resolveDetailSlots({ isMobile: false, mode, hasSelectedItem, hasProject, mobileShowDetail: false });

const mobile = (mode: RightDetailMode, mobileShowDetail: boolean, hasProject = true) =>
  resolveDetailSlots({ isMobile: true, mode, hasSelectedItem: false, hasProject, mobileShowDetail });

describe('desktop — project panel and item panel are mutually exclusive', () => {
  it('opening the project panel does NOT open the right slot (the reported blank pane)', () => {
    expect(desktop('project')).toEqual({ showProjectSlot: true, showDetailSlot: false });
  });

  it('selecting an item closes the project slot and opens the detail slot', () => {
    expect(desktop('item', true)).toEqual({ showProjectSlot: false, showDetailSlot: true });
  });

  it('mode "item" without a selection renders nothing at all (no empty container)', () => {
    expect(desktop('item', false)).toEqual({ showProjectSlot: false, showDetailSlot: false });
  });

  it('the explicit empty state still gets the slot', () => {
    expect(desktop('empty')).toEqual({ showProjectSlot: false, showDetailSlot: true });
  });

  it('closed opens nothing', () => {
    expect(desktop('closed')).toEqual({ showProjectSlot: false, showDetailSlot: false });
  });

  it('project mode without a resolved project opens nothing on the left', () => {
    expect(desktop('project', false, false)).toEqual({ showProjectSlot: false, showDetailSlot: false });
  });
});

describe('mobile — one detail slot, no left column', () => {
  it('the project panel uses the single detail slot when it is shown', () => {
    expect(mobile('project', true)).toEqual({ showProjectSlot: false, showDetailSlot: true });
  });

  it('nothing renders while the detail area is dismissed', () => {
    expect(mobile('project', false)).toEqual({ showProjectSlot: false, showDetailSlot: false });
  });
});
