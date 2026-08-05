import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api as httpApi } from '../api.ts';
import {
  isNativeBrowserOverlayActive,
  isNativeBrowserPagePaintAllowed,
} from '../lib/nativeBrowserOverlay.ts';
import { normalizeBrowserUrl } from '../lib/browserUrl.ts';

/**
 * Electron-only embedded browser host.
 *
 * Renders a placeholder div whose screen rect is synced to a native
 * WebContentsView via IPC. Outside Electron, falls back to an external-open UI.
 *
 * When `browserId` is provided (layout/agent-owned page), reuses that native
 * view and does not destroy it on unmount (panel collapse keeps the session).
 */
export function EmbeddedBrowser({
  url,
  browserId: externalBrowserId,
  className,
  onMeta,
}: {
  url: string;
  browserId?: string;
  className?: string;
  /** Sync native pageId (and optional url/title) back to the right-panel tab model. */
  onMeta?: (meta: { pageId?: number; url?: string; title?: string }) => void;
}) {
  const { t } = useTranslation('common');
  const reactId = useId().replace(/:/g, '');
  const browserId = externalBrowserId || `eb_${reactId}`;
  /** Ephemeral preview without a stable layout browserId — destroy on unmount. */
  const ownsView = !externalBrowserId;
  const hostRef = useRef<HTMLDivElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const directoryPathRef = useRef<string | null>(null);
  const [address, setAddress] = useState(url === 'about:blank' ? '' : url);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [directoryPath, setDirectoryPath] = useState<string | null>(null);
  const [openingFolder, setOpeningFolder] = useState(false);
  const api = typeof window !== 'undefined' ? window.markusDesktop?.browser : undefined;
  const platform = typeof window !== 'undefined' ? window.markusDesktop?.platform : undefined;
  directoryPathRef.current = directoryPath;

  const folderAppLabel =
    platform === 'darwin' ? t('browserFolderAppFinder')
      : platform === 'win32' ? t('browserFolderAppExplorer')
        : t('browserFolderAppGeneric');

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void (async () => {
      const s = await api.getState(browserId);
      if (cancelled) return;
      if (!s.ok) {
        setIsLoading(true);
        await api.create(browserId, url);
      } else if (url && s.url !== url && !s.directoryPath) {
        setIsLoading(true);
        await api.navigate(browserId, url);
      } else if (url && s.directoryPath && s.url !== url) {
        // Re-navigate when the tab URL changed (including another directory).
        await api.navigate(browserId, url);
      }
      if (cancelled) return;
      const state = await api.getState(browserId);
      if (cancelled || !state.ok) return;
      if (document.activeElement !== addressRef.current) {
        setAddress(state.url && state.url !== 'about:blank' ? state.url : (url === 'about:blank' ? '' : url));
      }
      setIsLoading(!!state.isLoading);
      setLoadError(state.loadError ?? null);
      setDirectoryPath(state.directoryPath ?? null);
      if (state.pageId != null || state.url || state.title) {
        onMeta?.({
          pageId: state.pageId,
          url: state.url && state.url !== 'about:blank' ? state.url : undefined,
          title: state.title || undefined,
        });
      }
    })();
    return () => {
      cancelled = true;
      if (ownsView) void api.destroy(browserId);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, browserId, url, ownsView]);

  // Blank tabs: focus the address bar so the user can type immediately.
  useEffect(() => {
    if (url !== 'about:blank') return;
    const t = window.setTimeout(() => {
      addressRef.current?.focus();
      addressRef.current?.select();
    }, 0);
    return () => clearTimeout(t);
  }, [url, browserId]);

  // Prefer page events for snappy loading UX (poll remains for back/forward).
  useEffect(() => {
    if (!api?.onPageEvent) return;
    return api.onPageEvent((event) => {
      if (event.browserId !== browserId) return;
      if (event.type === 'directory') {
        setDirectoryPath(event.directoryPath || null);
        setIsLoading(false);
        setLoadError(null);
        if (event.url && document.activeElement !== addressRef.current) {
          setAddress(event.url);
        }
        return;
      }
      if (event.type === 'loading') {
        setIsLoading(true);
        setLoadError(null);
        setDirectoryPath(null);
        return;
      }
      if (event.type === 'loaded') {
        setIsLoading(false);
        if (directoryPathRef.current) return;
        if (event.url && document.activeElement !== addressRef.current) {
          setAddress(event.url === 'about:blank' ? '' : event.url);
        }
        // After load, re-sync host bounds so a freshly painted WebContentsView
        // is not stuck blank until the next unrelated layout change.
        window.dispatchEvent(new Event('markus:embedded-browser-resync'));
        return;
      }
      if (event.type === 'load-failed') {
        setIsLoading(false);
        if (directoryPathRef.current) return;
        setLoadError(event.error || 'Load failed');
        if (event.url && document.activeElement !== addressRef.current) {
          setAddress(event.url === 'about:blank' ? '' : event.url);
        }
        return;
      }
      if (event.type === 'navigated' && event.url && document.activeElement !== addressRef.current) {
        if (!directoryPathRef.current) {
          setAddress(event.url === 'about:blank' ? '' : event.url);
        }
      }
    });
  }, [api, browserId]);

  useEffect(() => {
    if (!api || !hostRef.current) return;
    const el = hostRef.current;
    let alive = true;

    // Team (and other pages) stay mounted via CSS visibility:hidden. Native
    // WebContentsView ignores that, so never sync bounds from a hidden host.
    const hostPageActive = () => {
      let node: HTMLElement | null = el;
      while (node) {
        const style = getComputedStyle(node);
        if (style.visibility === 'hidden' || style.display === 'none') return false;
        node = node.parentElement;
      }
      return true;
    };

    const sync = () => {
      if (!alive) return;
      // Page leave / panel collapse / HTML modals / folder prompt — hide native paint.
      if (
        !isNativeBrowserPagePaintAllowed()
        || !hostPageActive()
        || isNativeBrowserOverlayActive()
        || !!directoryPathRef.current
      ) {
        void api.setBounds(browserId, { x: 0, y: 0, width: 0, height: 0 }, false);
        return;
      }
      const rect = el.getBoundingClientRect();
      void api.setBounds(browserId, {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      }, rect.width > 2 && rect.height > 2);
    };

    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    window.addEventListener('resize', sync);
    window.addEventListener('scroll', sync, true);
    window.addEventListener('markus:embedded-browser-resync', sync);
    window.addEventListener('markus:native-browser-overlay', sync);
    window.addEventListener('markus:native-browser-page', sync);

    const poll = setInterval(() => {
      if (!alive) return;
      void api.getState(browserId).then(s => {
        if (!alive || !s.ok) return;
        const dir = s.directoryPath ?? null;
        setDirectoryPath(dir);
        if (s.url && document.activeElement !== addressRef.current) {
          // Keep showing the folder file:// URL while in directory mode.
          if (dir || s.url !== 'about:blank') {
            setAddress(s.url === 'about:blank' ? '' : s.url);
          }
        }
        setCanGoBack(!!s.canGoBack);
        setCanGoForward(!!s.canGoForward);
        setIsLoading(!!s.isLoading);
        if (s.loadError !== undefined) setLoadError(dir ? null : (s.loadError ?? null));
      });
    }, 800);

    // Hard refresh can tear down the renderer before React effect cleanups run;
    // hide this view immediately so it doesn't linger over the reloaded UI.
    const onPageHide = () => {
      void api.setBounds(browserId, { x: 0, y: 0, width: 0, height: 0 }, false);
    };
    window.addEventListener('pagehide', onPageHide);

    return () => {
      alive = false;
      ro.disconnect();
      window.removeEventListener('resize', sync);
      window.removeEventListener('scroll', sync, true);
      window.removeEventListener('markus:embedded-browser-resync', sync);
      window.removeEventListener('markus:native-browser-overlay', sync);
      window.removeEventListener('markus:native-browser-page', sync);
      window.removeEventListener('pagehide', onPageHide);
      clearInterval(poll);
      void api.setBounds(browserId, { x: 0, y: 0, width: 0, height: 0 }, false);
    };
  }, [api, browserId]);

  // Re-sync bounds whenever folder mode toggles (hide/show native view).
  useEffect(() => {
    window.dispatchEvent(new Event('markus:embedded-browser-resync'));
  }, [directoryPath]);

  if (!api) {
    return (
      <div className={`space-y-3 ${className ?? ''}`}>
        <p className="text-sm text-fg-secondary break-all">{url}</p>
        <button
          onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
          className="px-3 py-2 text-xs rounded-lg bg-brand-600/20 text-brand-500 hover:bg-brand-600/30 transition-colors"
        >
          Open in browser
        </button>
      </div>
    );
  }

  return (
    <div className={`flex flex-col h-full min-h-0 min-w-0 w-full ${className ?? ''}`}>
      <div className="shrink-0 relative mb-2">
        <div className="flex items-center gap-1 px-2 py-1.5 border border-border-default rounded-lg bg-surface-elevated">
          <button
            disabled={!canGoBack}
            onClick={() => void api.action(browserId, 'back')}
            className="w-7 h-7 flex items-center justify-center rounded-md text-fg-tertiary hover:bg-surface-overlay disabled:opacity-30"
            title="Back"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6" /></svg>
          </button>
          <button
            disabled={!canGoForward}
            onClick={() => void api.action(browserId, 'forward')}
            className="w-7 h-7 flex items-center justify-center rounded-md text-fg-tertiary hover:bg-surface-overlay disabled:opacity-30"
            title="Forward"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6" /></svg>
          </button>
          <button
            onClick={() => {
              if (isLoading) void api.action(browserId, 'stop');
              else void api.action(browserId, 'reload');
            }}
            className="w-7 h-7 flex items-center justify-center rounded-md text-fg-tertiary hover:bg-surface-overlay"
            title={isLoading ? 'Stop' : 'Reload'}
          >
            {isLoading ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-spin">
                <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
            )}
          </button>
          <form
            className="flex-1 min-w-0"
            onSubmit={e => {
              e.preventDefault();
              let next = address.trim();
              if (!next) return;
              next = normalizeBrowserUrl(next);
              setIsLoading(true);
              setLoadError(null);
              setDirectoryPath(null);
              void api.navigate(browserId, next);
              setAddress(next);
            }}
          >
            <input
              ref={addressRef}
              value={address}
              onChange={e => setAddress(e.target.value)}
              placeholder={t('browserUrlPlaceholder')}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              className="w-full px-2 py-1 text-xs bg-surface-primary border border-border-default rounded-md text-fg-primary outline-none focus:border-brand-500"
            />
          </form>
          {isLoading && (
            <span className="shrink-0 text-[10px] text-fg-tertiary px-1 select-none">{t('browserLoading')}</span>
          )}
          {api.openDevTools && (
            <button
              type="button"
              onClick={() => void api.openDevTools?.(browserId)}
              className="w-7 h-7 flex items-center justify-center rounded-md text-fg-tertiary hover:bg-surface-overlay shrink-0"
              title={t('browserGuestDevTools')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
              </svg>
            </button>
          )}
        </div>
        {/* Indeterminate progress while the native view loads */}
        <div
          className={`absolute left-2 right-2 bottom-0 h-0.5 overflow-hidden rounded-full transition-opacity ${
            isLoading ? 'opacity-100' : 'opacity-0'
          }`}
          aria-hidden={!isLoading}
        >
          <div className="h-full w-1/3 bg-brand-500 animate-[browser-load_1.1s_ease-in-out_infinite]" />
        </div>
      </div>
      {loadError && !isLoading && !directoryPath && (
        <div className="shrink-0 mb-2 px-2.5 py-1.5 text-[11px] text-amber-600 dark:text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg">
          {loadError}
        </div>
      )}
      {/* Native WebContentsView paints over this host (hidden while showing folder prompt). */}
      <div
        ref={hostRef}
        className="flex-1 min-h-0 min-w-0 w-full rounded-lg border border-border-default bg-surface-elevated/30 overflow-hidden"
      >
        {directoryPath && (
          <div className="h-full w-full flex flex-col items-center justify-center gap-4 px-6 text-center">
            <div className="w-12 h-12 rounded-2xl bg-surface-elevated border border-border-default flex items-center justify-center text-fg-secondary">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" strokeLinejoin="round" />
              </svg>
            </div>
            <div className="space-y-1.5 max-w-md">
              <p className="text-sm font-medium text-fg-primary">
                {t('browserFolderTitle')}
              </p>
              <p className="text-xs text-fg-tertiary break-all">{directoryPath}</p>
            </div>
            <button
              type="button"
              disabled={openingFolder}
              onClick={() => {
                setOpeningFolder(true);
                void httpApi.system.openPath(directoryPath)
                  .catch(() => httpApi.files.reveal(directoryPath))
                  .finally(() => setOpeningFolder(false));
              }}
              className="px-3.5 py-2 text-xs rounded-lg bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white transition-colors"
            >
              {openingFolder ? t('browserFolderOpening') : t('browserFolderOpen', { app: folderAppLabel })}
            </button>
          </div>
        )}
      </div>
      <style>{`
        @keyframes browser-load {
          0% { transform: translateX(-120%); }
          100% { transform: translateX(360%); }
        }
      `}</style>
    </div>
  );
}
