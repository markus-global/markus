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
    // Page-level navigation FIRST, then the page-specific handler.
    //
    // The reverse order looks harmless but is a URL race: the specific handler
    // sets a sub-route (e.g. `team/d` to open a conversation) and the generic
    // navigation then rewrites the URL to the page root (`team`), so the
    // app-wide state — including "is this a sub-page, hide the bottom nav" —
    // disagrees with what the user was actually sent to.
    _handler?.(page, params);
    window.dispatchEvent(new CustomEvent('markus:navigate', { detail: { page, params } }));
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
