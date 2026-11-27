import { describe, it, expect } from 'vitest';
import {
  CHAT_MIN_W,
  PANEL_AUTO_SHARE,
  rightPanelBounds,
  railsActionOnPanelTransition,
} from './rightPanelLayout.ts';

/**
 * These numbers are an Owner-facing contract, so the assertions pin the *share*
 * rather than a pixel constant: at any width wide enough for both minimums the
 * chat column must come out at exactly 40% of the shared space. A regression to
 * a 50/50 (or any other) split fails here.
 */
describe('rightPanelBounds — 40/60 split', () => {
  it('gives the panel 60% and the chat exactly 40% on a wide container', () => {
    for (const space of [1000, 1200, 1600, 2048, 3200]) {
      const { autoPanelWidth } = rightPanelBounds(space);
      expect(autoPanelWidth).toBe(Math.round(space * PANEL_AUTO_SHARE));
      expect(space - autoPanelWidth).toBe(space - Math.round(space * PANEL_AUTO_SHARE));
      // chat share is 40% (within rounding)
      expect(Math.abs((space - autoPanelWidth) / space - (1 - PANEL_AUTO_SHARE))).toBeLessThan(0.005);
    }
  });

  it('keeps the chat floor at the 40% boundary (space = 1000)', () => {
    const { autoPanelWidth, maxPanelWidth } = rightPanelBounds(1000);
    expect(autoPanelWidth).toBe(600);
    expect(1000 - autoPanelWidth).toBeGreaterThanOrEqual(CHAT_MIN_W);
    expect(autoPanelWidth).toBeLessThanOrEqual(maxPanelWidth);
  });

  it('keeps the 40/60 split for EVERY shared width — the ratio never changes shape', () => {
    for (let space = 400; space <= 3000; space += 10) {
      const { autoPanelWidth } = rightPanelBounds(space);
      const panelShare = autoPanelWidth / space;
      expect(Math.abs(panelShare - PANEL_AUTO_SHARE)).toBeLessThan(0.01);
    }
  });

  it('keeps the ratio identical whether L1/L2 are open or closed', () => {
    // Same container, panel already open; L1 (+L2) then take 286px / 552px out
    // of the shared space. Before the fix the second row flipped to 1:1.
    const container = 1200;
    const closed = rightPanelBounds(container - 14);
    const l1 = rightPanelBounds(container - 286 - 14);
    const l1l2 = rightPanelBounds(container - 552 - 14);
    const ratio = (panel: number, space: number) => panel / space;
    expect(ratio(l1.autoPanelWidth, container - 286 - 14)).toBeCloseTo(ratio(closed.autoPanelWidth, container - 14), 2);
    expect(ratio(l1l2.autoPanelWidth, container - 552 - 14)).toBeCloseTo(ratio(closed.autoPanelWidth, container - 14), 2);
    // and the panel always stays the wider of the two columns
    for (const [panel, space] of [[l1.autoPanelWidth, container - 286 - 14], [l1l2.autoPanelWidth, container - 552 - 14]] as const) {
      expect(panel).toBeGreaterThan(space - panel);
    }
  });

  it('never lets chat + auto panel overflow the shared space', () => {
    for (let space = 0; space <= 4000; space += 25) {
      const { autoPanelWidth, maxPanelWidth } = rightPanelBounds(space);
      expect(autoPanelWidth).toBeLessThanOrEqual(maxPanelWidth);
      expect(autoPanelWidth).toBeLessThanOrEqual(space);
      expect(maxPanelWidth).toBeLessThanOrEqual(space);
      expect(autoPanelWidth).toBeGreaterThanOrEqual(0);
    }
  });

  it('degenerates safely on non-positive input', () => {
    expect(rightPanelBounds(0)).toEqual({ maxPanelWidth: 0, autoPanelWidth: 0 });
    expect(rightPanelBounds(-50)).toEqual({ maxPanelWidth: 0, autoPanelWidth: 0 });
  });
});

describe('railsActionOnPanelTransition', () => {
  it('collapses the rails when the panel opens', () => {
    expect(railsActionOnPanelTransition(false, true, null)).toBe('collapse');
  });

  it('restores the rails when the panel closes if they were open before it took the space', () => {
    expect(railsActionOnPanelTransition(true, false, false)).toBe('restore');
  });

  it('leaves the rails collapsed if the user had already collapsed them (Cmd+B)', () => {
    expect(railsActionOnPanelTransition(true, false, true)).toBe('none');
    expect(railsActionOnPanelTransition(true, false, null)).toBe('none');
  });

  it('does nothing without a transition — a manual toggle is never fought', () => {
    expect(railsActionOnPanelTransition(false, false, null)).toBe('none');
    expect(railsActionOnPanelTransition(false, false, true)).toBe('none');
    expect(railsActionOnPanelTransition(true, true, false)).toBe('none');
    expect(railsActionOnPanelTransition(true, true, true)).toBe('none');
  });
});
