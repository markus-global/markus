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
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useResizablePanel } from './useResizablePanel.ts';

/** The only surface these tests need; typed to match the hook so the fake event is honest. */
type ResizeHandle = { onResizeStart: (e: ReactMouseEvent) => void };

function drag(getHandle: () => ResizeHandle, fromX: number, toX: number) {
  act(() => {
    getHandle().onResizeStart({ preventDefault() { /* noop */ }, clientX: fromX } as ReactMouseEvent);
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: toX }));
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: toX }));
  });
}

describe('useResizablePanel — drag direction follows the anchored side', () => {
  it('a LEFT-anchored panel grows when the pointer moves right', () => {
    const { result } = renderHook(() => useResizablePanel({
      side: 'left', defaultWidth: 400, minWidth: 320, maxWidth: 900, storageKey: 'test_left_grow',
    }));
    const get = (): ResizeHandle => result.current;
    drag(get, 500, 560);
    expect(result.current.width).toBe(460);
  });

  it('a LEFT-anchored panel shrinks when the pointer moves left', () => {
    const { result } = renderHook(() => useResizablePanel({
      side: 'left', defaultWidth: 400, minWidth: 320, maxWidth: 900, storageKey: 'test_left_shrink',
    }));
    const get = (): ResizeHandle => result.current;
    drag(get, 500, 440);
    expect(result.current.width).toBe(340);
  });

  it('a RIGHT-anchored panel keeps the opposite sense (unchanged behaviour)', () => {
    const { result } = renderHook(() => useResizablePanel({
      side: 'right', defaultWidth: 400, minWidth: 320, maxWidth: 900, storageKey: 'test_right',
    }));
    const get = (): ResizeHandle => result.current;
    drag(get, 500, 440);
    expect(result.current.width).toBe(460);
  });
});
