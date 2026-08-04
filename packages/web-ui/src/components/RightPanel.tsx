import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, wsClient } from '../api.ts';
import { navBus } from '../navBus.ts';
import { PAGE } from '../routes.ts';
import { openExternal } from '../hooks/useElectron.ts';
import { ContentRenderer, resolveFormat, type HtmlSelectionData } from './ContentRenderer.tsx';
import { EmbeddedBrowser } from './EmbeddedBrowser.tsx';
import type { RightPanelPayload, RightPanelTab } from '../contexts/LayoutContext.tsx';

type TabOwner = { agentId: string; agentName: string };

function toFileUrl(filePath: string): string {
  if (/^(https?|file):\/\//i.test(filePath)) return filePath;
  // Windows: C:\foo → file:///C:/foo ; POSIX: /foo → file:///foo
  if (/^[a-zA-Z]:[\\/]/.test(filePath)) {
    return `file:///${filePath.replace(/\\/g, '/')}`;
  }
  const normalized = filePath.startsWith('/') ? filePath : `/${filePath}`;
  return `file://${normalized}`;
}

export interface ChatContextChip {
  label: string;
  content: string;
}

function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

function payloadReference(payload: RightPanelPayload): string {
  if (payload.kind === 'deliverable') return payload.deliverable.reference ?? '';
  if (payload.kind === 'url') return payload.url;
  return payload.path;
}

function payloadTitle(payload: RightPanelPayload): string {
  if (payload.kind === 'deliverable') return payload.deliverable.title || payload.deliverable.reference || '';
  if (payload.kind === 'url') return payload.title || payload.url;
  return payload.title || payload.path.split(/[/\\]/).pop() || payload.path;
}

/** Stable identity for preview reload when the active tab changes. */
function previewIdentity(payload: RightPanelPayload, tabId?: string | null): string {
  if (payload.kind === 'file') return `file:${payload.path}:${tabId ?? ''}`;
  if (payload.kind === 'url') return `url:${payload.browserId || payload.url}:${tabId ?? ''}`;
  const d = payload.deliverable;
  return `deliverable:${d.id || d.reference || d.title || 'unknown'}:${tabId ?? ''}`;
}

type PreviewState =
  | { mode: 'loading' }
  | { mode: 'content'; content: string; format: string }
  | { mode: 'image'; src: string; name: string }
  | { mode: 'audio'; src: string; name: string; mimeType: string; size?: number }
  | { mode: 'video'; src: string; name: string; mimeType: string; size?: number }
  | { mode: 'binary'; name: string; reference: string; size?: number; extension?: string }
  | { mode: 'artifact'; summary: string }
  | { mode: 'url'; url: string; browserId?: string }
  | { mode: 'unpreviewable'; reference: string; isDirectory: boolean };

function formatBytes(n?: number): string {
  if (n == null || !Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

interface SelectionToolbar {
  x: number;
  y: number;
  text: string;
  htmlMeta?: { xpath: string; cssSelector: string };
}

/**
 * Right-side resource panel: previews an agent-generated deliverable or file and
 * lets the user select content to send back to the chat as context.
 * Supports multiple tabs and a fullscreen mode that hides the chat chrome.
 */
export function RightPanel({
  payload,
  onClose,
  width,
  onResizeStart,
  onAddToChat,
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewTab,
  fullscreen,
  onToggleFullscreen,
  onBrowserMeta,
}: {
  payload: RightPanelPayload;
  onClose: () => void;
  width: number;
  onResizeStart: (e: React.MouseEvent) => void;
  onAddToChat?: (chip: ChatContextChip) => void;
  tabs?: RightPanelTab[];
  activeTabId?: string | null;
  onSelectTab?: (tabId: string) => void;
  onCloseTab?: (tabId: string) => void;
  onNewTab?: () => void;
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
  onBrowserMeta?: (browserId: string, meta: { pageId?: number; url?: string; title?: string }) => void;
}) {
  const { t } = useTranslation(['deliverables', 'agent', 'common']);
  const [preview, setPreview] = useState<PreviewState>({ mode: 'loading' });
  const [copied, setCopied] = useState(false);
  const [selectionToolbar, setSelectionToolbar] = useState<SelectionToolbar | null>(null);
  const [tabOwners, setTabOwners] = useState<Record<number, TabOwner>>({});
  const contentRef = useRef<HTMLDivElement>(null);
  const tabStripRef = useRef<HTMLDivElement>(null);
  const activeTabBtnRef = useRef<HTMLButtonElement>(null);

  // Hydrate + live-update which agent currently owns each embedded-browser pageId.
  useEffect(() => {
    let cancelled = false;
    void api.browser.tabOwnership().then(res => {
      if (cancelled) return;
      const next: Record<number, TabOwner> = {};
      for (const row of res.ownership ?? []) {
        next[row.pageId] = { agentId: row.agentId, agentName: row.agentName || row.agentId };
      }
      setTabOwners(next);
    }).catch(() => { /* endpoint may be unavailable in preview */ });

    const unsub = wsClient.on('ui:browser_ownership', (event) => {
      const p = event.payload as {
        action?: 'claimed' | 'released';
        pageId?: number;
        agentId?: string | null;
        agentName?: string | null;
      };
      if (typeof p.pageId !== 'number') return;
      setTabOwners(prev => {
        if (p.action === 'released' || !p.agentId) {
          if (!(p.pageId! in prev)) return prev;
          const next = { ...prev };
          delete next[p.pageId!];
          return next;
        }
        return {
          ...prev,
          [p.pageId!]: { agentId: p.agentId, agentName: p.agentName || p.agentId },
        };
      });
    });
    return () => { cancelled = true; unsub(); };
  }, []);

  const reference = payloadReference(payload);
  const title = payloadTitle(payload);
  // Show tabs in the chrome row when present (browser-style). Panel × collapses the panel.
  const showTabs = (tabs?.length ?? 0) >= 1;
  const contentKey = previewIdentity(payload, activeTabId);

  // Keep the active tab in view (new tabs open on the left; selecting an
  // off-screen tab also scrolls it into the strip).
  useEffect(() => {
    if (!activeTabId) return;
    const btn = activeTabBtnRef.current;
    const strip = tabStripRef.current;
    if (!btn || !strip) return;
    const id = requestAnimationFrame(() => {
      btn.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
    });
    return () => cancelAnimationFrame(id);
  }, [activeTabId, tabs?.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (fullscreen && onToggleFullscreen) onToggleFullscreen();
        else onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, fullscreen, onToggleFullscreen]);

  useEffect(() => {
    let cancelled = false;
    setSelectionToolbar(null);

    // URL tabs switch instantly — do not flash a shared "loading" skeleton that
    // makes one tab's navigation look like it blocks the whole panel.
    if (payload.kind === 'url') {
      setPreview({ mode: 'url', url: payload.url, browserId: payload.browserId });
      return () => { cancelled = true; };
    }
    if (isUrl(reference)) {
      setPreview({ mode: 'url', url: reference });
      return () => { cancelled = true; };
    }

    setPreview({ mode: 'loading' });

    // Builder artifacts have no file body — surface the summary + open-in-page.
    if (payload.kind === 'deliverable' && payload.deliverable.artifactType && payload.deliverable.artifactData) {
      setPreview({ mode: 'artifact', summary: payload.deliverable.summary || payload.deliverable.title || '' });
      return () => { cancelled = true; };
    }
    if (!reference) {
      setPreview({ mode: 'unpreviewable', reference: '', isDirectory: false });
      return () => { cancelled = true; };
    }
    const isDirectory = payload.kind === 'deliverable' && payload.deliverable.type === 'directory';
    if (isDirectory) {
      setPreview({ mode: 'unpreviewable', reference, isDirectory: true });
      return () => { cancelled = true; };
    }

    api.files.preview(reference).then((resp) => {
      if (cancelled) return;
      if (resp.type === 'image') {
        // Prefer stream URL (works for large webp/png); fall back to legacy base64 content.
        const src = resp.content
          ? `data:${resp.mimeType || 'image/png'};base64,${resp.content}`
          : (resp.streamUrl
            || (resp.path ? api.files.streamUrl(resp.path) : api.files.streamUrl(reference)));
        setPreview({ mode: 'image', src, name: resp.name || title });
        return;
      }
      if (resp.type === 'audio') {
        const src = resp.streamUrl
          || (resp.path ? api.files.streamUrl(resp.path) : api.files.streamUrl(reference));
        setPreview({ mode: 'audio', src, name: resp.name || title, mimeType: resp.mimeType || 'audio/mpeg', size: resp.size });
        return;
      }
      if (resp.type === 'video') {
        const src = resp.streamUrl
          || (resp.path ? api.files.streamUrl(resp.path) : api.files.streamUrl(reference));
        setPreview({ mode: 'video', src, name: resp.name || title, mimeType: resp.mimeType || 'video/mp4', size: resp.size });
        return;
      }
      if (resp.type === 'binary') {
        setPreview({
          mode: 'binary',
          name: resp.name || title,
          reference: resp.path || reference,
          size: resp.size,
          extension: resp.extension,
        });
        return;
      }
      if (typeof resp.content !== 'string') {
        setPreview({ mode: 'unpreviewable', reference, isDirectory: false });
        return;
      }
      const format = resolveFormat({
        format: payload.kind === 'deliverable' ? payload.deliverable.format : undefined,
        reference,
        content: resp.content,
      });
      setPreview({ mode: 'content', content: resp.content, format });
    }).catch(() => {
      if (cancelled) return;
      setPreview({ mode: 'unpreviewable', reference, isDirectory: false });
    });

    return () => { cancelled = true; };
  // Reload whenever the active tab / preview identity changes — not just payload
  // object identity (which can be sticky across tab clicks in some open paths).
  }, [contentKey, payload, reference, title]);

  const sourceLabel = title || reference;

  const buildChip = useCallback((text: string, htmlMeta?: { xpath: string; cssSelector: string }): ChatContextChip => {
    const short = text.length > 40 ? `${text.slice(0, 24)}…${text.slice(-12)}` : text;
    if (htmlMeta) {
      return {
        label: `🌐 ${short}`,
        content: [
          `[html-selection]`,
          `Text: "${text}"`,
          `CSS Selector: ${htmlMeta.cssSelector}`,
          `XPath: ${htmlMeta.xpath}`,
          reference ? `File: ${reference}` : '',
        ].filter(Boolean).join('\n'),
      };
    }
    return {
      label: `“${short}”`,
      content: `${t('deliverables:chat.selectedFrom', { defaultValue: 'Selected from' })} ${sourceLabel}:\n\n"""\n${text}\n"""`,
    };
  }, [reference, sourceLabel, t]);

  const commitSelection = useCallback((text: string, htmlMeta?: { xpath: string; cssSelector: string }) => {
    if (!text.trim() || !onAddToChat) return;
    onAddToChat(buildChip(text.trim(), htmlMeta));
    setSelectionToolbar(null);
    window.getSelection()?.removeAllRanges();
  }, [onAddToChat, buildChip]);

  const handleHtmlSelection = useCallback((data: HtmlSelectionData) => {
    if (!data.text.trim() || !onAddToChat) return;
    const iframeRect = contentRef.current?.querySelector('iframe')?.getBoundingClientRect();
    const x = (iframeRect?.left ?? 0) + data.rect.x + data.rect.width / 2;
    const y = (iframeRect?.top ?? 0) + data.rect.y;
    setSelectionToolbar({ x, y, text: data.text, htmlMeta: { xpath: data.xpath, cssSelector: data.cssSelector } });
  }, [onAddToChat]);

  // Plain-text selection inside markdown/text/json previews.
  useEffect(() => {
    const el = contentRef.current;
    if (!el || !onAddToChat) return;
    const onMouseUp = () => {
      requestAnimationFrame(() => {
        const sel = window.getSelection();
        const text = sel?.toString().trim();
        if (!text || !sel?.rangeCount) { setSelectionToolbar(null); return; }
        const range = sel.getRangeAt(0);
        if (!el.contains(range.commonAncestorContainer)) { setSelectionToolbar(null); return; }
        const rect = range.getBoundingClientRect();
        setSelectionToolbar({ x: rect.left + rect.width / 2, y: rect.top, text });
      });
    };
    const onMouseDown = (e: MouseEvent) => {
      const toolbar = document.getElementById('right-panel-selection-toolbar');
      if (toolbar && toolbar.contains(e.target as Node)) return;
      setSelectionToolbar(null);
    };
    el.addEventListener('mouseup', onMouseUp);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      el.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [onAddToChat, preview.mode]);

  const reveal = () => { api.files.reveal(reference).catch(() => {}); };
  const copyPath = () => {
    navigator.clipboard?.writeText(reference).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  /** One chrome action: deliverable → Output page; url/file → system browser (or default app). */
  const openExternally = useCallback(async () => {
    if (payload.kind === 'deliverable') {
      navBus.navigate(PAGE.DELIVERABLES, { openDeliverable: payload.deliverable.id });
      return;
    }

    if (payload.kind === 'url') {
      let target = payload.url;
      if (payload.browserId && window.markusDesktop?.browser) {
        try {
          const s = await window.markusDesktop.browser.getState(payload.browserId);
          if (s.ok) {
            if (s.directoryPath) {
              await api.system.openPath(s.directoryPath).catch(() => api.files.reveal(s.directoryPath!));
              return;
            }
            if (s.url && s.url !== 'about:blank') target = s.url;
          }
        } catch { /* fall through with payload.url */ }
      }
      if (!target || target === 'about:blank') return;
      if (/^https?:\/\//i.test(target) || /^file:\/\//i.test(target)) {
        openExternal(target);
        return;
      }
      // Local path typed into the address bar
      await api.system.openPath(target).catch(() => openExternal(toFileUrl(target)));
      return;
    }

    // file
    const path = payload.path;
    if (!path) return;
    if (/^https?:\/\//i.test(path) || /^file:\/\//i.test(path)) {
      openExternal(path);
      return;
    }
    await api.system.openPath(path).catch(() => openExternal(toFileUrl(path)));
  }, [payload]);

  const canOpenExternally = payload.kind === 'deliverable'
    ? !!payload.deliverable.id
    : payload.kind === 'url'
      ? !!(payload.url && payload.url !== 'about:blank') || !!payload.browserId
      : !!payload.path;

  const openExternallyTitle = payload.kind === 'deliverable'
    ? t('agent:deliverables.openInPage', { defaultValue: 'Open in Output' })
    : t('common:openInSystemBrowser');

  // Local path that can be revealed in Finder / Explorer (not a remote URL / embedded browser).
  const canRevealInFileBrowser = !!reference && !isUrl(reference)
    && (payload.kind === 'file' || payload.kind === 'deliverable');

  return (
    <>
      {/* Resize handle (drag left edge) — hidden in fullscreen */}
      {!fullscreen && (
        <div
          className="w-1.5 cursor-col-resize shrink-0 group relative z-10 flex items-center justify-center"
          onMouseDown={onResizeStart}
        >
          <div className="w-px h-2/3 border-l border-dashed border-transparent group-hover:border-border-default group-active:border-fg-tertiary transition-colors" />
        </div>
      )}

      <div
        className={`bg-surface-primary flex flex-col overflow-hidden ${fullscreen ? 'flex-1 min-w-0' : 'shrink-0'}`}
        style={fullscreen ? undefined : { width }}
        data-right-panel
      >
        {/* Single chrome row: tabs (or title) + panel actions — saves a header band.
            z-20 keeps chrome above panel content; native views still paint above HTML
            but must be bounds-synced only to the host below this header. */}
        <header data-electron-drag className="relative z-20 h-10 shrink-0 flex items-center gap-1 pl-1.5 pr-1.5 border-b border-border-default bg-surface-primary">
          {(showTabs || onNewTab) ? (
            <div
              data-no-drag
              ref={tabStripRef}
              role="tablist"
              className="flex-1 min-w-0 flex flex-nowrap items-center gap-0.5 overflow-x-auto overflow-y-hidden overscroll-x-contain scrollbar-thin"
              onWheel={e => {
                const el = e.currentTarget;
                if (el.scrollWidth <= el.clientWidth) return;
                if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
                el.scrollLeft += e.deltaY;
                e.preventDefault();
              }}
            >
              {tabs?.map(tab => {
                const active = tab.id === activeTabId;
                const pageId = tab.payload.kind === 'url' ? tab.payload.pageId : undefined;
                const owner = pageId != null ? tabOwners[pageId] : undefined;
                const tabTitle = owner
                  ? `${tab.title} — ${t('common:browserTabControlledBy', { name: owner.agentName })}`
                  : tab.title;
                return (
                  // Sibling buttons (never nest <button>): select + close stay independent.
                  <div
                    key={tab.id}
                    className={`group shrink-0 flex items-center max-w-[200px] rounded-md text-[11px] border transition-colors ${
                      active
                        ? owner
                          ? 'bg-brand-500/10 border-brand-500/35 text-fg-primary'
                          : 'bg-surface-elevated border-border-default text-fg-primary'
                        : owner
                          ? 'border-brand-500/25 text-fg-secondary hover:bg-brand-500/8'
                          : 'border-transparent text-fg-tertiary hover:text-fg-secondary hover:bg-surface-elevated/50'
                    }`}
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={active}
                      ref={active ? activeTabBtnRef : undefined}
                      className="min-w-0 flex-1 truncate pl-2.5 pr-1 py-1 text-left cursor-pointer flex items-center gap-1"
                      title={tabTitle}
                      onPointerDown={e => {
                        // pointerdown beats click cancellation when native views steal focus.
                        if (e.button !== 0) return;
                        onSelectTab?.(tab.id);
                      }}
                      onClick={() => onSelectTab?.(tab.id)}
                    >
                      {owner && (
                        <span
                          className="shrink-0 inline-flex items-center gap-0.5 max-w-[72px] px-1 py-px rounded text-[9px] font-semibold tracking-wide bg-brand-500/20 text-brand-500"
                          title={t('common:browserTabControlledBy', { name: owner.agentName })}
                        >
                          <span className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-pulse shrink-0" aria-hidden />
                          <span className="truncate">{owner.agentName}</span>
                        </span>
                      )}
                      <span className="truncate min-w-0">{tab.title}</span>
                    </button>
                    {onCloseTab && (
                      <button
                        type="button"
                        onPointerDown={e => {
                          if (e.button !== 0) return;
                          e.preventDefault();
                          e.stopPropagation();
                          onCloseTab(tab.id);
                        }}
                        onClick={e => {
                          e.preventDefault();
                          e.stopPropagation();
                          onCloseTab(tab.id);
                        }}
                        className={`shrink-0 mr-1 p-0.5 rounded hover:bg-surface-overlay transition-colors ${
                          active ? 'text-fg-tertiary hover:text-fg-secondary' : 'text-fg-muted hover:text-fg-secondary opacity-70 group-hover:opacity-100'
                        }`}
                        title={t('common:closeTab', { defaultValue: 'Close tab' })}
                        aria-label={t('common:closeTab', { defaultValue: 'Close tab' })}
                      >
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                      </button>
                    )}
                  </div>
                );
              })}
              {onNewTab && (
                <button
                  type="button"
                  onClick={onNewTab}
                  className="shrink-0 w-7 h-7 flex items-center justify-center rounded-md text-fg-tertiary hover:text-fg-secondary hover:bg-surface-elevated/60 transition-colors"
                  title={t('common:newTab', { defaultValue: 'New Tab' })}
                  aria-label={t('common:newTab', { defaultValue: 'New Tab' })}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button>
              )}
            </div>
          ) : (
            <span className="text-sm font-semibold text-fg-primary truncate flex-1 min-w-0 px-1.5" title={reference || title}>
              {title}
            </span>
          )}

          <div data-no-drag className="shrink-0 flex items-center gap-0.5 pl-1 border-l border-border-default/60">
            {canOpenExternally && (
              <button
                type="button"
                onClick={() => { void openExternally(); }}
                title={openExternallyTitle}
                aria-label={openExternallyTitle}
                className="w-7 h-7 flex items-center justify-center rounded-md transition-colors text-fg-tertiary hover:text-fg-secondary hover:bg-surface-elevated"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
                </svg>
              </button>
            )}
            {canRevealInFileBrowser && (
              <button
                onClick={reveal}
                title={t('detail.openInFileBrowser', { defaultValue: 'Reveal in file browser' })}
                aria-label={t('detail.openInFileBrowser', { defaultValue: 'Reveal in file browser' })}
                className="w-7 h-7 flex items-center justify-center rounded-md transition-colors text-fg-tertiary hover:text-fg-secondary hover:bg-surface-elevated"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
              </button>
            )}
            {onToggleFullscreen && (
              <button
                onClick={onToggleFullscreen}
                title={fullscreen
                  ? t('common:exitFullscreen', { defaultValue: 'Exit fullscreen' })
                  : t('common:fullscreen', { defaultValue: 'Fullscreen' })}
                className="w-7 h-7 flex items-center justify-center rounded-md transition-colors text-fg-tertiary hover:text-fg-secondary hover:bg-surface-elevated"
              >
                {fullscreen ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" /><line x1="14" y1="10" x2="21" y2="3" /><line x1="3" y1="21" x2="10" y2="14" />
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
                  </svg>
                )}
              </button>
            )}
            <button
              onClick={onClose}
              title={t('common:collapsePanel', { defaultValue: 'Hide panel' })}
              aria-label={t('common:collapsePanel', { defaultValue: 'Hide panel' })}
              className="w-7 h-7 flex items-center justify-center rounded-md transition-colors text-fg-tertiary hover:text-fg-secondary hover:bg-surface-elevated"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </header>

        <div
          key={contentKey}
          className={`flex-1 min-w-0 min-h-0 ${
            preview.mode === 'url' ? 'overflow-hidden p-2 flex flex-col' : 'overflow-auto p-4'
          }`}
        >
          {preview.mode === 'loading' && (
            <div className="animate-pulse space-y-3">
              <div className="h-4 bg-surface-overlay/60 rounded w-full" />
              <div className="h-4 bg-surface-overlay/60 rounded w-5/6" />
              <div className="h-32 bg-surface-overlay/40 rounded-lg w-full mt-2" />
              <div className="h-4 bg-surface-overlay/60 rounded w-3/4" />
            </div>
          )}

          {preview.mode === 'image' && (
            <div className="flex flex-col items-center gap-2">
              <img src={preview.src} alt={preview.name} className="max-w-full rounded-lg object-contain" />
              <span className="text-xs text-fg-tertiary">{preview.name}</span>
            </div>
          )}

          {preview.mode === 'audio' && (
            <div className="flex flex-col items-stretch gap-3 py-6">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-xl bg-brand-500/15 text-brand-500 flex items-center justify-center shrink-0">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
                  </svg>
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-medium text-fg-primary truncate">{preview.name}</div>
                  <div className="text-[11px] text-fg-tertiary mt-0.5">
                    {preview.mimeType}{preview.size != null ? ` · ${formatBytes(preview.size)}` : ''}
                  </div>
                </div>
              </div>
              <audio controls preload="metadata" src={preview.src} className="w-full" />
            </div>
          )}

          {preview.mode === 'video' && (
            <div className="flex flex-col items-stretch gap-3">
              <video controls preload="metadata" src={preview.src} className="w-full max-h-[70vh] rounded-lg bg-black" />
              <span className="text-xs text-fg-tertiary">{preview.name}{preview.size != null ? ` · ${formatBytes(preview.size)}` : ''}</span>
            </div>
          )}

          {preview.mode === 'binary' && (
            <div className="space-y-4 py-4">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-xl bg-surface-elevated text-fg-tertiary flex items-center justify-center shrink-0 text-xs font-mono uppercase">
                  {(preview.extension || 'file').replace(/^\./, '') || 'file'}
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-medium text-fg-primary truncate">{preview.name}</div>
                  <div className="text-[11px] text-fg-tertiary mt-0.5">
                    {t('detail.cannotPreview', { type: 'file', defaultValue: 'This file type cannot be previewed.' })}
                    {preview.size != null ? ` · ${formatBytes(preview.size)}` : ''}
                  </div>
                </div>
              </div>
              {preview.reference && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => { void api.files.reveal(preview.reference); }}
                    className="px-3 py-2 text-xs rounded-lg bg-brand-600/20 text-brand-500 hover:bg-brand-600/30 transition-colors"
                  >
                    {t('detail.openInFileBrowser', { defaultValue: 'Reveal in file browser' })}
                  </button>
                </div>
              )}
            </div>
          )}

          {preview.mode === 'content' && (
            <div ref={contentRef} className="min-w-0 max-w-full break-words [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_img]:max-w-full">
              <ContentRenderer
                content={preview.content}
                format={preview.format}
                className="text-fg-secondary text-sm"
                onHtmlSelection={handleHtmlSelection}
                basePath={reference ? reference.replace(/[/\\][^/\\]+$/, '') : undefined}
              />
            </div>
          )}

          {preview.mode === 'artifact' && (
            <div ref={contentRef} className="min-w-0 max-w-full break-words [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_img]:max-w-full">
              <ContentRenderer content={preview.summary} format="markdown" className="text-fg-secondary text-sm" />
            </div>
          )}

          {preview.mode === 'url' && (
            <div className="flex-1 min-h-0 min-w-0 w-full flex flex-col">
              {/* key forces per-tab React state (address/loading) — native view is already per browserId */}
              <EmbeddedBrowser
                key={preview.browserId || preview.url}
                url={preview.url}
                browserId={preview.browserId}
                className="flex-1 min-h-0"
                onMeta={preview.browserId && onBrowserMeta
                  ? (meta) => onBrowserMeta(preview.browserId!, meta)
                  : undefined}
              />
            </div>
          )}

          {preview.mode === 'unpreviewable' && (
            <div className="space-y-3">
              <p className="text-sm text-fg-secondary">
                {preview.isDirectory
                  ? t('detail.cannotPreview', { type: 'directory', defaultValue: 'This item cannot be previewed here.' })
                  : t('detail.cannotPreview', { type: 'file', defaultValue: 'This file cannot be previewed here.' })}
              </p>
              {preview.reference && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={reveal}
                    className="text-xs bg-surface-elevated px-3 py-2 rounded text-brand-500 hover:underline flex-1 truncate text-left cursor-pointer font-mono"
                    title={t('detail.openInFileBrowser', { defaultValue: 'Reveal in file browser' })}
                  >{preview.reference}</button>
                  <button onClick={reveal} className="px-3 py-2 text-xs rounded-lg bg-brand-600/20 text-brand-500 hover:bg-brand-600/30 transition-colors shrink-0">
                    {t('common:open', { defaultValue: 'Open' })}
                  </button>
                  <button onClick={copyPath} className={`px-3 py-2 text-xs rounded-lg transition-colors shrink-0 ${copied ? 'bg-green-500/20 text-green-600' : 'bg-surface-overlay/50 text-fg-secondary hover:bg-surface-overlay'}`}>
                    {copied ? t('common:copied', { defaultValue: 'Copied' }) : t('common:copy', { defaultValue: 'Copy' })}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Selection toolbar → send to chat */}
      {selectionToolbar && onAddToChat && (
        <div
          id="right-panel-selection-toolbar"
          className="fixed z-50 -translate-x-1/2 -translate-y-full bg-surface-elevated border border-border-default rounded-lg shadow-xl overflow-hidden"
          style={{ left: selectionToolbar.x, top: selectionToolbar.y - 8 }}
        >
          <button
            onMouseDown={e => { e.preventDefault(); e.stopPropagation(); commitSelection(selectionToolbar.text, selectionToolbar.htmlMeta); }}
            className="px-3 py-1.5 text-xs text-fg-secondary hover:bg-surface-overlay hover:text-fg-primary transition-colors flex items-center gap-1.5 whitespace-nowrap"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            {t('deliverables:contextMenu.addToConversation', { defaultValue: 'Add to conversation' })}
          </button>
        </div>
      )}
    </>
  );
}
