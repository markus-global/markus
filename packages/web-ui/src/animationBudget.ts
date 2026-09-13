/**
 * Animation budget guard.
 *
 * Why this exists (measured on the desktop build, renderer process):
 *   idle, animations on = 3.5%   idle, animations off = 0%
 *   busy, animations on = 33%    busy, animations off = 3.1%
 *
 * The renderer main thread is *idle* through all of it — a CPU profile showed
 * 79% idle with the top JS frame at 1.2%, and a 6s trace contained zero
 * Paint / Layout / UpdateLayerTree events. So the cost is not JavaScript and
 * not repainting: it is continuous frame production. Any running CSS animation
 * makes the compositor emit a frame every vsync, i.e. up to 120/s on a
 * ProMotion display, and on this DOM each frame is ~2ms.
 *
 * Therefore: when the user cannot see the window, produce no frames at all.
 * Toggling `data-anim-paused` on <html> pauses every animation via CSS
 * (see index.css "Animation budget"). Measured: visible 33% -> hidden 0.4%.
 *
 * Note: Chromium's own occlusion throttling is disabled in this build
 * (--disable-features=MacWebContentsOcclusion), so we cannot rely on the
 * browser to do this for us — hence the explicit guard.
 */

const PAUSED_ATTR = 'data-anim-paused';

function shouldPause(): boolean {
  if (document.visibilityState !== 'visible' || document.hidden) return true;
  return !document.hasFocus();
}

function sync(): void {
  const root = document.documentElement;
  if (shouldPause()) root.setAttribute(PAUSED_ATTR, 'true');
  else root.removeAttribute(PAUSED_ATTR);
}

let installed = false;

/** Idempotent; safe to call from anywhere. */
export function installAnimationBudget(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;

  sync();
  document.addEventListener('visibilitychange', sync, { passive: true });
  window.addEventListener('focus', sync, { passive: true });
  window.addEventListener('blur', sync, { passive: true });

  // Resuming from a long sleep can leave focus state stale.
  window.addEventListener('pageshow', sync, { passive: true });
}

/** Exposed for tests / manual override. */
export function __setPausedForTest(paused: boolean): void {
  const root = document.documentElement;
  if (paused) root.setAttribute(PAUSED_ATTR, 'true');
  else root.removeAttribute(PAUSED_ATTR);
}
