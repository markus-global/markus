import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { DeliverableInfo } from '../api.ts';
import { forgetTerminalId, rememberTerminalId } from '../lib/known-terminals.ts';

/**
 * Payload describing what the right-side panel should display.
 * Extend this union as new previewable content types are supported.
 */
export type RightPanelPayload =
  | { kind: 'deliverable'; deliverable: DeliverableInfo; sourceMessageId?: string }
  | { kind: 'file'; path: string; title?: string; sourceMessageId?: string }
  | { kind: 'url'; url: string; title?: string; browserId?: string; pageId?: number }
  | { kind: 'terminal'; terminalId: string; title?: string; cwd?: string };

export type RightPanelMode = 'browser' | 'terminal';

export interface RightPanelTab {
  id: string;
  title: string;
  payload: RightPanelPayload;
  pinned?: boolean;
}

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

export interface LayoutContextValue {
  /** Unified collapse command for the left sidebars (L0 app rail + L1/L2 team panels). */
  leftCollapsed: boolean;
  setLeftCollapsed: (v: boolean) => void;
  toggleLeftCollapsed: () => void;

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
  const [mode, setMode] = useState<RightPanelMode>('browser');
  const [browserTabs, setBrowserTabs] = useState<RightPanelTab[]>([]);
  const [terminalTabs, setTerminalTabs] = useState<RightPanelTab[]>([]);
  const [browserActiveId, setBrowserActiveId] = useState<string | null>(null);
  const [terminalActiveId, setTerminalActiveId] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [hostAvailable, setHostAvailable] = useState(false);

  const lastBrowserTabsRef = useRef<RightPanelTab[]>([]);
  const lastBrowserActiveRef = useRef<string | null>(null);
  const lastTerminalTabsRef = useRef<RightPanelTab[]>([]);
  const lastTerminalActiveRef = useRef<string | null>(null);
  const browserActiveIdRef = useRef<string | null>(null);
  const terminalActiveIdRef = useRef<string | null>(null);
  const terminalTabsRef = useRef<RightPanelTab[]>([]);
  const modeRef = useRef<RightPanelMode>('browser');
  browserActiveIdRef.current = browserActiveId;
  terminalActiveIdRef.current = terminalActiveId;
  terminalTabsRef.current = terminalTabs;
  modeRef.current = mode;

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
    let nextActiveId: string | null = null;

