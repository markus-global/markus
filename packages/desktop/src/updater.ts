import { app, BrowserWindow } from 'electron';
import { compareVersions } from '@markus/shared';
import { setAppQuitting } from './app-lifecycle.js';
import {
  INITIAL_CHECK_DELAY_MS,
  channelNameFor,
  channelPolicy,
  initialUpdateState,
  nextCheckIntervalMs,
  reduceUpdateState,
  resolveUpdaterSupport,
  type UpdateEvent,
  type UpdateState,
} from './update-policy.js';

/**
 * The single IO shell around electron-updater.
 *
 * Everything here is wiring; every decision lives in `update-policy.ts` so it
 * can be tested without launching Electron. Do NOT add a second caller of
 * `electron-updater` anywhere else (the menu used to import it directly and
 * bypassed this state machine — that is exactly the "two writers" shape we are
 * removing).
 */

/** Minimal structural type of the bits we use, so we never import at module load. */
interface AutoUpdaterHandle {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  autoRunAppAfterInstall: boolean;
  /** Feed channel: `latest` for stable builds, `rc` for candidates. */
  channel: string;
  /** Follow the prerelease channel (GitHub provider only; harmless with generic). */
  allowPrerelease: boolean;
  logger: unknown;
  on(event: string, listener: (...args: never[]) => void): void;
  checkForUpdates(): Promise<{ updateInfo?: { version?: string } } | null>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

let state: UpdateState = initialUpdateState();
let updater: AutoUpdaterHandle | null = null;
let consecutiveFailures = 0;
let checkTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;

export function getUpdateState(): UpdateState {
  return state;
}

function log(message: string): void {
  // `MARKUS_UPDATE_DEBUG=1` is a permanent, switchable diagnostic facility (not
  // a temporary probe): when a user reports "update never arrives", this is the
  // only way to see which stage failed on their machine.
  if (process.env['MARKUS_UPDATE_DEBUG'] === '1') {
    // console.warn rather than console.log: the lint config allows warn/error
    // only, and this channel is diagnostics, not product output.
    console.warn(`[updater] ${message}`);
  }
}

function broadcast(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send('update:state', state);
  }
}

function publish(event: UpdateEvent): void {
  const next = reduceUpdateState(state, event);
  if (next === state) return; // no-op transitions must not wake the renderer
  state = next;
  log(`state → ${state.phase}${state.version ? ` v${state.version}` : ''}${state.percent !== null ? ` ${state.percent}%` : ''}${state.error ? ` (${state.error})` : ''}`);
  broadcast();
}

/**
 * macOS cannot swap a bundle that is not in /Applications: Squirrel.Mac fails
 * when the app runs translocated from a mounted DMG. We surface it instead of
 * letting the install fail silently at quit time.
 */
function isOutsideApplicationsFolder(): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    return app.isInApplicationsFolder() === false;
  } catch {
    return false;
  }
}

function scheduleNextCheck(delayMs: number): void {
  if (checkTimer) clearTimeout(checkTimer);
  checkTimer = setTimeout(() => {
    checkTimer = null;
    void runCheck();
  }, delayMs);
  // Never keep the process alive just to poll for updates.
  checkTimer.unref?.();
}

async function runCheck(): Promise<void> {
  if (!updater) return;
  const policy = channelPolicy(app.getVersion());
  try {
    publish({ type: 'checking' });
    let settled = false;
    if (policy.probeStableFirst) {
      // Graduation: a candidate must be able to leave the candidate channel once
      // the final X.Y.Z ships, so probe the STABLE feed (`latest-mac.yml`) first
      // and only fall back to the candidate feed (`rc-mac.yml`) when stable is
      // not newer. Two different feed files, one directory, no tag juggling.
      updater.channel = 'latest';
      updater.allowPrerelease = false;
      const stable = await updater.checkForUpdates();
      const stableVersion = stable?.updateInfo?.version;
      settled = !!stableVersion && compareVersions(stableVersion, app.getVersion()) > 0;
      if (settled) {
        log(`graduating from candidate to stable v${stableVersion}`);
      } else {
        updater.channel = 'rc';
        updater.allowPrerelease = true;
      }
    }
    if (!settled) await updater.checkForUpdates();
    consecutiveFailures = 0;
  } catch (err) {
    consecutiveFailures += 1;
    const message = err instanceof Error ? err.message : String(err);
    log(`check failed (${consecutiveFailures}): ${message}`);
    publish({ type: 'error', message });
  }
  scheduleNextCheck(nextCheckIntervalMs(consecutiveFailures));
}

/** Manual "Check for Updates…" — resolves once the check settles. */
export async function checkForUpdatesNow(): Promise<UpdateState> {
  if (!updater) {
    return { ...state, error: state.error ?? 'updater-unavailable' };
  }
  await runCheck();
  return state;
}

