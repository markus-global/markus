/**
 * A lightweight event bus for triggering navigation from deep components
 * without needing to thread callbacks through the whole tree.
 */
import { PAGE, type PageId } from './routes.ts';

type NavHandler = (page: PageId, params?: Record<string, string>) => void;

let _handler: NavHandler | null = null;
/** Page to restore when leaving Settings (H / Back). */
let _settingsReturnPage: PageId = PAGE.HOME;

export const navBus = {
  setHandler(h: NavHandler) { _handler = h; },
  navigate(page: PageId, params?: Record<string, string>) {
    if (params) {
      Object.entries(params).forEach(([k, v]) => localStorage.setItem(`markus_nav_${k}`, v));
    }
    window.dispatchEvent(new CustomEvent('markus:navigate', { detail: { page, params } }));
    _handler?.(page, params);
  },
  setSettingsReturnPage(page: PageId) {
    if (page !== PAGE.SETTINGS) _settingsReturnPage = page;
  },
  getSettingsReturnPage() {
    return _settingsReturnPage;
  },
  /** Leave Settings and return to the page that was open before entering it. */
  leaveSettings() {
    const target = _settingsReturnPage !== PAGE.SETTINGS ? _settingsReturnPage : PAGE.HOME;
    this.navigate(target);
  },
};
