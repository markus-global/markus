/**
 * Direction behaviour of the shared resize implementation.
 *
 * `useResizablePanel` is where the sidebar and (after the resize-direction fix) the Work page's
 * detail panels get their width math from. The bug it was fixed for: a panel anchored on the left
 * inherited the right-anchored formula, so dragging the split moved the opposite way.
 *
 * These assertions are behavioural: they drive real pointer events through the hook and read the
 * resulting width, so swapping the sign back to the buggy form turns them red.
 */
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useResizablePanel } from './useResizablePanel.ts';

function drag(get: () => { onResizeStart: (e: unknown) => void }, fromX: number, toX: number) {
  act(() => {
    get().onResizeStart({ preventDefault() { /* noop */ }, clientX: fromX });
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: toX }));
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: toX }));
  });
}

describe('useResizablePanel — drag direction follows the anchored side', () => {
  it('a LEFT-anchored panel grows when the pointer moves right', () => {
    const { result } = renderHook(() => useResizablePanel({
      side: 'left', defaultWidth: 400, minWidth: 320, maxWidth: 900, storageKey: 'test_left_grow',
    }));
    const get = () => result.current;
    drag(get, 500, 560);
    expect(result.current.width).toBe(460);
  });

  it('a LEFT-anchored panel shrinks when the pointer moves left', () => {
    const { result } = renderHook(() => useResizablePanel({
      side: 'left', defaultWidth: 400, minWidth: 320, maxWidth: 900, storageKey: 'test_left_shrink',
    }));
    const get = () => result.current;
    drag(get, 500, 440);
    expect(result.current.width).toBe(340);
  });

  it('a RIGHT-anchored panel keeps the opposite sense (unchanged behaviour)', () => {
    const { result } = renderHook(() => useResizablePanel({
      side: 'right', defaultWidth: 400, minWidth: 320, maxWidth: 900, storageKey: 'test_right',
    }));
    const get = () => result.current;
    drag(get, 500, 440);
    expect(result.current.width).toBe(460);
  });
});