export interface InstallResult {
  ok: boolean;
  error?: 'updater-unavailable' | 'no-update-ready' | 'move-to-applications-required';
}

/**
 * Restart into the downloaded update. `isSilent=false` shows the installer UI
 * where the platform has one; `isForceRunAfter=true` relaunches the app so the
 * user lands back where they were.
 */
export function installUpdateNow(): InstallResult {
  if (!updater) return { ok: false, error: 'updater-unavailable' };
  if (state.phase !== 'ready') return { ok: false, error: 'no-update-ready' };
  if (state.requiresMoveToApplications) return { ok: false, error: 'move-to-applications-required' };
  log('install requested by user → quitAndInstall');
  // Mark the app as quitting BEFORE Electron starts terminating. The main window
  // hides itself on 'close' while `isAppQuitting()` is false, so without this the
  // window disappears into the tray and the process keeps running — which looks
  // exactly like "the restart button does nothing" (observed on 0.12.5-rc.1).
  try {
    setAppQuitting(true);
  } catch (err) {
    log(`could not mark app as quitting: ${String(err)}`);
  }
  // Defer so the IPC reply reaches the renderer before the window goes away.
  setImmediate(() => {
    try {
      updater?.quitAndInstall(false, true);
    } catch (err) {
      // Never leave the app marked as quitting if the installer refused to start:
      // that would make the close button stop working.
      try { setAppQuitting(false); } catch { /* ignore */ }
      publish({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  });
  // Permanent diagnostic: if the process is still alive this long after asking the
  // installer to run, the quit path was blocked by something in the app.
  setTimeout(() => log('still alive 5s after quitAndInstall — quit path blocked'), 5000).unref?.();
  return { ok: true };
}

async function start(): Promise<void> {
  const support = resolveUpdaterSupport({
    platform: process.platform,
    isMas: process.env['MARKUS_MAS'] === 'true',
    isPackaged: app.isPackaged,
    // electron-updater only updates Linux via AppImageUpdater, which needs this
    // to know which file to replace. A deb/rpm install has no writable AppImage.
    appImagePath: process.env['APPIMAGE'],
  });
  if (!support.supported) {
    log(`skipped: ${support.reason}`);
    return;
  }

  const mod = await import('electron-updater');
  const candidate = (mod.autoUpdater ?? (mod as unknown as { default?: { autoUpdater?: AutoUpdaterHandle } }).default?.autoUpdater) as
    | AutoUpdaterHandle
    | undefined;
  if (!candidate || typeof candidate.checkForUpdates !== 'function') {
    console.warn('[updater] electron-updater unavailable — auto-update disabled');
    return;
  }
  updater = candidate;

  if (process.env['MARKUS_UPDATE_DEBUG'] === '1') {
    updater.logger = console;
  }

  // Download in the background for everyone; whether it installs without asking
  // is the channel policy's call (candidates wait for an explicit restart).
  const policy = channelPolicy(app.getVersion());
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = policy.installOnQuit;
  updater.autoRunAppAfterInstall = true;
  updater.allowPrerelease = policy.isPrerelease;
  updater.channel = channelNameFor(policy);
  log(`channel: ${updater.channel}, installOnQuit=${policy.installOnQuit} (v${app.getVersion()})`);

  updater.on('checking-for-update', () => publish({ type: 'checking' }));
  updater.on('update-available', ((info: { version: string }) => {
    publish({ type: 'available', version: info.version });
  }) as (...args: never[]) => void);
  updater.on('update-not-available', () => publish({ type: 'not-available' }));
  updater.on('download-progress', ((progress: { percent: number }) => {
    publish({ type: 'progress', percent: progress.percent });
  }) as (...args: never[]) => void);
  updater.on('update-downloaded', ((info: { version: string }) => {
    publish({ type: 'downloaded', version: info.version });
    if (isOutsideApplicationsFolder()) {
      log('downloaded but bundle is outside /Applications — install will need a move');
      publish({ type: 'location-blocked' });
    }
  }) as (...args: never[]) => void);
  updater.on('error', ((err: Error) => {
    consecutiveFailures += 1;
    publish({ type: 'error', message: err.message });
  }) as (...args: never[]) => void);

  scheduleNextCheck(INITIAL_CHECK_DELAY_MS);
}

/**
 * Idempotent: the first call starts the updater, later calls are no-ops. Safe to
 * call from every window-creation path.
 */
export function setupAutoUpdater(): void {
  if (started) return;
  started = true;
  void start().catch((err: unknown) => {
    console.error('[updater] failed to start:', err instanceof Error ? err.message : String(err));
  });
}
