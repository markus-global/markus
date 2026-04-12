import { useRef, useCallback, type TouchEvent, type RefObject } from 'react';

const SWIPE_THRESHOLD = 50;
const SWIPE_ANGLE_LIMIT = 30; // degrees – reject overly vertical gestures

interface SwipeTabsOptions {
  onSwipeOutLeft?: () => void;
  onSwipeOutRight?: () => void;
  scrollContainerRef?: RefObject<HTMLElement | null>;
}

export function useSwipeTabs<T extends string>(
  tabs: readonly { id: T }[],
  activeTab: T,
  setActiveTab: (tab: T) => void,
  options?: SwipeTabsOptions,
) {
  const startX = useRef(0);
  const startY = useRef(0);

  const onTouchStart = useCallback((e: TouchEvent) => {
    startX.current = e.touches[0].clientX;
    startY.current = e.touches[0].clientY;
  }, []);

  const onTouchEnd = useCallback((e: TouchEvent) => {
    const dx = e.changedTouches[0].clientX - startX.current;
    const dy = e.changedTouches[0].clientY - startY.current;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    if (absDx < SWIPE_THRESHOLD) return;
    const angle = Math.atan2(absDy, absDx) * (180 / Math.PI);
    if (angle > SWIPE_ANGLE_LIMIT) return;

    if (options?.scrollContainerRef?.current) {
      const el = options.scrollContainerRef.current;
      const atLeft = el.scrollLeft <= 1;
      const atRight = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
      if (dx > 0 && !atLeft) return;
      if (dx < 0 && !atRight) return;
    }

    const idx = tabs.findIndex(t => t.id === activeTab);
    if (dx < 0 && idx < tabs.length - 1) {
      setActiveTab(tabs[idx + 1].id);
    } else if (dx > 0 && idx > 0) {
      setActiveTab(tabs[idx - 1].id);
    } else if (dx > 0 && idx === 0 && options?.onSwipeOutLeft) {
      options.onSwipeOutLeft();
    } else if (dx < 0 && idx === tabs.length - 1 && options?.onSwipeOutRight) {
      options.onSwipeOutRight();
    }
  }, [tabs, activeTab, setActiveTab, options]);

  return { onTouchStart, onTouchEnd };
}
