/**
 * Resize direction — the regression test for "dragging moved the split the wrong way".
 *
 * The bug was not a sign typo in isolation: the same rule existed twice, and only the copy used
 * by the (then right-hand) detail panel was exercised. These assertions pin the rule to the
 * panel's side, so a left-anchored panel can never inherit the right-anchored formula again.
 */
import { describe, it, expect } from 'vitest';
import { resizedWidth } from './panelResize.ts';

describe('resizedWidth — direction depends on the anchored side', () => {
  it('left-anchored panel grows when the pointer moves right', () => {
    expect(resizedWidth({ startWidth: 400, dx: 60, side: 'left' })).toBe(460);
  });

  it('left-anchored panel shrinks when the pointer moves left', () => {
    expect(resizedWidth({ startWidth: 400, dx: -60, side: 'left' })).toBe(340);
  });

  it('right-anchored panel shrinks when the pointer moves right (unchanged behaviour)', () => {
    expect(resizedWidth({ startWidth: 400, dx: 60, side: 'right' })).toBe(340);
  });

  it('right-anchored panel grows when the pointer moves left', () => {
    expect(resizedWidth({ startWidth: 400, dx: -60, side: 'right' })).toBe(460);
  });

  it('clamps to the given bounds', () => {
    expect(resizedWidth({ startWidth: 400, dx: -999, side: 'left', min: 320 })).toBe(320);
    expect(resizedWidth({ startWidth: 400, dx: 9999, side: 'left', max: 900 })).toBe(900);
  });
});
