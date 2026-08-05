import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { DeliverableInfo } from '../api.ts';
import { forgetTerminalId, rememberTerminalId } from '../lib/known-terminals.ts';
import { isEphemeralAuthBrowserUrl } from '../lib/browserAuthUrl.ts';

/**
 * Payload describing what the right-side panel should display.
 * Extend this union as new previewable content types are supported.
 */
export type RightPanelPayload =
  | { kind: 'deliverable'; deliverable: DeliverableInfo; sourceMessageId?: string }
  | { kind: 'file'; path: string; title?: string; sourceMessageId?: string }
  | { kind: 'url'; url: string; title?: string; browserId?: string; pageId?: number }
  | { kind: 'terminal'; terminalId: string; cwd?: string; title?: string };

export type RightPanelMode = 'browser' | 'terminal';

/** Keyboard focus zone for H/L pane navigation: L0 app rail ↔ L1 ↔ L2 (Team) ↔ content. */
export type KeyboardPane = 'l0' | 'l1' | 'l2' | 'content';

export interface RightPanelTab {
  id: string;
  title: string;
  payload: RightPanelPayload;
  pinned?: boolean;
}

const RIGHT_PANEL_STORAGE_KEY = 'markus_right_panel_v1';

type PersistedRightPanel = {
  mode: RightPanelMode;
  browserTabs: RightPanelTab[];
  browserActiveId: string | null;
  /** Terminal tabs restored as fresh shells (cwd/title only — no scrollback). */
  terminalTabs: Array<{ id: string; title: string; cwd?: string }>;
  terminalActiveId: string | null;
  /**
   * Panel was collapsed (tabs live in last*Ref with empty visible state).
   * Without this, persist wrote [] and Cmd+R wiped every stashed tab.
   */
  browserCollapsed?: boolean;
  terminalCollapsed?: boolean;
};

const MAX_RIGHT_PANEL_TABS = 10;

/** After user/agent closes a native browser tab, ignore briefly-late opened/selected events. */
const browserReopenSuppressUntil = new Map<string, number>();

export function suppressBrowserTabReopen(browserId: string, ms = 3000): void {
  browserReopenSuppressUntil.set(browserId, Date.now() + ms);
}

export function isBrowserTabReopenSuppressed(browserId: string): boolean {
  const until = browserReopenSuppressUntil.get(browserId);
  if (until == null) return false;
  if (Date.now() > until) {
    browserReopenSuppressUntil.delete(browserId);
    return false;
  }
  return true;
}

export function isTerminalPayload(payload: RightPanelPayload): boolean {
  return payload.kind === 'terminal';
}

export function isBrowserPoolPayload(payload: RightPanelPayload): boolean {
  return payload.kind !== 'terminal';
}

function payloadKey(payload: RightPanelPayload): string {
  if (payload.kind === 'file') return `file:${payload.path}`;
  if (payload.kind === 'url') return `url:${payload.browserId || payload.url}`;
  if (payload.kind === 'terminal') return `terminal:${payload.terminalId}`;
  const d = payload.deliverable;
  // Prefer stable ids; fall back to reference+title so distinct markdown
  // deliverables with the same generic title don't collapse into one tab.
  return `deliverable:${d.id || `${d.reference || ''}|${d.title || ''}|${d.summary?.slice(0, 48) || ''}` || 'unknown'}`;
}

function payloadTitle(payload: RightPanelPayload): string {
  if (payload.kind === 'deliverable') {
    return payload.deliverable.title || payload.deliverable.reference || 'Deliverable';
  }
  if (payload.kind === 'url') {
    return payload.title || payload.url;
  }
  if (payload.kind === 'terminal') {
    return payload.title || 'Terminal';
  }
  return payload.title || payload.path.split(/[/\\]/).pop() || payload.path;
}

function newTabId(): string {
  return `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function evictOverLimit(tabs: RightPanelTab[]): RightPanelTab[] {
  let next = tabs;
  while (next.length > MAX_RIGHT_PANEL_TABS) {
    let idx = -1;
    for (let i = next.length - 1; i >= 0; i--) {
      if (!next[i]!.pinned) { idx = i; break; }
    }
    if (idx < 0) break;
    const evicted = next[idx];
    if (evicted) {
      destroyBrowserIfNeeded(evicted.payload);
      destroyTerminalIfNeeded(evicted.payload);
    }
    next = next.filter((_, i) => i !== idx);
  }
  return next;
}

function destroyBrowserIfNeeded(payload: RightPanelPayload | undefined) {
  if (payload?.kind === 'url' && payload.browserId) {
    suppressBrowserTabReopen(payload.browserId);
    void window.markusDesktop?.browser?.destroy(payload.browserId);
  }
}

function destroyTerminalIfNeeded(payload: RightPanelPayload | undefined) {
  if (payload?.kind === 'terminal' && payload.terminalId) {
    forgetTerminalId(payload.terminalId);
    void window.markusDesktop?.terminal?.destroy(payload.terminalId);
  }
}

function serializeBrowserTab(tab: RightPanelTab): RightPanelTab | null {
  const p = tab.payload;
  if (p.kind === 'terminal') return null;
  if (p.kind === 'url') {
    // Never persist Magic / OAuth login tabs — stale auth.magic.link?params=
    // URLs restore as white "Not found" pages and re-trigger login loops.
    if (isEphemeralAuthBrowserUrl(p.url || '') || isEphemeralAuthBrowserUrl(p.title || '')) {
      return null;
    }
    // Drop native browserId — a fresh one is minted on restore.
    return {
      id: tab.id,
      title: tab.title,
      pinned: tab.pinned,
      payload: { kind: 'url', url: p.url || 'about:blank', title: p.title || tab.title },
    };
  }
  if (p.kind === 'file') {
    return {
      id: tab.id,
      title: tab.title,
      pinned: tab.pinned,
      payload: { kind: 'file', path: p.path, title: p.title },
    };
  }
  // deliverable — keep snapshot for reopen
  return {
    id: tab.id,
    title: tab.title,
    pinned: tab.pinned,
    payload: { kind: 'deliverable', deliverable: p.deliverable },
  };
}

function hydrateBrowserTab(tab: RightPanelTab, index = 0): RightPanelTab {
  if (tab.payload.kind === 'url') {
    const browserId = `eb_${Date.now().toString(36)}_${index.toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    return {
      ...tab,
      payload: {
        kind: 'url',
        url: tab.payload.url || 'about:blank',
        title: tab.payload.title || tab.title,
        browserId,
      },
    };
  }
  return tab;
}

