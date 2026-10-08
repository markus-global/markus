/**
 * Animation budget guard — two jobs, both about *frame production*.
 *
 * Measured on the desktop build (renderer process, window visible, CDP attached):
 *
 *   ‣ JS is NOT the cost. A 20s V8 profile: 90% idle, largest JS frame 0.34%,
 *     ScriptDuration ~0.2–1.7%. Layout is trivial (2 layouts / 15s).
 *   ‣ But while the status indicators animate, the main thread runs a FULL STYLE
 *     RECALCULATION every frame: RecalcStyleCount = 120.0/s — exactly the ProMotion
 *     refresh rate. TaskDuration = 12–16% of one core. With those animations
 *     stopped: RecalcStyleCount = 0.0/s, TaskDuration ~1%.
 *     (Measured with the count-based metric, which is immune to CPU-sampling noise
 *     and to whether agents happen to be busy.)
 *   ‣ Quantising the CSS (`animation-timing-function: steps(…)`) does NOT help:
 *     95–107 recalcs/s vs 115 baseline. Promoting to compositor layers does NOT
 *     help either — will-change, contain:paint and backface-visibility all stayed
 *     at 120/s. Only *not running a CSS animation* removes the per-frame recalc.
 *
 * Conclusion: an always-on CSS animation costs a whole-frame style recalc forever,
 * even when every animated property is transform/opacity, and even if the value only
 * changes a few times per second. The only lever that works is to stop asking the
 * compositor for frames at all.
 *
 * Job 1 — no frames while the page is not on screen (`data-anim-paused`).
 *         Measured: visible 33% -> hidden 0.4%.
 *
 *         The predicate is `visibilityState === 'hidden'` and NOTHING ELSE. It used to
 *         also include `!document.hasFocus()` — which is unsound here. The Team Chat side
 *         panel is an Electron WebContentsView (desktop/embedded-browser.ts), so its
 *         document is unfocused whenever the user's focus is anywhere else in the SAME
 *         app, even though the panel is fully visible. `data-anim-paused` was therefore
 *         stuck true for the entire life of the panel, freezing every animation inside it:
 *         the live-turn ring kept painting its conic gradient, but `border-rotate` stayed
 *         parked at 0deg, so a running turn looked dead while its text kept streaming in.
 *
 *         "Is this page on screen?" is a question Chromium already answers — for occlusion,
 *         minimise and tab-switch alike. Ask it. Do not rehearse the answer with focus.
 *
 * Job 2 — for the *persistent* indicators (agent "thinking/running" labels, busy
 *         dots, active execution cards), replace the infinite CSS animation with a
 *         low-frequency discrete state driven from JS (`data-anim-tick`,
 *         4 updates/sec). Same "it's alive" feel, ~4 restyles/sec instead of 120.
 */

const PAUSED_ATTR = 'data-anim-paused';
const TICK_ATTR = 'data-anim-tick';

/** 8 phases x 250ms = a 2s cycle, 4 state updates per second. */
const TICK_PHASES = 8;
const TICK_INTERVAL_MS = 250;

function shouldPause(): boolean {
  return document.visibilityState !== 'visible' || document.hidden;
}

let tickTimer: number | null = null;
let tickPhase = 0;

function startTicking(): void {
  if (tickTimer !== null) return;
  tickPhase = tickPhase % TICK_PHASES;
  document.documentElement.setAttribute(TICK_ATTR, String(tickPhase));
  tickTimer = window.setInterval(() => {
    tickPhase = (tickPhase + 1) % TICK_PHASES;
    document.documentElement.setAttribute(TICK_ATTR, String(tickPhase));
  }, TICK_INTERVAL_MS);
}

function stopTicking(): void {
  if (tickTimer === null) return;
  window.clearInterval(tickTimer);
  tickTimer = null;
}

function sync(): void {
  const root = document.documentElement;
  if (shouldPause()) {
    root.setAttribute(PAUSED_ATTR, 'true');
    stopTicking();
  } else {
    root.removeAttribute(PAUSED_ATTR);
    startTicking();
  }
}

let installed = false;

/** Idempotent; safe to call from anywhere. */
export function installAnimationBudget(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;

  sync();
  document.addEventListener('visibilitychange', sync, { passive: true });

  // Resuming from a long sleep can leave the visibility state stale.
  window.addEventListener('pageshow', sync, { passive: true });
}

/** Exposed for tests / manual override. */
export function __setPausedForTest(paused: boolean): void {
  const root = document.documentElement;
  if (paused) {
    root.setAttribute(PAUSED_ATTR, 'true');
    stopTicking();
  } else {
    root.removeAttribute(PAUSED_ATTR);
    startTicking();
  }
}

/** Exposed for tests / manual override. */
export function __setTickForTest(phase: number): void {
  document.documentElement.setAttribute(TICK_ATTR, String(phase % TICK_PHASES));
}
