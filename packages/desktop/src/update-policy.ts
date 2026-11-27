/**
 * Pure update-policy layer — deliberately free of Electron imports so it can be
 * unit-tested in the `node` vitest project (the desktop package has no DOM and
 * importing `electron` outside a running app throws).
 *
 * `updater.ts` owns IO (timers, IPC broadcast, electron-updater wiring) and
 * delegates every state transition to {@link reduceUpdateState}. That split
 * exists for one reason: the update lifecycle is a state machine, and the only
 * thing worth asserting about it is the transitions — not that some event
 * listener was registered.
 */

export type UpdatePhase = 'idle' | 'checking' | 'downloading' | 'ready' | 'error';

export interface UpdateState {
  phase: UpdatePhase;
  /** Version being downloaded / ready to install. Null until an update is found. */
  version: string | null;
  /** Download progress 0–100, or null when not downloading. */
  percent: number | null;
  /**
   * macOS only: the bundle is not in /Applications, so Squirrel.Mac cannot swap
   * it (the app runs translocated from the DMG or from a read-only location).
   * The download is still valid — the user just has to move the app first.
   */
  requiresMoveToApplications: boolean;
  error: string | null;
}

export type UpdateEvent =
  | { type: 'checking' }
  | { type: 'available'; version: string }
  | { type: 'not-available' }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded'; version: string }
  | { type: 'location-blocked' }
  | { type: 'error'; message: string };

/** First check after launch — long enough not to compete with startup work. */
export const INITIAL_CHECK_DELAY_MS = 10_000;
/** Healthy cadence between checks (4h). */
export const BASE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** A failing updater must not retry forever at full rate — cap at 24h. */
export const MAX_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function initialUpdateState(): UpdateState {
  return {
    phase: 'idle',
    version: null,
    percent: null,
    requiresMoveToApplications: false,
    error: null,
  };
}

/** Clamp a raw electron-updater percentage into a renderable integer 0–100. */
export function normalizePercent(percent: number): number {
  // NaN must not read as "complete" (NaN would clamp to 0 either way, but the
  // explicit guard documents the intent); Infinity legitimately means finished.
  if (Number.isNaN(percent)) return 0;
  return Math.min(100, Math.max(0, Math.round(percent)));
}

/**
 * The single writer of update state.
 *
 * Invariants worth keeping (each one is asserted in the tests):
 *  1. A downloaded update is terminal: a later failed check must NOT downgrade
 *     `ready` back to `error`, otherwise a transient network blip hides an
 *     update the user could install right now.
 *  2. `progress` after `downloaded` is ignored — electron-updater can emit a
 *     trailing progress frame before the downloaded event settles.
 *  3. `checking` never clears an already-downloaded version.
 */
export function reduceUpdateState(state: UpdateState, event: UpdateEvent): UpdateState {
  switch (event.type) {
    case 'checking':
      if (state.phase === 'ready') return state;
      return { ...state, phase: 'checking', error: null };

    case 'available':
      if (state.phase === 'ready') return state;
      return { ...state, phase: 'downloading', version: event.version, percent: 0, error: null };

    case 'progress': {
      if (state.phase === 'ready') return state;
      return { ...state, phase: 'downloading', percent: normalizePercent(event.percent) };
    }

    case 'downloaded':
      return { ...state, phase: 'ready', version: event.version, percent: 100, error: null };

    case 'location-blocked':
      return { ...state, requiresMoveToApplications: true };

    case 'not-available':
      if (state.phase === 'ready') return state;
      return { ...state, phase: 'idle', version: null, percent: null, error: null };

    case 'error':
      if (state.phase === 'ready') return state;
      return { ...state, phase: 'error', percent: null, error: event.message };
  }
}

/**
 * Exponential backoff for the check loop: 4h → 8h → 16h → 24h (capped).
 * Without this a permanently broken feed retries every 4h forever, which turns
 * a silent failure into a permanent log and battery drain.
 */
export function nextCheckIntervalMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return BASE_CHECK_INTERVAL_MS;
  const backoff = BASE_CHECK_INTERVAL_MS * 2 ** Math.min(consecutiveFailures, 8);
  return Math.min(backoff, MAX_CHECK_INTERVAL_MS);
}

/**
 * Whether the electron-updater path should run at all.
 *
 *  - MAS builds: Apple owns updates (Guideline 2.4.5) — never self-update, and
 *    electron-updater's Squirrel.Mac path is unusable inside the sandbox.
 *  - Unpackaged runs (`electron .` in dev): there is no `app-update.yml` feed,
 *    so every check would throw `ENOENT` and pollute logs with a fake failure.
 */
export function shouldStartUpdater(options: { isMas: boolean; isPackaged: boolean }): boolean {
  return !options.isMas && options.isPackaged;
}

/** True when the UI should offer "restart to update" instead of a download link. */
export function isActionablePhase(phase: UpdatePhase): boolean {
  return phase === 'downloading' || phase === 'ready';
}
