/**
 * "Which element is actually scrolling?"
 *
 * On mobile the document root is the scroller (that is what lets the browser
 * hide its own toolbar — see lib/mobileDocScroll.ts), so a page's inner
 * `overflow-y-auto` pane stops scrolling: its `scrollTop` stays 0 forever.
 * Code that guards on `el.scrollTop` ("only load more / only refresh when we are
 * at the top") therefore reads a constant, and the guard silently becomes
 * always-true — infinite-scroll re-fetches pages while the list is idle, and a
 * pull-to-refresh fires on any downward swipe instead of on a real pull.
 *
 * One measurement, used by every such guard: report the metrics of the element
 * when it really is the scroller, otherwise of the document root.
 */
export interface ScrollMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  atTop: boolean;
  atBottom: boolean;
}

export function scrollMetrics(el: HTMLElement | null): ScrollMetrics {
  const scrolling = document.scrollingElement as HTMLElement | null;
  const elementScrolls = !!el && el.scrollHeight > el.clientHeight + 1;

  const source: HTMLElement | null = elementScrolls ? el : scrolling;
  const scrollTop = source?.scrollTop ?? 0;
  const clientHeight = source?.clientHeight ?? window.innerHeight;
  const scrollHeight = source?.scrollHeight ?? document.body.scrollHeight;

  return {
    scrollTop,
    clientHeight,
    scrollHeight,
    atTop: scrollTop <= 0,
    atBottom: scrollTop + clientHeight >= scrollHeight - 1,
  };
}

/**
 * Subscribe to "the list scrolled" for the scroller reported by scrollMetrics.
 *
 * Element scroll events do not bubble, so a listener on `el` alone goes silent
 * the moment the document takes over (and vice versa). A capture-phase listener
 * on window receives both, so one subscription covers both layouts.
 */
export function onScrollAnywhere(cb: () => void): () => void {
  window.addEventListener('scroll', cb, { passive: true, capture: true });
  return () => window.removeEventListener('scroll', cb, { capture: true } as EventListenerOptions);
}
