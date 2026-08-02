import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { DeliverableInfo } from '../api.ts';

/**
 * Payload describing what the right-side panel should display.
 * Extend this union as new previewable content types are supported.
 */
export type RightPanelPayload =
  | { kind: 'deliverable'; deliverable: DeliverableInfo; sourceMessageId?: string }
  | { kind: 'file'; path: string; title?: string; sourceMessageId?: string }
  | { kind: 'url'; url: string; title?: string; browserId?: string; pageId?: number };

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

function payloadKey(payload: RightPanelPayload): string {
  if (payload.kind === 'file') return `file:${payload.path}`;
  if (payload.kind === 'url') return `url:${payload.browserId || payload.url}`;
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
  return payload.title || payload.path.split(/[/\\]/).pop() || payload.path;
}

export interface LayoutContextValue {
  /** Unified collapse command for the left sidebars (L0 app rail + L1/L2 team panels). */
  leftCollapsed: boolean;
  setLeftCollapsed: (v: boolean) => void;
  toggleLeftCollapsed: () => void;

  /** Right-side content panel (preview / selection-to-agent). */
  rightPanel: RightPanelPayload | null;
  rightPanelOpen: boolean;
  rightPanelTabs: RightPanelTab[];
  activeRightPanelTabId: string | null;
  openRightPanel: (payload: RightPanelPayload) => void;
  closeRightPanel: () => void;
  closeRightPanelTab: (tabId: string) => void;
  setActiveRightPanelTab: (tabId: string) => void;
  /** Update url/title for an embedded-browser tab (navigation sync). */
  updateRightPanelBrowserTab: (browserId: string, patch: { url?: string; title?: string }) => void;
  toggleRightPanel: () => void;
  /** Collapse the panel if open; never opens / restores (unlike toggle). */
  collapseRightPanelOnly: () => void;

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
  const [tabs, setTabs] = useState<RightPanelTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [hostAvailable, setHostAvailable] = useState(false);
  const lastTabsRef = useRef<RightPanelTab[]>([]);
  const lastActiveRef = useRef<string | null>(null);
  const activeTabIdRef = useRef<string | null>(null);
  activeTabIdRef.current = activeTabId;

  const setLeftCollapsed = useCallback((v: boolean) => setLeftCollapsedState(v), []);
  const toggleLeftCollapsed = useCallback(() => setLeftCollapsedState(v => !v), []);

