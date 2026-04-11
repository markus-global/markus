/**
 * A lightweight event bus for triggering navigation from deep components
 * without needing to thread callbacks through the whole tree.
 */
import type { PageId } from './routes.ts';

type NavHandler = (page: PageId, params?: Record<string, string>) => void;

let _handler: NavHandler | null = null;

export const navBus = {
  setHandler(h: NavHandler) { _handler = h; },
  navigate(page: PageId, params?: Record<string, string>) {
    if (params) {
      Object.entries(params).forEach(([k, v]) => localStorage.setItem(`markus_nav_${k}`, v));
    }
    window.dispatchEvent(new CustomEvent('markus:navigate', { detail: { page, params } }));
    _handler?.(page, params);
  },
};
