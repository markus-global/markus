/**
 * Electron WebContentsView paints above the HTML layer, so CSS z-index cannot
 * put modals on top of the embedded browser. While a blocking overlay is open,
 * or the host page is not Team, hide native views; when allowed again, resync.
 */

let overlayDepth = 0;
/** False while Team is hidden / right panel collapsed — blocks paint before React effects run. */
let pagePaintAllowed = true;

function browserApi() {
  return typeof window !== 'undefined' ? window.markusDesktop?.browser : undefined;
}

export function isNativeBrowserOverlayActive(): boolean {
  return overlayDepth > 0;
}

export function isNativeBrowserPagePaintAllowed(): boolean {
  return pagePaintAllowed;
}

/**
 * Synchronously allow/deny native browser painting for the current app page.
 * Call this in navigate()/hash handlers *before* paint so views don't linger
 * over Overview/Settings for multiple frames (or seconds of IPC backlog).
 */
export function setNativeBrowserPagePaintAllowed(allowed: boolean): void {
  if (pagePaintAllowed === allowed) return;
  pagePaintAllowed = allowed;
  if (!allowed) {
    void browserApi()?.hideAll?.();
  }
  window.dispatchEvent(new CustomEvent('markus:native-browser-page', { detail: { allowed } }));
  if (allowed && overlayDepth === 0) {
    window.dispatchEvent(new CustomEvent('markus:embedded-browser-resync'));
  }
}

/** Acquire overlay lock; returns a release function (safe to call once). */
export function acquireNativeBrowserOverlay(): () => void {
  overlayDepth += 1;
  if (overlayDepth === 1) {
    void browserApi()?.hideAll?.();
    window.dispatchEvent(new CustomEvent('markus:native-browser-overlay', { detail: { active: true } }));
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    overlayDepth = Math.max(0, overlayDepth - 1);
    if (overlayDepth === 0) {
      window.dispatchEvent(new CustomEvent('markus:native-browser-overlay', { detail: { active: false } }));
      if (pagePaintAllowed) {
        window.dispatchEvent(new CustomEvent('markus:embedded-browser-resync'));
      }
    }
  };
}
