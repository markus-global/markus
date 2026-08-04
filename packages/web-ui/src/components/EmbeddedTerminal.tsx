import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { resolvePathAgainstBase } from './markdown-links.ts';
import { rememberTerminalId } from '../lib/known-terminals.ts';

export type TerminalSelectionPayload = {
  text: string;
  x: number;
  y: number;
};

type Props = {
  terminalId: string;
  title?: string;
  cwd?: string;
  active?: boolean;
  onMeta?: (terminalId: string, patch: { title?: string; cwd?: string }) => void;
  onSelection?: (payload: TerminalSelectionPayload | null) => void;
  onOpenUrl?: (url: string) => void;
  onOpenPath?: (path: string) => void;
  /** Imperative handle registration for parent shortcuts (Cmd+Shift+A, recent output). */
  apiRef?: React.MutableRefObject<EmbeddedTerminalApi | null>;
};

export type EmbeddedTerminalApi = {
  getSelection: () => string;
  getRecentOutput: (maxLines?: number) => Promise<string>;
  focus: () => void;
  findNext: (query: string) => void;
  clearSelection: () => void;
};

function readCssVar(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

/** Cmd on macOS / Ctrl elsewhere — same gesture as VS Code / iTerm path opens. */
function isOpenModifier(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  const isMac = typeof navigator !== 'undefined'
    && navigator.platform.toUpperCase().includes('MAC');
  return isMac ? e.metaKey : e.ctrlKey;
}

function looksLikeFilePath(text: string): boolean {
  if (!text || text.includes(' ') || /^https?:\/\//i.test(text)) return false;
  if (/^[a-zA-Z]:[\\/]/.test(text)) return true;
  if (text.startsWith('/') || text.startsWith('~/') || text.startsWith('./') || text.startsWith('../')) {
    return true;
  }
  // Relative path or bare name with a file extension (resolved against cwd on open).
  return /^[\w./\\-]+\.[a-zA-Z0-9]{1,8}$/.test(text);
}

/** Absolute / ~/ stay as-is; relative & bare names require a real cwd (not `/`). */
function resolveTerminalPath(raw: string, cwd?: string): string | null {
  const path = raw.trim().replace(/\\/g, '/');
  if (!path || !looksLikeFilePath(path)) return null;
  if (/^[a-zA-Z]:\//.test(path) || path.startsWith('~/')) return path;
  if (path.startsWith('/')) {
    // Classic bad join when spawn cwd was filesystem root: `/packages/...`.
    // Re-resolve as a project-relative path against the live shell cwd.
    if (/^\/packages\//.test(path)) {
      if (!cwd || cwd === '/') return null;
      return resolvePathAgainstBase(path.slice(1), cwd);
    }
    return path;
  }
  // Relative path — need a usable working directory (home or project, never bare `/`).
  if (!cwd || cwd === '/') return null;
  return resolvePathAgainstBase(path, cwd);
}

function hasUsableSize(el: HTMLElement): boolean {
  return el.clientWidth >= 16 && el.clientHeight >= 16;
}

/**
 * Interactive PTY terminal hosted in the Team Chat right panel (Desktop only).
 */
export function EmbeddedTerminal({
  terminalId,
  title,
  cwd,
  active = true,
  onMeta,
  onSelection,
  onOpenUrl,
  onOpenPath,
  apiRef,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const onMetaRef = useRef(onMeta);
  const onSelectionRef = useRef(onSelection);
  const onOpenUrlRef = useRef(onOpenUrl);
  const onOpenPathRef = useRef(onOpenPath);
  const cwdRef = useRef(cwd);
  onMetaRef.current = onMeta;
  onSelectionRef.current = onSelection;
  onOpenUrlRef.current = onOpenUrl;
  onOpenPathRef.current = onOpenPath;
  // Only adopt an explicit usable prop cwd — never clobber a live OSC-7 cwd with undefined/`/`.
  useEffect(() => {
    if (cwd && cwd !== '/') cwdRef.current = cwd;
  }, [cwd]);

  const [error, setError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [hasNewBelow, setHasNewBelow] = useState(false);
  const stickBottomRef = useRef(true);

  const safeFit = useCallback(() => {
    const el = hostRef.current;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!el || !term || !fit || !hasUsableSize(el)) return false;
    try {
      fit.fit();
      return true;
    } catch {
      return false;
    }
  }, []);

  const jumpToBottom = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    term.scrollToBottom();
    stickBottomRef.current = true;
    setHasNewBelow(false);
  }, []);

  useEffect(() => {
    rememberTerminalId(terminalId);
    const el = hostRef.current;
    const api = window.markusDesktop?.terminal;
    if (!el) return;
    if (!api) {
      setError('Embedded terminal requires Markus Desktop.');
      return;
    }

    let disposed = false;
    let term: Terminal | null = null;
    let ro: ResizeObserver | null = null;
    let unsubData: (() => void) | undefined;
    let unsubExit: (() => void) | undefined;
    let unsubCwd: (() => void) | undefined;
    let onDataDisp: { dispose: () => void } | null = null;
    let onScrollDisp: { dispose: () => void } | null = null;
    let onSelDisp: { dispose: () => void } | null = null;
    let bootTimer: number | null = null;

    const boot = async () => {
      if (disposed || !hostRef.current) return;
      if (!hasUsableSize(hostRef.current)) {
        // Panel may still be laying out — retry until we have real dimensions.
        bootTimer = window.setTimeout(() => { void boot(); }, 50);
        return;
      }

      const bg = readCssVar('--color-surface-primary', '#0f1419');
      const fg = readCssVar('--color-fg-primary', '#e7e9ea');
      term = new Terminal({
        cursorBlink: true,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        fontSize: 13,
        lineHeight: 1.25,
        allowProposedApi: true,
        theme: {
          background: bg,
          foreground: fg,
          cursor: readCssVar('--color-brand-500', '#3b82f6'),
          selectionBackground: 'rgba(59, 130, 246, 0.35)',
        },
      });
      const fit = new FitAddon();
      const search = new SearchAddon();
      const links = new WebLinksAddon((event, uri) => {
        if (!isOpenModifier(event)) return;
        onOpenUrlRef.current?.(uri);
      });
      term.loadAddon(fit);
      term.loadAddon(search);
      term.loadAddon(links);
      term.open(hostRef.current);
      termRef.current = term;
      fitRef.current = fit;
      searchRef.current = search;

      if (!safeFit()) {
        try { fit.fit(); } catch { /* ignore */ }
      }

      term.registerLinkProvider({
        provideLinks: (y, callback) => {
          const line = term!.buffer.active.getLine(y - 1);
          if (!line) { callback(undefined); return; }
          const text = line.translateToString(true);
          // Abs / ~/ paths (any), or relative/bare paths that include a file extension.
          const re = /(?:(?:[A-Za-z]:|\/|~\/)[\w./\\-]+|(?:\.\.?\/)?[\w./\\-]+\.[a-zA-Z0-9]{1,8})/g;
          const linksOut: Array<{
            range: { start: { x: number; y: number }; end: { x: number; y: number } };
            text: string;
            decorations: { pointerCursor: boolean; underline: boolean };
            activate: (event: MouseEvent) => void;
          }> = [];
          let m: RegExpExecArray | null;
          while ((m = re.exec(text))) {
            const path = m[0];
            if (!looksLikeFilePath(path)) continue;
            // Skip bare names when we have no cwd to resolve against.
            if (!resolveTerminalPath(path, cwdRef.current)) continue;
            linksOut.push({
              range: {
                start: { x: m.index + 1, y },
                end: { x: m.index + path.length, y },
              },
              text: path,
              // Always underline clickable paths; open still requires Cmd/Ctrl+click.
              decorations: { pointerCursor: true, underline: true },
              activate: (event: MouseEvent) => {
                if (!isOpenModifier(event)) return;
                const resolved = resolveTerminalPath(path, cwdRef.current);
                if (!resolved) return;
                onOpenPathRef.current?.(resolved);
              },
            });
          }
          callback(linksOut.length ? linksOut : undefined);
        },
      });

      try {
        const cols = Math.max(term.cols || 80, 2);
        const rows = Math.max(term.rows || 24, 1);
        // Prefer home (main-process default). Ignore a stale `/` from earlier builds.
        let createCwd = cwd || cwdRef.current;
        if (!createCwd || createCwd === '/') {
          try {
            createCwd = await window.markusDesktop?.getDefaultCwd?.();
          } catch { /* fall through — main process defaultCwd */ }
        }
        if (createCwd === '/') createCwd = undefined;
        if (createCwd) cwdRef.current = createCwd;
        const created = await api.create(terminalId, { cwd: createCwd, title, cols, rows });
        if (disposed) return;
        if (!created.ok) {
          setError(created.error || 'Failed to create terminal');
          return;
        }
        if (created.info) {
          if (created.info.cwd) cwdRef.current = created.info.cwd;
          onMetaRef.current?.(terminalId, { title: created.info.title, cwd: created.info.cwd });
        }
        const buf = await api.getBuffer(terminalId, { maxChars: 120_000 });
        if (disposed) return;
        if (buf.ok && buf.content) {
          term.write(buf.content);
        }
        // Do not call select() here — it used to re-emit events that stole panel mode.
        safeFit();
        void api.resize(terminalId, term.cols, term.rows);
        term.focus();
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
        return;
      }

      unsubData = api.onData?.((event) => {
        if (event.id !== terminalId || !termRef.current) return;
        termRef.current.write(event.data);
        if (!stickBottomRef.current) setHasNewBelow(true);
      });
      // Live cwd from OSC 7 (updated on cd) — keep path resolution accurate.
      unsubCwd = api.onEvent?.((event) => {
        if (event.id !== terminalId || event.type !== 'cwd' || !event.cwd) return;
        cwdRef.current = event.cwd;
        onMetaRef.current?.(terminalId, { cwd: event.cwd });
      });
      // Exit is handled globally (close tab / replace sole shell) — don't paint a dead prompt here.
      unsubExit = api.onExit?.(() => { /* LayoutContext.handleTerminalExit */ });

      onDataDisp = term.onData((data) => {
        void api.write(terminalId, data);
      });

      onScrollDisp = term.onScroll(() => {
        const t = termRef.current;
        if (!t) return;
        const buffer = t.buffer.active;
        const nearBottom = buffer.viewportY >= buffer.baseY - 1;
        stickBottomRef.current = nearBottom;
        if (nearBottom) setHasNewBelow(false);
      });

      onSelDisp = term.onSelectionChange(() => {
        const t = termRef.current;
        const host = hostRef.current;
        if (!t || !host) return;
        const text = t.getSelection().trim();
        if (!text) {
          onSelectionRef.current?.(null);
          return;
        }
        // Wait one frame so xterm's selection layer is painted, then anchor to it.
        requestAnimationFrame(() => {
          const termNow = termRef.current;
          const hostNow = hostRef.current;
          if (!termNow || !hostNow) return;
          const latest = termNow.getSelection().trim();
          if (!latest) {
            onSelectionRef.current?.(null);
            return;
          }
          let x: number;
          let y: number;
          const selNodes = hostNow.querySelectorAll('.xterm-selection div');
          let top = Infinity;
          let left = Infinity;
          let right = -Infinity;
          selNodes.forEach(node => {
            const r = (node as HTMLElement).getBoundingClientRect();
            if (r.width < 1 && r.height < 1) return;
            top = Math.min(top, r.top);
            left = Math.min(left, r.left);
            right = Math.max(right, r.right);
          });
          if (top < Infinity) {
            x = (left + right) / 2;
            y = top;
          } else {
            const pos = termNow.getSelectionPosition?.();
            const screen = hostNow.querySelector('.xterm-screen') as HTMLElement | null;
            const screenRect = (screen ?? hostNow).getBoundingClientRect();
            const cols = Math.max(termNow.cols, 1);
            const rows = Math.max(termNow.rows, 1);
            const cellW = screenRect.width / cols;
            const cellH = screenRect.height / rows;
            if (pos) {
              const viewportY = termNow.buffer.active.viewportY;
              const relRow = Math.max(0, pos.start.y - viewportY);
              x = screenRect.left + (pos.start.x + 0.5) * cellW;
              y = screenRect.top + relRow * cellH;
            } else {
              x = screenRect.left + screenRect.width / 2;
              y = screenRect.top + 12;
            }
          }
          onSelectionRef.current?.({ text: latest, x, y });
        });
      });

      ro = new ResizeObserver(() => {
        if (!safeFit() || !termRef.current) return;
        void api.resize(terminalId, termRef.current.cols, termRef.current.rows);
      });
      ro.observe(hostRef.current);

      if (apiRef) {
        apiRef.current = {
          getSelection: () => termRef.current?.getSelection() ?? '',
          getRecentOutput: async (maxLines = 80) => {
            const res = await api.getBuffer(terminalId, { maxLines });
            return res.ok ? (res.content || '') : '';
          },
          focus: () => termRef.current?.focus(),
          findNext: (query: string) => { searchRef.current?.findNext(query); },
          clearSelection: () => termRef.current?.clearSelection(),
        };
      }
    };

    void boot();

    return () => {
      disposed = true;
      if (bootTimer != null) window.clearTimeout(bootTimer);
      unsubData?.();
      unsubExit?.();
      unsubCwd?.();
      onDataDisp?.dispose();
      onScrollDisp?.dispose();
      onSelDisp?.dispose();
      ro?.disconnect();
      if (apiRef) apiRef.current = null;
      try { term?.dispose(); } catch { /* ignore */ }
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
  // Mount once per terminalId — callbacks via refs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId]);

  useEffect(() => {
    if (!active) return;
    // Focus + refit only; avoid select() IPC (mode-steal / event storms).
    const id = window.requestAnimationFrame(() => {
      safeFit();
      const term = termRef.current;
      if (term) {
        void window.markusDesktop?.terminal?.resize(terminalId, term.cols, term.rows);
        term.focus();
      }
    });
    return () => window.cancelAnimationFrame(id);
  }, [active, terminalId, safeFit]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!active) return;
      const isMac = navigator.platform.toUpperCase().includes('MAC');
      const mod = isMac ? (e.metaKey && !e.ctrlKey) : (e.ctrlKey && !e.metaKey);
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
        const t = e.target;
        if (t instanceof HTMLElement && (hostRef.current?.contains(t) || t.closest('.xterm'))) {
          e.preventDefault();
          setSearchOpen(true);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  return (
    <div className="relative flex-1 min-h-0 flex flex-col rounded-lg overflow-hidden border border-border-default bg-surface-primary">
      {searchOpen && (
        <div className="shrink-0 flex items-center gap-1.5 px-2 py-1.5 border-b border-border-default bg-surface-elevated">
          <input
            autoFocus
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault();
                searchRef.current?.findNext(searchQuery);
              } else if (e.key === 'Escape') {
                setSearchOpen(false);
              }
            }}
            placeholder="Find in terminal…"
            className="flex-1 min-w-0 text-xs bg-transparent outline-none text-fg-primary placeholder:text-fg-muted"
          />
          <button
            type="button"
            className="text-[11px] px-2 py-0.5 rounded text-fg-secondary hover:bg-surface-overlay"
            onClick={() => searchRef.current?.findNext(searchQuery)}
          >
            Next
          </button>
          <button
            type="button"
            className="text-[11px] px-2 py-0.5 rounded text-fg-tertiary hover:bg-surface-overlay"
            onClick={() => setSearchOpen(false)}
          >
            Esc
          </button>
        </div>
      )}
      {error ? (
        <div className="flex-1 flex items-center justify-center p-4 text-sm text-red-500">{error}</div>
      ) : (
        <div
          ref={hostRef}
          className="flex-1 min-h-0 w-full h-full [&_.xterm]:h-full [&_.xterm]:w-full [&_.xterm-viewport]:overflow-auto"
        />
      )}
      {hasNewBelow && (
        <button
          type="button"
          onClick={jumpToBottom}
          className="absolute bottom-3 right-3 z-10 text-[11px] px-2.5 py-1 rounded-md bg-brand-600 text-white shadow-lg hover:bg-brand-500"
        >
          ↓ Jump to bottom
        </button>
      )}
    </div>
  );
}