  const openRightPanel = useCallback((payload: RightPanelPayload) => {
    const key = payloadKey(payload);
    // Id must be stable across React Strict Mode's double-invoke of updaters.
    // Calling setActiveTabId inside setTabs with a fresh random id left activeTabId
    // pointing at a tab that was discarded — UI showed the new tab but stayed on the oldest.
    const newTabId = `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    let nextActiveId: string | null = null;
    setTabs(prev => {
      const existing = prev.find(t => payloadKey(t.payload) === key);
      if (existing) {
        nextActiveId = existing.id;
        lastTabsRef.current = prev;
        return prev;
      }
      const tab: RightPanelTab = {
        id: newTabId,
        title: payloadTitle(payload),
        payload,
      };
      // Newest active tab goes first (left) so it's immediately visible.
      let next = [tab, ...prev];
      // Evict oldest unpinned tabs (rightmost) when over the limit.
      while (next.length > MAX_RIGHT_PANEL_TABS) {
        let idx = -1;
        for (let i = next.length - 1; i >= 0; i--) {
          if (!next[i]!.pinned) { idx = i; break; }
        }
        if (idx < 0) break;
        next = next.filter((_, i) => i !== idx);
      }
      nextActiveId = newTabId;
      lastTabsRef.current = next;
      return next;
    });
    if (nextActiveId) {
      setActiveTabId(nextActiveId);
      lastActiveRef.current = nextActiveId;
    }
    setLeftCollapsedState(true);
  }, []);

  const destroyBrowserIfNeeded = (payload: RightPanelPayload | undefined) => {
    if (payload?.kind === 'url' && payload.browserId) {
      suppressBrowserTabReopen(payload.browserId);
      void window.markusDesktop?.browser?.destroy(payload.browserId);
    }
  };

  const closeRightPanelTab = useCallback((tabId: string) => {
    let closingPayload: RightPanelPayload | undefined;
    let nextActive: string | null | undefined;
    let clearedAll = false;
    const currentActive = activeTabIdRef.current;
    setTabs(prev => {
      const idx = prev.findIndex(t => t.id === tabId);
      if (idx < 0) return prev;
      closingPayload = prev[idx]?.payload;
      const next = prev.filter(t => t.id !== tabId);
      lastTabsRef.current = next;
      clearedAll = next.length === 0;
      // Match what the UI treats as active: explicit id if still present, else tabs[0].
      const displayedActive = prev.some(t => t.id === currentActive)
        ? currentActive
        : (prev[0]?.id ?? null);
      const wasDisplayedActive = displayedActive === tabId;
      // Only compute fallback here; apply setActiveTabId after the updater.
      nextActive = undefined; // means "leave active unchanged" unless we closed the active tab
      if (wasDisplayedActive || next.length === 0) {
        nextActive = next[Math.min(idx, next.length - 1)]?.id ?? null;
      }
      return next;
    });
    if (clearedAll) setFullscreen(false);
    if (nextActive !== undefined) {
      setActiveTabId(nextActive);
      lastActiveRef.current = nextActive;
    }
    // Closing a tab (user X) destroys the native view; collapsing the panel does not.
    // Run after state update so page-event handlers don't re-enter setTabs.
    destroyBrowserIfNeeded(closingPayload);
  }, []);

  const closeRightPanel = useCallback(() => {
    let toDestroy: RightPanelPayload[] = [];
    setTabs(prev => {
      toDestroy = prev.map(t => t.payload);
      return [];
    });
    setActiveTabId(null);
    setFullscreen(false);
    lastTabsRef.current = [];
    lastActiveRef.current = null;
    for (const payload of toDestroy) destroyBrowserIfNeeded(payload);
  }, []);

  const setActiveRightPanelTab = useCallback((tabId: string) => {
    setActiveTabId(tabId);
    lastActiveRef.current = tabId;
  }, []);

  const updateRightPanelBrowserTab = useCallback((browserId: string, patch: { url?: string; title?: string }) => {
    setTabs(prev => {
      let changed = false;
      const next = prev.map(t => {
        if (t.payload.kind !== 'url' || t.payload.browserId !== browserId) return t;
        changed = true;
        const url = patch.url ?? t.payload.url;
        const title = patch.title || t.payload.title || url;
        return {
          ...t,
          title,
          payload: { ...t.payload, url, title },
        };
      });
      if (changed) lastTabsRef.current = next;
      return changed ? next : prev;
    });
  }, []);

  const collapseRightPanelOnly = useCallback(() => {
    setTabs(prev => {
      if (prev.length === 0) return prev;
      lastTabsRef.current = prev;
      // Remember active tab for the next open — do not clear lastActiveRef.
      if (activeTabIdRef.current) lastActiveRef.current = activeTabIdRef.current;
      return [];
    });
    setActiveTabId(null);
    setFullscreen(false);
    // Keep sessions for restore, but stop painting immediately.
    void window.markusDesktop?.browser?.hideAll?.();
  }, []);

  const toggleRightPanel = useCallback(() => {
    const blankTabId = `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const blankBrowserId = `eb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    let nextActive: string | null | undefined;
    let collapseLeft = false;
    let collapsed = false;
    setTabs(prev => {
      if (prev.length > 0) {
        // Collapse: hide the panel but keep tabs so they can be restored.
        lastTabsRef.current = prev;
        if (activeTabIdRef.current) lastActiveRef.current = activeTabIdRef.current;
        collapsed = true;
        nextActive = null;
        return [];
      }
      if (lastTabsRef.current.length > 0) {
        collapseLeft = true;
        const restored = lastTabsRef.current;
        // Prefer remembered active tab; fall back to newest (index 0).
        const active = lastActiveRef.current && restored.some(t => t.id === lastActiveRef.current)
          ? lastActiveRef.current
          : restored[0]!.id;
        nextActive = active;
        return restored;
      }
      // No history: open a blank browser tab so the user can type a URL.
      collapseLeft = true;
      const tab: RightPanelTab = {
        id: blankTabId,
        title: 'New Tab',
        payload: { kind: 'url', url: 'about:blank', title: 'New Tab', browserId: blankBrowserId },
      };
      lastTabsRef.current = [tab];
      nextActive = tab.id;
      return [tab];
    });
    if (collapseLeft) setLeftCollapsedState(true);
    if (collapsed) {
      setActiveTabId(null);
      setFullscreen(false);
      // Keep lastActiveRef — next open must restore the same browser tab.
      void window.markusDesktop?.browser?.hideAll?.();
    } else if (nextActive !== undefined && nextActive !== null) {
      setActiveTabId(nextActive);
      lastActiveRef.current = nextActive;
    }
  }, []);

  const setRightPanelFullscreen = useCallback((v: boolean) => setFullscreen(v), []);
  const toggleRightPanelFullscreen = useCallback(() => setFullscreen(v => !v), []);

  // Newest tabs are prepended at index 0 — fall back there, not to the oldest.
  const activeTab = tabs.find(t => t.id === activeTabId) ?? tabs[0] ?? null;
  const rightPanel = activeTab?.payload ?? null;

  const value = useMemo<LayoutContextValue>(() => ({
    leftCollapsed,
    setLeftCollapsed,
    toggleLeftCollapsed,
    rightPanel,
    rightPanelOpen: tabs.length > 0,
    rightPanelTabs: tabs,
    activeRightPanelTabId: activeTab?.id ?? null,
    openRightPanel,
    closeRightPanel,
    closeRightPanelTab,
    setActiveRightPanelTab,
    updateRightPanelBrowserTab,
    toggleRightPanel,
    collapseRightPanelOnly,
    rightPanelFullscreen: fullscreen,
    setRightPanelFullscreen,
    toggleRightPanelFullscreen,
    hostAvailable,
    setHostAvailable,
  }), [
    leftCollapsed, setLeftCollapsed, toggleLeftCollapsed,
    rightPanel, tabs, activeTab, openRightPanel, closeRightPanel, closeRightPanelTab,
    setActiveRightPanelTab, updateRightPanelBrowserTab, toggleRightPanel, collapseRightPanelOnly,
    fullscreen, setRightPanelFullscreen, toggleRightPanelFullscreen, hostAvailable,
  ]);

  return <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>;
}

/** Returns the layout context, or null when rendered outside a LayoutProvider. */
export function useLayout(): LayoutContextValue | null {
  return useContext(LayoutContext);
}