function loadPersistedRightPanel(): PersistedRightPanel | null {
  try {
    const raw = localStorage.getItem(RIGHT_PANEL_STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as PersistedRightPanel;
    if (!data || (data.mode !== 'browser' && data.mode !== 'terminal')) return null;
    if (!Array.isArray(data.browserTabs)) return null;
    return data;
  } catch {
    return null;
  }
}

function buildInitialRightPanelState(): {
  mode: RightPanelMode;
  browserTabs: RightPanelTab[];
  browserActiveId: string | null;
  terminalTabs: RightPanelTab[];
  terminalActiveId: string | null;
  /** Full browser tab list for lastBrowserTabsRef (even when panel starts collapsed). */
  stashedBrowserTabs: RightPanelTab[];
  stashedBrowserActiveId: string | null;
  stashedTerminalTabs: RightPanelTab[];
  stashedTerminalActiveId: string | null;
} {
  const empty = {
    mode: 'browser' as RightPanelMode,
    browserTabs: [] as RightPanelTab[],
    browserActiveId: null as string | null,
    terminalTabs: [] as RightPanelTab[],
    terminalActiveId: null as string | null,
    stashedBrowserTabs: [] as RightPanelTab[],
    stashedBrowserActiveId: null as string | null,
    stashedTerminalTabs: [] as RightPanelTab[],
    stashedTerminalActiveId: null as string | null,
  };
  const saved = loadPersistedRightPanel();
  if (!saved) return empty;

  const hydratedBrowserTabs = saved.browserTabs
    .map((t, i) => {
      try { return hydrateBrowserTab(t, i); } catch { return null; }
    })
    .filter((t): t is RightPanelTab => {
      if (!t || t.payload.kind === 'terminal') return false;
      if (t.payload.kind === 'url' && isEphemeralAuthBrowserUrl(t.payload.url || '')) return false;
      return true;
    });

  const stashedBrowserActiveId = hydratedBrowserTabs.some(t => t.id === saved.browserActiveId)
    ? saved.browserActiveId
    : (hydratedBrowserTabs[0]?.id ?? null);

  // Fresh shells with remembered cwd/title (no PTY scrollback).
  const hydratedTerminalTabs: RightPanelTab[] = (saved.terminalTabs || []).map((t, i) => {
    const terminalId = `term_${Date.now().toString(36)}_${i.toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    rememberTerminalId(terminalId);
    return {
      id: t.id || newTabId(),
      title: t.title || 'Terminal',
      payload: {
        kind: 'terminal' as const,
        terminalId,
        title: t.title || 'Terminal',
        cwd: t.cwd,
      },
    };
  });

  const stashedTerminalActiveId = hydratedTerminalTabs.some(t => t.id === saved.terminalActiveId)
    ? saved.terminalActiveId
    : (hydratedTerminalTabs[0]?.id ?? null);

  const browserCollapsed = !!saved.browserCollapsed && hydratedBrowserTabs.length > 0;
  const terminalCollapsed = !!saved.terminalCollapsed && hydratedTerminalTabs.length > 0;

  const browserTabs = browserCollapsed ? [] : hydratedBrowserTabs;
  const browserActiveId = browserCollapsed ? null : stashedBrowserActiveId;
  const terminalTabs = terminalCollapsed ? [] : hydratedTerminalTabs;
  const terminalActiveId = terminalCollapsed ? null : stashedTerminalActiveId;

  let mode: RightPanelMode = saved.mode;
  if (mode === 'terminal' && terminalTabs.length === 0 && !terminalCollapsed) mode = 'browser';
  if (mode === 'browser' && browserTabs.length === 0 && terminalTabs.length > 0) mode = 'terminal';

  return {
    mode,
    browserTabs,
    browserActiveId,
    terminalTabs,
    terminalActiveId,
    stashedBrowserTabs: hydratedBrowserTabs,
    stashedBrowserActiveId,
    stashedTerminalTabs: hydratedTerminalTabs,
    stashedTerminalActiveId,
  };
}

export interface LayoutContextValue {
  /** Unified collapse command for the left sidebars (L0 app rail + L1/L2 team panels). */
  leftCollapsed: boolean;
  setLeftCollapsed: (v: boolean) => void;
  toggleLeftCollapsed: () => void;

  /**
   * Keyboard focus zone: L0 app rail ↔ page L1 ↔ L2 (when present) ↔ content.
   * H moves left; L moves right.
   */
  keyboardPane: KeyboardPane;
  setKeyboardPane: (pane: KeyboardPane) => void;
  /** Focused page id while keyboardPane === 'l0' (may differ from the active route while browsing). */
  l0FocusPageId: string | null;
  setL0FocusPageId: (pageId: string | null) => void;

  /** Right-side content panel (preview / selection-to-agent). */
  rightPanelMode: RightPanelMode;
  setRightPanelMode: (mode: RightPanelMode) => void;
  /** Switch mode and ensure the target pool has a visible tab (restore or create). */
  switchRightPanelMode: (mode: RightPanelMode) => void;
  rightPanel: RightPanelPayload | null;
  rightPanelOpen: boolean;
  rightPanelTabs: RightPanelTab[];
  activeRightPanelTabId: string | null;
  openRightPanel: (payload: RightPanelPayload) => void;
  closeRightPanel: () => void;
  closeRightPanelTab: (tabId: string) => void;
  setActiveRightPanelTab: (tabId: string) => void;
  /** Update url/title/pageId for an embedded-browser tab (navigation sync). */
  updateRightPanelBrowserTab: (browserId: string, patch: { url?: string; title?: string; pageId?: number }) => void;
  /** Update title/cwd for an embedded-terminal tab. */
  updateRightPanelTerminalTab: (terminalId: string, patch: { title?: string; cwd?: string }) => void;
  /** Toggle browser-mode right panel (Cmd/Ctrl+L). */
  toggleRightPanel: () => void;
  /** Toggle terminal-mode right panel (Cmd/Ctrl+J). */
  toggleTerminalPanel: () => void;
  /** Collapse the panel if open; never opens / restores (unlike toggle). */
  collapseRightPanelOnly: () => void;
  /** Cycle active tab within the current mode. */
  cycleRightPanelTab: (delta: 1 | -1) => void;
  /** Activate the Nth tab (0-based) within the current mode. */
  activateRightPanelTabAt: (index: number) => void;
  /** Open a blank browser tab or shell in the current right-panel mode (Cmd/Ctrl+T). */
  openNewRightPanelTab: () => void;
  /**
   * PTY exited: close the tab when multiple terminals exist;
   * if it is the only terminal tab, replace it with a fresh shell.
   */
  handleTerminalExit: (terminalId: string) => void;

  /** Fullscreen preview: hide L1/L2 + chat, show only the right panel. */
  rightPanelFullscreen: boolean;
  setRightPanelFullscreen: (v: boolean) => void;
  toggleRightPanelFullscreen: () => void;

  /**
   * Whether the currently-active page renders a right-panel host.
   * Consumers (e.g. chat entity/file links) use this to decide between
   * opening the right panel vs. falling back to a modal.
   */
  hostAvailable: boolean;
  setHostAvailable: (v: boolean) => void;
}

const LayoutContext = createContext<LayoutContextValue | null>(null);

export function LayoutProvider({ children }: { children: React.ReactNode }) {
  // Initialize unified collapse from the persisted L0 sidebar state so the two
  // start in sync (the L0 hook reads the same key).
  const [leftCollapsed, setLeftCollapsedState] = useState<boolean>(() => {
    try { return localStorage.getItem('markus_sidebar_c') === '1'; } catch { return false; }
  });
  const initialPanel = useMemo(() => buildInitialRightPanelState(), []);
  const [mode, setMode] = useState<RightPanelMode>(initialPanel.mode);
  const [browserTabs, setBrowserTabs] = useState<RightPanelTab[]>(initialPanel.browserTabs);
  const [terminalTabs, setTerminalTabs] = useState<RightPanelTab[]>(initialPanel.terminalTabs);
  const [browserActiveId, setBrowserActiveId] = useState<string | null>(initialPanel.browserActiveId);
  const [terminalActiveId, setTerminalActiveId] = useState<string | null>(initialPanel.terminalActiveId);
  const [fullscreen, setFullscreen] = useState(false);
  const [hostAvailable, setHostAvailable] = useState(false);
  // Start on L0 so JK can switch pages immediately after launch (Overview focused).
  const [keyboardPane, setKeyboardPaneState] = useState<KeyboardPane>('l0');
  const [l0FocusPageId, setL0FocusPageIdState] = useState<string | null>(null);

  const setKeyboardPane = useCallback((pane: KeyboardPane) => setKeyboardPaneState(pane), []);
  const setL0FocusPageId = useCallback((pageId: string | null) => setL0FocusPageIdState(pageId), []);

  // Pointer: (1) blur text fields when clicking outside so JK/HL resume without Escape;
  // (2) claim a keyboard pane via [data-keyboard-pane]. Clicks outside pane regions do
  // NOT clear the pane. Mark composer chrome with [data-keep-edit-focus] to keep typing.
  useEffect(() => {
    const isTextField = (el: Element | null): el is HTMLElement => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      return el.isContentEditable;
    };

    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target instanceof Element)) return;

      const active = document.activeElement;
      if (isTextField(active)) {
        const insideField = active === e.target || active.contains(e.target);
        const keepEdit = !!e.target.closest('[data-keep-edit-focus]');
        const otherField = isTextField(e.target)
          || !!e.target.closest('input, textarea, select, [contenteditable="true"]');
        // Never steal focus from an embedded terminal.
        const intoXterm = !!e.target.closest('.xterm');
        if (!insideField && !keepEdit && !otherField && !intoXterm) {
          active.blur();
        }
      }

      const hit = e.target.closest('[data-keyboard-pane]');
      if (!hit) return;
      const pane = hit.getAttribute('data-keyboard-pane');
      if (pane !== 'l0' && pane !== 'l1' && pane !== 'l2' && pane !== 'content') return;
      setKeyboardPaneState(pane);
      if (pane === 'l0') {
        const pageEl = e.target.closest('[data-l0-page-id]');
        const pageId = pageEl?.getAttribute('data-l0-page-id');
        if (pageId) setL0FocusPageIdState(pageId);
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, []);

  const lastBrowserTabsRef = useRef<RightPanelTab[]>(
    initialPanel.stashedBrowserTabs.length > 0
      ? initialPanel.stashedBrowserTabs
      : initialPanel.browserTabs,
  );
  const lastBrowserActiveRef = useRef<string | null>(
    initialPanel.stashedBrowserActiveId ?? initialPanel.browserActiveId,
  );
  const lastTerminalTabsRef = useRef<RightPanelTab[]>(
    initialPanel.stashedTerminalTabs.length > 0
      ? initialPanel.stashedTerminalTabs
      : initialPanel.terminalTabs,
  );
  const lastTerminalActiveRef = useRef<string | null>(
    initialPanel.stashedTerminalActiveId ?? initialPanel.terminalActiveId,
  );
  const browserActiveIdRef = useRef<string | null>(initialPanel.browserActiveId);
  const terminalActiveIdRef = useRef<string | null>(initialPanel.terminalActiveId);
  const browserTabsRef = useRef<RightPanelTab[]>(initialPanel.browserTabs);
  const terminalTabsRef = useRef<RightPanelTab[]>(initialPanel.terminalTabs);
  const modeRef = useRef<RightPanelMode>(initialPanel.mode);
  browserActiveIdRef.current = browserActiveId;
  terminalActiveIdRef.current = terminalActiveId;
  browserTabsRef.current = browserTabs;
  terminalTabsRef.current = terminalTabs;
  modeRef.current = mode;

  // Restored terminal mode or collapsed browser → keep native browser views hidden.
  useEffect(() => {
    if (
      initialPanel.mode === 'terminal'
      || initialPanel.browserTabs.length === 0
    ) {
      void window.markusDesktop?.browser?.hideAll?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist right-panel tabs across app restarts / Cmd+R shell reload.
  // When the panel is collapsed, visible state is [] but tabs live in last*Ref —
  // persist those so a Markus reload does not wipe the session.
  useEffect(() => {
    const browserCollapsed = browserTabs.length === 0 && lastBrowserTabsRef.current.length > 0;
    const terminalCollapsed = terminalTabs.length === 0 && lastTerminalTabsRef.current.length > 0;
    const browserSource = browserCollapsed ? lastBrowserTabsRef.current : browserTabs;
    const terminalSource = terminalCollapsed ? lastTerminalTabsRef.current : terminalTabs;

    const browserSerialized = browserSource
      .map(serializeBrowserTab)
      .filter((t): t is RightPanelTab => !!t);
    const terminalSerialized = terminalSource
      .filter(t => t.payload.kind === 'terminal')
      .map(t => ({
        id: t.id,
        title: t.title,
        cwd: t.payload.kind === 'terminal' ? t.payload.cwd : undefined,
      }));
    const payload: PersistedRightPanel = {
      mode,
      browserTabs: browserSerialized,
      browserActiveId: browserCollapsed
        ? lastBrowserActiveRef.current
        : browserActiveId,
      terminalTabs: terminalSerialized,
      terminalActiveId: terminalCollapsed
        ? lastTerminalActiveRef.current
        : terminalActiveId,
      browserCollapsed,
      terminalCollapsed,
    };
    try {
      localStorage.setItem(RIGHT_PANEL_STORAGE_KEY, JSON.stringify(payload));
    } catch { /* quota / private mode */ }
  }, [mode, browserTabs, browserActiveId, terminalTabs, terminalActiveId]);

  const setLeftCollapsed = useCallback((v: boolean) => setLeftCollapsedState(v), []);
  const toggleLeftCollapsed = useCallback(() => setLeftCollapsedState(v => !v), []);

  const hideBrowsers = useCallback(() => {
    void window.markusDesktop?.browser?.hideAll?.();
  }, []);

  const setRightPanelMode = useCallback((next: RightPanelMode) => {
    setMode(prev => {
      if (prev === next) return prev;
      if (next === 'terminal') {
        hideBrowsers();
      }
      return next;
    });
  }, [hideBrowsers]);

  const switchRightPanelMode = useCallback((next: RightPanelMode) => {
    if (next === 'terminal') {
      hideBrowsers();
      setMode('terminal');
      setLeftCollapsedState(true);
      // Already showing terminal tabs — just switch.
      if (terminalTabs.length > 0) return;
      if (lastTerminalTabsRef.current.length > 0) {
        const restored = lastTerminalTabsRef.current;
        const active = lastTerminalActiveRef.current && restored.some(t => t.id === lastTerminalActiveRef.current)
          ? lastTerminalActiveRef.current
          : restored[0]!.id;
        setTerminalTabs(restored);
        setTerminalActiveId(active);
        lastTerminalActiveRef.current = active;
        return;
      }
      const blankTabId = newTabId();
      const terminalId = `term_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      rememberTerminalId(terminalId);
      const tab: RightPanelTab = {
        id: blankTabId,
        title: 'Terminal',
        payload: { kind: 'terminal', terminalId, title: 'Terminal' },
      };
      lastTerminalTabsRef.current = [tab];
      setTerminalTabs([tab]);
      setTerminalActiveId(tab.id);
      lastTerminalActiveRef.current = tab.id;
      return;
    }

    setMode('browser');
    setLeftCollapsedState(true);
    if (browserTabs.length > 0) return;
    if (lastBrowserTabsRef.current.length > 0) {
      const restored = lastBrowserTabsRef.current;
      const active = lastBrowserActiveRef.current && restored.some(t => t.id === lastBrowserActiveRef.current)
        ? lastBrowserActiveRef.current
        : restored[0]!.id;
      setBrowserTabs(restored);
      setBrowserActiveId(active);
      lastBrowserActiveRef.current = active;
      return;
    }
    const blankTabId = newTabId();
    const blankBrowserId = `eb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const tab: RightPanelTab = {
      id: blankTabId,
      title: 'New Tab',
      payload: { kind: 'url', url: 'about:blank', title: 'New Tab', browserId: blankBrowserId },
    };
    lastBrowserTabsRef.current = [tab];
    setBrowserTabs([tab]);
    setBrowserActiveId(tab.id);
    lastBrowserActiveRef.current = tab.id;
  }, [browserTabs.length, terminalTabs.length, hideBrowsers]);

  const openRightPanel = useCallback((payload: RightPanelPayload) => {
    const key = payloadKey(payload);
    const newId = newTabId();
    const isTerm = isTerminalPayload(payload);

    // Compute next tabs + active id synchronously via refs.
    // (React 18 does not run useState updaters inline, so assigning nextActiveId
    // inside setX(prev => …) left the previous tab selected when opening a file.)
    if (isTerm) {
      if (payload.kind === 'terminal') rememberTerminalId(payload.terminalId);
      setMode('terminal');
      hideBrowsers();
      const prev = terminalTabsRef.current;
      const existing = prev.find(t => payloadKey(t.payload) === key)
        ?? lastTerminalTabsRef.current.find(t => payloadKey(t.payload) === key);
      let next: RightPanelTab[];
      let nextActiveId: string;
      if (existing) {
        nextActiveId = existing.id;
        next = prev.some(t => t.id === existing.id)
          ? prev
          : evictOverLimit([existing, ...prev]);
      } else {
        const tab: RightPanelTab = {
          id: newId,
          title: payloadTitle(payload),
          payload,
        };
        next = evictOverLimit([tab, ...prev]);
        nextActiveId = newId;
      }
      lastTerminalTabsRef.current = next;
      terminalTabsRef.current = next;
      setTerminalTabs(next);
      setTerminalActiveId(nextActiveId);
      lastTerminalActiveRef.current = nextActiveId;
      terminalActiveIdRef.current = nextActiveId;
    } else {
      setMode('browser');
      const prev = browserTabsRef.current;
      const existing = prev.find(t => payloadKey(t.payload) === key)
        ?? lastBrowserTabsRef.current.find(t => payloadKey(t.payload) === key);
      let next: RightPanelTab[];
      let nextActiveId: string;
      if (existing) {
        nextActiveId = existing.id;
        next = prev.some(t => t.id === existing.id)
          ? prev
          : evictOverLimit([existing, ...prev]);
      } else {
        const tab: RightPanelTab = {
          id: newId,
          title: payloadTitle(payload),
          payload,
        };
        next = evictOverLimit([tab, ...prev]);
        nextActiveId = newId;
      }
      lastBrowserTabsRef.current = next;
      browserTabsRef.current = next;
      setBrowserTabs(next);
      setBrowserActiveId(nextActiveId);
      lastBrowserActiveRef.current = nextActiveId;
      browserActiveIdRef.current = nextActiveId;
    }
    setLeftCollapsedState(true);
  }, [hideBrowsers]);

  const closeRightPanelTab = useCallback((tabId: string) => {
    // Read from refs synchronously — React 18 does not run useState updaters
    // inline. Side effects inside setX(prev => …) (destroy native view / PTY)
    // were skipped, leaving Bilibili audio playing after the tab UI was gone.
    const browserPrev = browserTabsRef.current;
    const browserIdx = browserPrev.findIndex(t => t.id === tabId);
    if (browserIdx >= 0) {
      const closingPayload = browserPrev[browserIdx]?.payload;
      const next = browserPrev.filter(t => t.id !== tabId);
      const currentBrowserActive = browserActiveIdRef.current;
      const displayedActive = browserPrev.some(t => t.id === currentBrowserActive)
        ? currentBrowserActive
        : (browserPrev[0]?.id ?? null);
      const nextActive = (displayedActive === tabId || next.length === 0)
        ? (next[Math.min(browserIdx, next.length - 1)]?.id ?? null)
        : undefined;

      lastBrowserTabsRef.current = next;
      browserTabsRef.current = next;
      setBrowserTabs(next);
      if (next.length === 0 && modeRef.current === 'browser') setFullscreen(false);
      if (nextActive !== undefined) {
        setBrowserActiveId(nextActive);
        lastBrowserActiveRef.current = nextActive;
        browserActiveIdRef.current = nextActive;
      }
      destroyBrowserIfNeeded(closingPayload);
      return;
    }

    const terminalPrev = terminalTabsRef.current;
    const terminalIdx = terminalPrev.findIndex(t => t.id === tabId);
    if (terminalIdx < 0) return;
    const closingPayload = terminalPrev[terminalIdx]?.payload;
    const next = terminalPrev.filter(t => t.id !== tabId);
    const currentTerminalActive = terminalActiveIdRef.current;
    const displayedActive = terminalPrev.some(t => t.id === currentTerminalActive)
      ? currentTerminalActive
      : (terminalPrev[0]?.id ?? null);
    const nextActive = (displayedActive === tabId || next.length === 0)
      ? (next[Math.min(terminalIdx, next.length - 1)]?.id ?? null)
      : undefined;

    lastTerminalTabsRef.current = next;
    terminalTabsRef.current = next;
    setTerminalTabs(next);
    if (next.length === 0 && modeRef.current === 'terminal') setFullscreen(false);
    if (nextActive !== undefined) {
      setTerminalActiveId(nextActive);
      lastTerminalActiveRef.current = nextActive;
      terminalActiveIdRef.current = nextActive;
    }
    destroyTerminalIfNeeded(closingPayload);
  }, []);

  const closeRightPanel = useCallback(() => {
    // Same React 18 rule: collect payloads from refs, not from setState updaters.
    const browserDestroy = browserTabsRef.current.map(t => t.payload);
    const terminalDestroy = terminalTabsRef.current.map(t => t.payload);
    browserTabsRef.current = [];
    terminalTabsRef.current = [];
    lastBrowserTabsRef.current = [];
    lastBrowserActiveRef.current = null;
    lastTerminalTabsRef.current = [];
    lastTerminalActiveRef.current = null;
    browserActiveIdRef.current = null;
    terminalActiveIdRef.current = null;
    setBrowserTabs([]);
    setTerminalTabs([]);
    setBrowserActiveId(null);
    setTerminalActiveId(null);
    setFullscreen(false);
    for (const payload of browserDestroy) destroyBrowserIfNeeded(payload);
    for (const payload of terminalDestroy) destroyTerminalIfNeeded(payload);
  }, []);

  const setActiveRightPanelTab = useCallback((tabId: string) => {
    if (modeRef.current === 'terminal') {
      setTerminalActiveId(tabId);
      lastTerminalActiveRef.current = tabId;
    } else {
      setBrowserActiveId(tabId);
      lastBrowserActiveRef.current = tabId;
    }
  }, []);

  const updateRightPanelBrowserTab = useCallback((browserId: string, patch: { url?: string; title?: string; pageId?: number }) => {
    setBrowserTabs(prev => {
      let changed = false;
      const next = prev.map(t => {
        if (t.payload.kind !== 'url' || t.payload.browserId !== browserId) return t;
        const url = patch.url ?? t.payload.url;
        const title = patch.title || t.payload.title || url;
        const pageId = patch.pageId ?? t.payload.pageId;
        if (
          url === t.payload.url
          && title === (t.payload.title || t.title)
          && pageId === t.payload.pageId
          && title === t.title
        ) {
          return t;
        }
        changed = true;
        return {
          ...t,
          title,
          payload: { ...t.payload, url, title, ...(pageId != null ? { pageId } : {}) },
        };
      });
      if (changed) lastBrowserTabsRef.current = next;
      return changed ? next : prev;
    });
  }, []);

  const updateRightPanelTerminalTab = useCallback((terminalId: string, patch: { title?: string; cwd?: string }) => {
    setTerminalTabs(prev => {
      let changed = false;
      const next = prev.map(t => {
        if (t.payload.kind !== 'terminal' || t.payload.terminalId !== terminalId) return t;
        const title = patch.title || t.payload.title || t.title;
        const cwd = patch.cwd ?? t.payload.cwd;
        if (title === t.title && cwd === t.payload.cwd && title === (t.payload.title || t.title)) {
          return t;
        }
        changed = true;
        return {
          ...t,
          title,
          payload: { ...t.payload, title, ...(cwd != null ? { cwd } : {}) },
        };
      });
      if (changed) lastTerminalTabsRef.current = next;
      return changed ? next : prev;
    });
  }, []);

  const collapseRightPanelOnly = useCallback(() => {
    if (modeRef.current === 'terminal') {
      setTerminalTabs(prev => {
        if (prev.length === 0) return prev;
        lastTerminalTabsRef.current = prev;
        if (terminalActiveIdRef.current) lastTerminalActiveRef.current = terminalActiveIdRef.current;
        return [];
      });
      setTerminalActiveId(null);
    } else {
      setBrowserTabs(prev => {
        if (prev.length === 0) return prev;
        lastBrowserTabsRef.current = prev;
        if (browserActiveIdRef.current) lastBrowserActiveRef.current = browserActiveIdRef.current;
        return [];
      });
      setBrowserActiveId(null);
      hideBrowsers();
    }
    setFullscreen(false);
  }, [hideBrowsers]);

  /** Open/restore browser mode, or collapse if already showing browser tabs. */
  const toggleRightPanel = useCallback(() => {
    // Another mode open → switch to browser (restore or blank), don't collapse terminal.
    if (modeRef.current === 'terminal' && terminalTabs.length > 0) {
      setMode('browser');
      if (browserTabs.length > 0) {
        setLeftCollapsedState(true);
        return;
      }
      if (lastBrowserTabsRef.current.length > 0) {
        const restored = lastBrowserTabsRef.current;
        const active = lastBrowserActiveRef.current && restored.some(t => t.id === lastBrowserActiveRef.current)
          ? lastBrowserActiveRef.current
          : restored[0]!.id;
        setBrowserTabs(restored);
        setBrowserActiveId(active);
        lastBrowserActiveRef.current = active;
        setLeftCollapsedState(true);
        return;
      }
      const blankTabId = newTabId();
      const blankBrowserId = `eb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      const tab: RightPanelTab = {
        id: blankTabId,
        title: 'New Tab',
        payload: { kind: 'url', url: 'about:blank', title: 'New Tab', browserId: blankBrowserId },
      };
      lastBrowserTabsRef.current = [tab];
      setBrowserTabs([tab]);
      setBrowserActiveId(tab.id);
      lastBrowserActiveRef.current = tab.id;
      setLeftCollapsedState(true);
      return;
    }

    const blankTabId = newTabId();
    const blankBrowserId = `eb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    let nextActive: string | null | undefined;
    let collapseLeft = false;
    let collapsed = false;
    setMode('browser');
    setBrowserTabs(prev => {
      if (prev.length > 0) {
        lastBrowserTabsRef.current = prev;
        if (browserActiveIdRef.current) lastBrowserActiveRef.current = browserActiveIdRef.current;
        collapsed = true;
        nextActive = null;
        return [];
      }
      if (lastBrowserTabsRef.current.length > 0) {
        collapseLeft = true;
        const restored = lastBrowserTabsRef.current;
        const active = lastBrowserActiveRef.current && restored.some(t => t.id === lastBrowserActiveRef.current)
          ? lastBrowserActiveRef.current
          : restored[0]!.id;
        nextActive = active;
        return restored;
      }
      collapseLeft = true;
      const tab: RightPanelTab = {
        id: blankTabId,
        title: 'New Tab',
        payload: { kind: 'url', url: 'about:blank', title: 'New Tab', browserId: blankBrowserId },
      };
      lastBrowserTabsRef.current = [tab];
      nextActive = tab.id;
      return [tab];
    });
    if (collapseLeft) setLeftCollapsedState(true);
    if (collapsed) {
      setBrowserActiveId(null);
      setFullscreen(false);
      hideBrowsers();
    } else if (nextActive !== undefined && nextActive !== null) {
      setBrowserActiveId(nextActive);
      lastBrowserActiveRef.current = nextActive;
    }
  }, [browserTabs.length, terminalTabs.length, hideBrowsers]);

  /** Open/restore terminal mode, or collapse if already showing terminal tabs. */
  const toggleTerminalPanel = useCallback(() => {
    if (modeRef.current === 'browser' && browserTabs.length > 0) {
      setMode('terminal');
      hideBrowsers();
      if (terminalTabs.length > 0) {
        setLeftCollapsedState(true);
        return;
      }
      if (lastTerminalTabsRef.current.length > 0) {
        const restored = lastTerminalTabsRef.current;
        const active = lastTerminalActiveRef.current && restored.some(t => t.id === lastTerminalActiveRef.current)
          ? lastTerminalActiveRef.current
          : restored[0]!.id;
        setTerminalTabs(restored);
        setTerminalActiveId(active);
        lastTerminalActiveRef.current = active;
        setLeftCollapsedState(true);
        return;
      }
      const blankTabId = newTabId();
      const terminalId = `term_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      rememberTerminalId(terminalId);
      const tab: RightPanelTab = {
        id: blankTabId,
        title: 'Terminal',
        payload: { kind: 'terminal', terminalId, title: 'Terminal' },
      };
      lastTerminalTabsRef.current = [tab];
      setTerminalTabs([tab]);
      setTerminalActiveId(tab.id);
      lastTerminalActiveRef.current = tab.id;
      setLeftCollapsedState(true);
      return;
    }

    const blankTabId = newTabId();
    const terminalId = `term_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    rememberTerminalId(terminalId);
    let nextActive: string | null | undefined;
    let collapseLeft = false;
    let collapsed = false;
    setMode('terminal');
    hideBrowsers();
    setTerminalTabs(prev => {
      if (prev.length > 0) {
        lastTerminalTabsRef.current = prev;
        if (terminalActiveIdRef.current) lastTerminalActiveRef.current = terminalActiveIdRef.current;
        collapsed = true;
        nextActive = null;
        return [];
      }
      if (lastTerminalTabsRef.current.length > 0) {
        collapseLeft = true;
        const restored = lastTerminalTabsRef.current;
        const active = lastTerminalActiveRef.current && restored.some(t => t.id === lastTerminalActiveRef.current)
          ? lastTerminalActiveRef.current
          : restored[0]!.id;
        nextActive = active;
        return restored;
      }
      collapseLeft = true;
      const tab: RightPanelTab = {
        id: blankTabId,
        title: 'Terminal',
        payload: { kind: 'terminal', terminalId, title: 'Terminal' },
      };
      lastTerminalTabsRef.current = [tab];
      nextActive = tab.id;
      return [tab];
    });
    if (collapseLeft) setLeftCollapsedState(true);
    if (collapsed) {
      setTerminalActiveId(null);
      setFullscreen(false);
    } else if (nextActive !== undefined && nextActive !== null) {
      setTerminalActiveId(nextActive);
      lastTerminalActiveRef.current = nextActive;
    }
  }, [browserTabs.length, terminalTabs.length, hideBrowsers]);

  const cycleRightPanelTab = useCallback((delta: 1 | -1) => {
    const tabs = modeRef.current === 'terminal' ? terminalTabs : browserTabs;
    if (tabs.length < 2) return;
    const activeId = modeRef.current === 'terminal' ? terminalActiveIdRef.current : browserActiveIdRef.current;
    const curIdx = Math.max(0, tabs.findIndex(t => t.id === activeId));
    const nextIdx = (curIdx + delta + tabs.length) % tabs.length;
    const nextId = tabs[nextIdx]!.id;
    if (modeRef.current === 'terminal') {
      setTerminalActiveId(nextId);
      lastTerminalActiveRef.current = nextId;
    } else {
      setBrowserActiveId(nextId);
      lastBrowserActiveRef.current = nextId;
    }
  }, [browserTabs, terminalTabs]);

  const activateRightPanelTabAt = useCallback((index: number) => {
    const tabs = modeRef.current === 'terminal' ? terminalTabs : browserTabs;
    const tab = tabs[index];
    if (!tab) return;
    if (modeRef.current === 'terminal') {
      setTerminalActiveId(tab.id);
      lastTerminalActiveRef.current = tab.id;
    } else {
      setBrowserActiveId(tab.id);
      lastBrowserActiveRef.current = tab.id;
    }
  }, [browserTabs, terminalTabs]);

  /** Cmd/Ctrl+T — blank browser tab or new shell in the active right-panel mode. */
  const openNewRightPanelTab = useCallback(() => {
    if (modeRef.current === 'terminal') {
      const terminalId = `term_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      openRightPanel({ kind: 'terminal', terminalId, title: 'Terminal' });
      return;
    }
    const browserId = `eb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    openRightPanel({
      kind: 'url',
      url: 'about:blank',
      title: 'New Tab',
      browserId,
    });
  }, [openRightPanel]);

  const handleTerminalExit = useCallback((terminalId: string) => {
    const prev = terminalTabsRef.current;
    const idx = prev.findIndex(
      t => t.payload.kind === 'terminal' && t.payload.terminalId === terminalId,
    );
    if (idx < 0) {
      forgetTerminalId(terminalId);
      void window.markusDesktop?.terminal?.destroy(terminalId);
      return;
    }
    const tab = prev[idx]!;

    // Multiple shells: close the exited tab (destroy PTY + remove from strip).
    if (prev.length > 1) {
      closeRightPanelTab(tab.id);
      return;
    }

    // Sole tab: swap in a fresh shell instead of leaving a dead "exited" pane.
    forgetTerminalId(terminalId);
    void window.markusDesktop?.terminal?.destroy(terminalId);
    const newTerminalId = `term_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    rememberTerminalId(newTerminalId);
    const title = tab.payload.kind === 'terminal'
      ? (tab.payload.title || tab.title || 'Terminal')
      : 'Terminal';
    const cwd = tab.payload.kind === 'terminal' ? tab.payload.cwd : undefined;
    const nextTab: RightPanelTab = {
      id: tab.id,
      title,
      payload: { kind: 'terminal', terminalId: newTerminalId, title, cwd },
    };
    lastTerminalTabsRef.current = [nextTab];
    setTerminalTabs([nextTab]);
    setTerminalActiveId(nextTab.id);
    lastTerminalActiveRef.current = nextTab.id;
    if (modeRef.current !== 'terminal') setMode('terminal');
  }, [closeRightPanelTab]);

  const setRightPanelFullscreen = useCallback((v: boolean) => setFullscreen(v), []);
  const toggleRightPanelFullscreen = useCallback(() => setFullscreen(v => !v), []);

  const tabs = mode === 'terminal' ? terminalTabs : browserTabs;
  const activeTabId = mode === 'terminal' ? terminalActiveId : browserActiveId;
  const activeTab = tabs.find(t => t.id === activeTabId) ?? tabs[0] ?? null;
  const rightPanel = activeTab?.payload ?? null;
  const rightPanelOpen = tabs.length > 0;

  const value = useMemo<LayoutContextValue>(() => ({
    leftCollapsed,
    setLeftCollapsed,
    toggleLeftCollapsed,
    keyboardPane,
    setKeyboardPane,
    l0FocusPageId,
    setL0FocusPageId,
    rightPanelMode: mode,
    setRightPanelMode,
    switchRightPanelMode,
    rightPanel,
    rightPanelOpen,
    rightPanelTabs: tabs,
    activeRightPanelTabId: activeTab?.id ?? null,
    openRightPanel,
    closeRightPanel,
    closeRightPanelTab,
    setActiveRightPanelTab,
    updateRightPanelBrowserTab,
    updateRightPanelTerminalTab,
    toggleRightPanel,
    toggleTerminalPanel,
    collapseRightPanelOnly,
    cycleRightPanelTab,
    activateRightPanelTabAt,
    openNewRightPanelTab,
    handleTerminalExit,
    rightPanelFullscreen: fullscreen,
    setRightPanelFullscreen,
    toggleRightPanelFullscreen,
    hostAvailable,
    setHostAvailable,
  }), [
    leftCollapsed, setLeftCollapsed, toggleLeftCollapsed,
    keyboardPane, setKeyboardPane, l0FocusPageId, setL0FocusPageId,
    mode, setRightPanelMode, switchRightPanelMode, rightPanel, rightPanelOpen, tabs, activeTab,
    openRightPanel, closeRightPanel, closeRightPanelTab,
    setActiveRightPanelTab, updateRightPanelBrowserTab, updateRightPanelTerminalTab,
    toggleRightPanel, toggleTerminalPanel, collapseRightPanelOnly,
    cycleRightPanelTab, activateRightPanelTabAt, openNewRightPanelTab, handleTerminalExit,
    fullscreen, setRightPanelFullscreen, toggleRightPanelFullscreen, hostAvailable,
  ]);

  return <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>;
}

/** Returns the layout context, or null when rendered outside a LayoutProvider. */
export function useLayout(): LayoutContextValue | null {
  return useContext(LayoutContext);
}
