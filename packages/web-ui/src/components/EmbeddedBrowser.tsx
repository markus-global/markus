import { useEffect, useId, useRef, useState } from 'react';
import {
  isNativeBrowserOverlayActive,
  isNativeBrowserPagePaintAllowed,
} from '../lib/nativeBrowserOverlay.ts';

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
}: {
  url: string;
  browserId?: string;
  className?: string;
}) {
  const reactId = useId().replace(/:/g, '');
  const browserId = externalBrowserId || `eb_${reactId}`;
  /** Ephemeral preview without a stable layout browserId — destroy on unmount. */
  const ownsView = !externalBrowserId;
  const hostRef = useRef<HTMLDivElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const [address, setAddress] = useState(url === 'about:blank' ? '' : url);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const api = typeof window !== 'undefined' ? window.markusDesktop?.browser : undefined;

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void (async () => {
      const s = await api.getState(browserId);
      if (cancelled) return;
      if (!s.ok) {
        await api.create(browserId, url);
      } else if (url && s.url !== url) {
        await api.navigate(browserId, url);
      }
      if (!cancelled && document.activeElement !== addressRef.current) {
        setAddress(!s.ok || url === 'about:blank' ? (url === 'about:blank' ? '' : url) : (s.url && s.url !== 'about:blank' ? s.url : ''));
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
      // Page leave / panel collapse / HTML modals — never paint above other pages.
      if (!isNativeBrowserPagePaintAllowed() || !hostPageActive() || isNativeBrowserOverlayActive()) {
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
        if (s.url && document.activeElement !== addressRef.current) {
          setAddress(s.url === 'about:blank' ? '' : s.url);
        }
        setCanGoBack(!!s.canGoBack);
        setCanGoForward(!!s.canGoForward);
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
      <div className="shrink-0 flex items-center gap-1 px-2 py-1.5 border border-border-default rounded-lg bg-surface-elevated mb-2">
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
          onClick={() => void api.action(browserId, 'reload')}
          className="w-7 h-7 flex items-center justify-center rounded-md text-fg-tertiary hover:bg-surface-overlay"
          title="Reload"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
        </button>
        <form
          className="flex-1 min-w-0"
          onSubmit={e => {
            e.preventDefault();
            let next = address.trim();
            if (!next) return;
            if (next !== 'about:blank' && !/^https?:\/\//i.test(next)) next = `https://${next}`;
            void api.navigate(browserId, next);
            setAddress(next);
          }}
        >
          <input
            ref={addressRef}
            value={address}
            onChange={e => setAddress(e.target.value)}
            placeholder="Enter a URL"
            className="w-full px-2 py-1 text-xs bg-surface-primary border border-border-default rounded-md text-fg-primary outline-none focus:border-brand-500"
          />
        </form>
      </div>
      {/* Native WebContentsView is painted over this host rect */}
      <div ref={hostRef} className="flex-1 min-h-0 min-w-0 w-full rounded-lg border border-border-default bg-surface-elevated/30" />
    </div>
  );
}
