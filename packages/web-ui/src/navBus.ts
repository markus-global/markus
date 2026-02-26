/**
 * A lightweight event bus for triggering navigation from deep components
 * without needing to thread callbacks through the whole tree.
 */
type NavHandler = (page: string, params?: Record<string, string>) => void;

let _handler: NavHandler | null = null;

export const navBus = {
  setHandler(h: NavHandler) { _handler = h; },
  navigate(page: string, params?: Record<string, string>) {
    // Write params to localStorage for target page
    if (params) {
      Object.entries(params).forEach(([k, v]) => localStorage.setItem(`markus_nav_${k}`, v));
    }
    // Dispatch custom event so already-mounted components can react
    window.dispatchEvent(new CustomEvent('markus:navigate', { detail: { page, params } }));
    _handler?.(page, params);
  },
};
