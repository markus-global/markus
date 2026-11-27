import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Desktop update notice — the user-facing end of the auto-update chain.
 *
 * Why this component exists (2026-11-27): the desktop app has had
 * `electron-updater` wired with `autoDownload = true` for a while, but no
 * renderer ever subscribed to its events, so a downloaded update was invisible.
 * The only "update available" UI was a banner fed by the *server's* npm-registry
 * version check pointing at the website — i.e. two different facts answering the
 * same question, and the user only ever saw the useless one.
 *
 * Ownership is now split by surface, not by case:
 *   • Electron packaged build → this component (main process is the single writer
 *     of the update state; we only render it).
 *   • Browser / MAS build → `hasDesktopUpdater()` is false and App keeps the
 *     legacy "new version on the website" banner, because there is genuinely no
 *     native installer to drive there.
 */

export type DesktopUpdatePhase = 'idle' | 'checking' | 'downloading' | 'ready' | 'error';

export interface DesktopUpdateState {
  phase: DesktopUpdatePhase;
  version: string | null;
  percent: number | null;
  /** macOS: bundle lives outside /Applications, so Squirrel cannot swap it. */
  requiresMoveToApplications: boolean;
  error: string | null;
}

const DISMISS_KEY = 'markus_native_update_dismissed';

/**
 * True only when the main process can actually download and install an update.
 * MAS builds report `isMAS` and are excluded on purpose: Apple owns updates
 * there (and Squirrel.Mac cannot run inside the sandbox).
 */
export function hasDesktopUpdater(api: MarkusDesktopAPI | undefined = window.markusDesktop): boolean {
  if (!api) return false;
  if (api.isMAS) return false;
  return typeof api.onUpdateState === 'function' && typeof api.installUpdate === 'function';
}

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

export function UpdateNotice(): ReactElement | null {
  const { t } = useTranslation('common');
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);
  const [installError, setInstallError] = useState<string | null>(null);

  useEffect(() => {
    const api = window.markusDesktop;
    if (!api || !hasDesktopUpdater(api)) return;
    let cancelled = false;
    // Read once for the case where the download finished before this mounted,
    // then follow the stream. Both write the same state object shape.
    api.getUpdateState?.()
      .then((initial) => { if (!cancelled && initial) setState(initial); })
      .catch(() => { /* main process not ready yet — the event stream will catch up */ });
    const off = api.onUpdateState?.((next) => setState(next));
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  const dismiss = useCallback(() => {
    const version = state?.version ?? null;
    setDismissed(version);
    try {
      if (version) localStorage.setItem(DISMISS_KEY, version);
    } catch { /* private mode — dismissal just won't survive a restart */ }
  }, [state]);

  const install = useCallback(() => {
    setInstallError(null);
    window.markusDesktop?.installUpdate?.()
      .then((result) => { if (!result?.ok) setInstallError(result?.error ?? 'unknown'); })
      .catch(() => setInstallError('unknown'));
  }, []);

  if (!state || state.version === null) return null;
  // `error` is deliberately silent: a failed background check must not nag a
  // user who never asked for an update. Diagnose with MARKUS_UPDATE_DEBUG=1.
  if (state.phase !== 'downloading' && state.phase !== 'ready') return null;
  if (dismissed === state.version) return null;

  const { version, percent, requiresMoveToApplications } = state;
  const isReady = state.phase === 'ready';

  return (
    <div className="flex items-center justify-between px-4 py-2 bg-brand-500/10 border-b border-brand-500/30 text-brand-400 text-sm shrink-0">
      <span className="text-xs">
        {requiresMoveToApplications
          ? t('update.moveToApplications')
          : isReady
            ? t('update.ready', { version })
            : t('update.downloading', { version, percent: percent ?? 0 })}
        {installError && <span className="ml-2 text-amber-500">{t('update.restartFailed')}</span>}
      </span>
      <span className="flex items-center gap-3 shrink-0">
        {isReady && !requiresMoveToApplications && (
          <button
            type="button"
            onClick={install}
            className="px-3 py-1 bg-brand-600 hover:bg-brand-500 text-on-brand text-xs rounded-lg transition-colors"
          >
            {t('update.restart')}
          </button>
        )}
        <button type="button" onClick={dismiss} className="text-fg-tertiary hover:text-fg-secondary text-xs shrink-0">
          {t('dismiss')}
        </button>
      </span>
    </div>
  );
}