    if (isTerm) {
      if (payload.kind === 'terminal') rememberTerminalId(payload.terminalId);
      setMode('terminal');
      hideBrowsers();
      setTerminalTabs(prev => {
        const existing = prev.find(t => payloadKey(t.payload) === key)
          ?? lastTerminalTabsRef.current.find(t => payloadKey(t.payload) === key);
        if (existing) {
          nextActiveId = existing.id;
          // Restore into visible pool if it was only in lastTabs (collapsed).
          if (!prev.some(t => t.id === existing.id)) {
            const next = evictOverLimit([existing, ...prev]);
            lastTerminalTabsRef.current = next;
            return next;
          }
          lastTerminalTabsRef.current = prev;
          return prev;
        }
        const tab: RightPanelTab = {
          id: newId,
          title: payloadTitle(payload),
          payload,
        };
        const next = evictOverLimit([tab, ...prev]);
        nextActiveId = newId;
        lastTerminalTabsRef.current = next;
        return next;
      });
      if (nextActiveId) {
        setTerminalActiveId(nextActiveId);
        lastTerminalActiveRef.current = nextActiveId;
      }
    } else {
      setMode('browser');
      setBrowserTabs(prev => {
        const existing = prev.find(t => payloadKey(t.payload) === key);
        if (existing) {
          nextActiveId = existing.id;
          lastBrowserTabsRef.current = prev;
          return prev;
        }
        const tab: RightPanelTab = {
          id: newId,
          title: payloadTitle(payload),
          payload,
        };
        const next = evictOverLimit([tab, ...prev]);
        nextActiveId = newId;
        lastBrowserTabsRef.current = next;
        return next;
      });
      if (nextActiveId) {
        setBrowserActiveId(nextActiveId);
        lastBrowserActiveRef.current = nextActiveId;
      }
    }
    setLeftCollapsedState(true);
  }, [hideBrowsers]);

  const closeRightPanelTab = useCallback((tabId: string) => {
    let closingPayload: RightPanelPayload | undefined;
    let nextActive: string | null | undefined;
    let clearedAll = false;
    let closedFrom: 'browser' | 'terminal' | null = null;

    const currentBrowserActive = browserActiveIdRef.current;
    setBrowserTabs(prev => {
      const idx = prev.findIndex(t => t.id === tabId);
      if (idx < 0) return prev;
      closedFrom = 'browser';
      closingPayload = prev[idx]?.payload;
      const next = prev.filter(t => t.id !== tabId);
      lastBrowserTabsRef.current = next;
      clearedAll = next.length === 0;
      const displayedActive = prev.some(t => t.id === currentBrowserActive)
        ? currentBrowserActive
        : (prev[0]?.id ?? null);
      if (displayedActive === tabId || next.length === 0) {
        nextActive = next[Math.min(idx, next.length - 1)]?.id ?? null;
      }
      return next;
    });

    if (closedFrom === 'browser') {
      if (clearedAll && modeRef.current === 'browser') setFullscreen(false);
      if (nextActive !== undefined) {
        setBrowserActiveId(nextActive);
        lastBrowserActiveRef.current = nextActive;
      }
      destroyBrowserIfNeeded(closingPayload);
      return;
    }

    const currentTerminalActive = terminalActiveIdRef.current;
    setTerminalTabs(prev => {
      const idx = prev.findIndex(t => t.id === tabId);
      if (idx < 0) return prev;
      closedFrom = 'terminal';
      closingPayload = prev[idx]?.payload;
      const next = prev.filter(t => t.id !== tabId);
      lastTerminalTabsRef.current = next;
      clearedAll = next.length === 0;
      const displayedActive = prev.some(t => t.id === currentTerminalActive)
        ? currentTerminalActive
        : (prev[0]?.id ?? null);
      if (displayedActive === tabId || next.length === 0) {
        nextActive = next[Math.min(idx, next.length - 1)]?.id ?? null;
      }
      return next;
    });

    if (closedFrom === 'terminal') {
      if (clearedAll && modeRef.current === 'terminal') setFullscreen(false);
      if (nextActive !== undefined) {
        setTerminalActiveId(nextActive);
        lastTerminalActiveRef.current = nextActive;
      }
      destroyTerminalIfNeeded(closingPayload);
    }
  }, []);

  const closeRightPanel = useCallback(() => {
    let browserDestroy: RightPanelPayload[] = [];
    let terminalDestroy: RightPanelPayload[] = [];
    setBrowserTabs(prev => {
      browserDestroy = prev.map(t => t.payload);
      return [];
    });
    setTerminalTabs(prev => {
      terminalDestroy = prev.map(t => t.payload);
      return [];
    });
    setBrowserActiveId(null);
    setTerminalActiveId(null);
    setFullscreen(false);
    lastBrowserTabsRef.current = [];
    lastBrowserActiveRef.current = null;
    lastTerminalTabsRef.current = [];
    lastTerminalActiveRef.current = null;
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
    handleTerminalExit,
    rightPanelFullscreen: fullscreen,
    setRightPanelFullscreen,
    toggleRightPanelFullscreen,
    hostAvailable,
    setHostAvailable,
  }), [
    leftCollapsed, setLeftCollapsed, toggleLeftCollapsed,
    mode, setRightPanelMode, switchRightPanelMode, rightPanel, rightPanelOpen, tabs, activeTab,
    openRightPanel, closeRightPanel, closeRightPanelTab,
    setActiveRightPanelTab, updateRightPanelBrowserTab, updateRightPanelTerminalTab,
    toggleRightPanel, toggleTerminalPanel, collapseRightPanelOnly,
    cycleRightPanelTab, activateRightPanelTabAt, handleTerminalExit,
    fullscreen, setRightPanelFullscreen, toggleRightPanelFullscreen, hostAvailable,
  ]);

  return <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>;
}

/** Returns the layout context, or null when rendered outside a LayoutProvider. */
export function useLayout(): LayoutContextValue | null {
  return useContext(LayoutContext);
}
