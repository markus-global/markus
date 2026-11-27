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

  it('falls back to an even split when 40% would starve the chat', () => {
    for (const space of [700, 800, 900, 999]) {
      const { autoPanelWidth } = rightPanelBounds(space);
      expect(autoPanelWidth).toBe(Math.round(space / 2));
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
