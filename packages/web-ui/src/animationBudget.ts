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

/**
 * The classes that actually *read* a phase value. The attribute is written on
 * each of these instead of on <html>.
 *
 * Why it matters: the phase values are custom properties, and custom properties
 * inherit. Writing them at the root means every write is a potential style
 * invalidation for the entire document — on a 4 900-node transcript, 4 writes a
 * second cost ~82 ms of style recalculation per 4 s even though only a handful
 * of nodes care. Written on the consumers themselves, the same 16 writes cost
 * ~7 ms, because the invalidation stops at a leaf.
 *
 * Why classes and not a compound selector: `document.querySelectorAll('.a, .b,
 * .c, .d, .e')` has to match every element against five selectors. At 42 500
 * nodes that measured 2.36 ms per call, i.e. ~9.4 ms/s of pure element lookup at
 * 4 Hz — against 0.008 ms/s for the attribute writes that are the actual work.
 * `getElementsByClassName` is an index hit and measures ~0.
 *
 * Keep this list in sync with the `[data-anim-tick]` block in index.css. The
 * `tick scoping` test in animationBudget.test.ts mounts one of each and fails if
 * a consumer is missing here.
 */
const TICK_CLASSES = [
  'animate-pulse',
  'animate-spin',
  'animate-bounce',
  'activity-text-shimmer',
  'exec-card-active',
];

/** Selector form, for tests/diagnostics only — the tick does not use it. */
export const TICK_SELECTOR = TICK_CLASSES.map(c => `.${c}`).join(', ');

function shouldPause(): boolean {
  return document.visibilityState !== 'visible' || document.hidden;
}

let tickTimer: number | null = null;
let tickPhase = 0;

function startTicking(): void {
  if (tickTimer !== null) return;
  tickPhase = tickPhase % TICK_PHASES;
  applyPhase();
  tickTimer = window.setInterval(() => {
    tickPhase = (tickPhase + 1) % TICK_PHASES;
    applyPhase();
  }, TICK_INTERVAL_MS);
}

/**
 * Stamp the current phase on the consumers.
 *
 * Re-derived every tick on purpose: React mounts and unmounts indicators
 * constantly, and a cached list would go stale the moment a turn starts. But the
 * derivation must be an index lookup, not a document scan — see TICK_CLASSES.
 * `getElementsByClassName` returns a live collection, which is why this reads it
 * fresh on every tick without re-querying.
 */
function applyPhase(): void {
  const phase = String(tickPhase);
  for (const cls of TICK_CLASSES) {
    const live = document.getElementsByClassName(cls);
    for (let i = 0; i < live.length; i++) live[i].setAttribute(TICK_ATTR, phase);
  }
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
  tickPhase = phase % TICK_PHASES;
  applyPhase();
}
