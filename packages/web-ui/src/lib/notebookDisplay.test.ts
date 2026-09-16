/**
 * Notebook display helpers (docs/MEMORY-SYSTEM.md §2; AGENT-RUNTIME.md §6).
 *
 * The panel must never render an unbounded list: a real notebook reached 26
 * entries and made the Agent overview unreadable. These are pure-function tests —
 * this package has no jsdom / @testing-library/react, so React rendering is out
 * of scope (see packages/web-ui/src/api.test.ts:3-4).
 */
import { describe, it, expect } from 'vitest';
import {
  sliceNotebookForDisplay,
  formatNotebookAge,
  NOTEBOOK_DISPLAY_LIMIT,
  type NotebookDisplayEntry,
} from './notebookDisplay.ts';

function entries(n: number): NotebookDisplayEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `key-${i}`,
    text: `body ${i}`,
    updatedAt: 1_000_000 + i,
    managed: 'agent',
  }));
}

describe('sliceNotebookForDisplay', () => {
  it('shows everything when the notebook fits', () => {
    const result = sliceNotebookForDisplay(entries(3), false);
    expect(result.visible).toHaveLength(3);
    expect(result.hiddenCount).toBe(0);
    expect(result.collapsible).toBe(false);
  });

  it('caps the collapsed view at the display limit and reports the remainder', () => {
    const result = sliceNotebookForDisplay(entries(26), false);
    expect(result.visible).toHaveLength(NOTEBOOK_DISPLAY_LIMIT);
    expect(result.hiddenCount).toBe(26 - NOTEBOOK_DISPLAY_LIMIT);
    expect(result.collapsible).toBe(true);
  });

  it('preserves order, so "first N" means "most recent N"', () => {
    const result = sliceNotebookForDisplay(entries(20), false);
    expect(result.visible[0]!.key).toBe('key-0');
    expect(result.visible.at(-1)!.key).toBe(`key-${NOTEBOOK_DISPLAY_LIMIT - 1}`);
  });

  it('shows everything when expanded, still flagging collapsibility', () => {
    const result = sliceNotebookForDisplay(entries(26), true);
    expect(result.visible).toHaveLength(26);
    expect(result.hiddenCount).toBe(0);
    expect(result.collapsible).toBe(true);
  });

  it('is exactly at the boundary for limit-sized input (no spurious button)', () => {
    const result = sliceNotebookForDisplay(entries(NOTEBOOK_DISPLAY_LIMIT), false);
    expect(result.collapsible).toBe(false);
    expect(result.hiddenCount).toBe(0);
  });

  it('tolerates undefined / null (mind state not yet loaded)', () => {
    expect(sliceNotebookForDisplay(undefined, false).visible).toEqual([]);
    expect(sliceNotebookForDisplay(null, false).hiddenCount).toBe(0);
  });

  it('accepts a custom limit', () => {
    const result = sliceNotebookForDisplay(entries(10), false, 4);
    expect(result.visible).toHaveLength(4);
    expect(result.hiddenCount).toBe(6);
  });
});

describe('formatNotebookAge', () => {
  const NOW = 1_800_000_000_000;

  it('uses seconds under a minute', () => {
    expect(formatNotebookAge(NOW - 30_000, NOW)).toEqual({ unit: 'seconds', count: 30 });
  });

  it('uses minutes under an hour', () => {
    expect(formatNotebookAge(NOW - 5 * 60_000, NOW)).toEqual({ unit: 'minutes', count: 5 });
  });

  it('uses hours beyond that', () => {
    expect(formatNotebookAge(NOW - 3 * 3_600_000, NOW)).toEqual({ unit: 'hours', count: 3 });
  });

  it('handles the minute/hour boundary exactly', () => {
    expect(formatNotebookAge(NOW - 59_999, NOW).unit).toBe('seconds');
    expect(formatNotebookAge(NOW - 60_000, NOW).unit).toBe('minutes');
    expect(formatNotebookAge(NOW - 3_599_999, NOW).unit).toBe('minutes');
    expect(formatNotebookAge(NOW - 3_600_000, NOW).unit).toBe('hours');
  });

  it('clamps future / invalid timestamps instead of rendering a negative age', () => {
    expect(formatNotebookAge(NOW + 60_000, NOW).count).toBe(0);
    expect(formatNotebookAge(Number.NaN, NOW).count).toBe(0);
  });
});
