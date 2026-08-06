import { useEffect, useLayoutEffect, useState, useCallback, useMemo, useRef, memo, lazy, Suspense } from 'react';
import { type PageId, PAGE, resolvePageId, getPageFromHash, hashPath, pageToHash, MOBILE_REDIRECTS, L0_NAV_PAGES, PAGES_WITH_L1 } from './routes.ts';
import { setNativeBrowserPagePaintAllowed } from './lib/nativeBrowserOverlay.ts';
import { isEphemeralAuthBrowserUrl } from './lib/browserAuthUrl.ts';
import { HomePage } from './pages/Home.tsx';

const TeamPage = lazy(() => import('./pages/Team.tsx').then(m => ({ default: m.TeamPage })));
const Settings = lazy(() => import('./pages/Settings.tsx').then(m => ({ default: m.Settings })));
const StorePage = lazy(() => import('./pages/Store.tsx').then(m => ({ default: m.StorePage })));
const AgentBuilder = lazy(() => import('./pages/AgentBuilder.tsx').then(m => ({ default: m.AgentBuilder })));
const WorkPage = lazy(() => import('./pages/Work.tsx').then(m => ({ default: m.WorkPage })));
const DeliverablesPage = lazy(() => import('./pages/Deliverables.tsx').then(m => ({ default: m.DeliverablesPage })));
const NotificationsPage = lazy(() => import('./pages/Notifications.tsx').then(m => ({ default: m.NotificationsPage })));
const SearchPage = lazy(() => import('./pages/Search.tsx').then(m => ({ default: m.SearchPage })));
import { Sidebar } from './components/Sidebar.tsx';
import { BottomNav } from './components/BottomNav.tsx';
import { MobileBuilderTabs } from './components/MobileBuilderTabs.tsx';
import { MobileDrawer } from './components/MobileDrawer.tsx';
import { Onboarding } from './components/Onboarding.tsx';
import { Login, InviteSetup } from './pages/Login.tsx';
import { ChangePassword } from './pages/ChangePassword.tsx';
import { api, hubApi, clearHubAuth, type AuthUser, wsClient } from './api.ts';
import { navBus } from './navBus.ts';
import { useResizablePanel } from './hooks/useResizablePanel.ts';
import { useLayout, isBrowserTabReopenSuppressed } from './contexts/LayoutContext.tsx';
import { useTheme } from './hooks/useTheme.ts';
import { useIsMobile } from './hooks/useIsMobile.ts';
import { prefetch, PREFETCH_KEYS } from './prefetchCache.ts';
import { useTranslation } from 'react-i18next';
import { SearchModal } from './components/SearchModal.tsx';
import { ShortcutsHelpModal } from './components/ShortcutsHelpModal.tsx';
import { EditProfileModal } from './components/EditProfileModal.tsx';
import { isEditableTarget, isXtermTarget } from './lib/keyboard-shortcuts.ts';
import { knownTerminalIds, rememberTerminalId } from './lib/known-terminals.ts';

const HIDDEN_STYLE: React.CSSProperties = {
  visibility: 'hidden',
  position: 'absolute',
  inset: 0,
  pointerEvents: 'none',
  zIndex: -1,
};

/**
 * Push the browser's current language/timezone to the server if they differ
 * from what's stored, so the agent can localize prompts (language + timezone).
 */
function syncLocalePreferences(user: AuthUser): void {
  try {
    const locale = navigator.language;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const prev = user.preferences ?? {};
    if (prev.locale === locale && prev.timezone === timezone) return;
    api.auth.updatePreferences({ locale, timezone }).catch(() => {});
  } catch { /* Intl / navigator unavailable */ }
}

function PageFallback() {
  return (
    <div className="flex-1 flex items-center justify-center text-fg-tertiary text-sm animate-pulse">
      Loading...
    </div>
  );
}

const PageSlot = memo(function PageSlot({
  id, activePage, children,
}: {
  id: PageId;
  activePage: PageId;
  children: React.ReactNode;
}) {
  const active = id === activePage;
  return (
    <div className="flex-1 overflow-hidden flex flex-col" style={active ? undefined : HIDDEN_STYLE}>
      <Suspense fallback={<PageFallback />}>
        {children}
      </Suspense>
    </div>
  );
}, (prev, next) => {
  const wasVisible = prev.id === prev.activePage;
  const isVisible = next.id === next.activePage;
  if (wasVisible !== isVisible) return false;
  if (isVisible) return prev.children === next.children;
  return true;
});

// Preserve sub-path hashes (e.g. #team/d) across page switches
const _savedPageHashes: Record<string, string> = {};

// Resolve a page for the current viewport: on mobile some pages are folded into
// others (e.g. Store lives inside the Assets page), so apply MOBILE_REDIRECTS.
function resolveForViewport(p: PageId): PageId {
  if (typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches) {
    return MOBILE_REDIRECTS[p] ?? p;
  }
  return p;
}

function initialPage(): PageId {
  return resolveForViewport(getPageFromHash());
}

export function App() {
  const { t } = useTranslation('common');
  const [page, setPage] = useState<PageId>(initialPage);
  const [showOnboarding, setShowOnboarding] = useState(() => !localStorage.getItem('markus_onboarded'));
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const isMobile = useIsMobile();
  const theme = useTheme();
  const sidebar = useResizablePanel({
    side: 'left',
    defaultWidth: 160,
    minWidth: 140,
    maxWidth: 400,
    collapsedWidth: 64,
    storageKey: 'markus_sidebar',
  });
  const [mountedPages, setMountedPages] = useState<Set<PageId>>(() => new Set([initialPage()]));
  const [authUser, setAuthUser] = useState<AuthUser | null | 'loading'>('loading');
  const [showEditProfile, setShowEditProfile] = useState(false);
  const [systemInitialized, setSystemInitialized] = useState<boolean | null>(null);
  const [authStatus, setAuthStatus] = useState<{ hasOwner: boolean; hasMultipleUsers: boolean }>({ hasOwner: false, hasMultipleUsers: false });
  const [skipOnboardingProfile, setSkipOnboardingProfile] = useState(false);
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [llmConfigured, setLlmConfigured] = useState<boolean | null>(null);
  const [llmBannerDismissed, setLlmBannerDismissed] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<{ latestVersion: string; currentVersion: string } | null>(null);
  const [updateBannerDismissed, setUpdateBannerDismissed] = useState(() => {
    const stored = localStorage.getItem('markus_update_dismissed');
    return stored ? stored : null;
  });
  const [showSearchModal, setShowSearchModal] = useState(false);
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);

  const layout = useLayout();
  const leftCollapsed = layout?.leftCollapsed ?? false;
  const toggleLeftCollapsed = layout?.toggleLeftCollapsed;
  const setLeftCollapsed = layout?.setLeftCollapsed;
  const keyboardPane = layout?.keyboardPane ?? 'l0';
  const setKeyboardPane = layout?.setKeyboardPane;
  const l0FocusPageId = layout?.l0FocusPageId ?? null;
  const setL0FocusPageId = layout?.setL0FocusPageId;
  const pageRef = useRef(page);
  pageRef.current = page;
  /** Page shown before entering Settings — H / Back restores it. */
  const pageBeforeSettingsRef = useRef<PageId>(PAGE.HOME);
  const toggleRightPanel = layout?.toggleRightPanel;
  const toggleTerminalPanel = layout?.toggleTerminalPanel;
  const cycleRightPanelTab = layout?.cycleRightPanelTab;
  const activateRightPanelTabAt = layout?.activateRightPanelTabAt;
  const openNewRightPanelTab = layout?.openNewRightPanelTab;
  const rightPanelOpen = layout?.rightPanelOpen ?? false;
  const activeRightPanelTabId = layout?.activeRightPanelTabId ?? null;

  // When the agent opens/selects/closes an embedded browser page, mirror it into the right panel.
  const openRightPanel = layout?.openRightPanel;
  const closeRightPanelTab = layout?.closeRightPanelTab;
  const updateRightPanelBrowserTab = layout?.updateRightPanelBrowserTab;
  const updateRightPanelTerminalTab = layout?.updateRightPanelTerminalTab;
  const rightPanelTabsRef = useRef(layout?.rightPanelTabs);
  rightPanelTabsRef.current = layout?.rightPanelTabs;
  useEffect(() => {
    const onPageEvent = window.markusDesktop?.browser?.onPageEvent;
    if (!onPageEvent || !openRightPanel) return;
    return onPageEvent((event) => {
      if (event.type === 'closed') {
        const tab = rightPanelTabsRef.current?.find(
          t => t.payload.kind === 'url' && t.payload.browserId === event.browserId,
        );
        if (tab && closeRightPanelTab) closeRightPanelTab(tab.id);
        return;
      }
      if (event.type === 'navigated') {
        // Never sync Magic / OAuth into a panel tab (desktop should open externally).
        if (event.url && isEphemeralAuthBrowserUrl(event.url)) return;
        if (event.browserId && updateRightPanelBrowserTab) {
          updateRightPanelBrowserTab(event.browserId, {
            url: event.url,
            title: event.title || event.url,
          });
        }
        return;
      }
      if (event.type === 'opened' || event.type === 'selected') {
        if (!event.url && !event.browserId) return;
        // UI-owned preview hosts (eb_*) already have a panel tab — never re-open
        // them from native events (selected/opened after destroy looks like "can't close").
        if (event.browserId.startsWith('eb_')) return;
        // User just closed this browserId; ignore in-flight create/select echoes.
        if (isBrowserTabReopenSuppressed(event.browserId)) return;
        // Stale Magic / OAuth URLs must not become right-panel tabs.
        if (event.url && isEphemeralAuthBrowserUrl(event.url)) return;
        openRightPanel({
          kind: 'url',
          url: event.url || 'about:blank',
          title: event.title || event.url || 'Browser',
          browserId: event.browserId,
          pageId: event.pageId,
        });
      }
    });
  }, [openRightPanel, closeRightPanelTab, updateRightPanelBrowserTab]);

  // Mirror agent/desktop terminal open/select/close into the right panel.
  // IMPORTANT: UI already creates term_* tabs before PTY create/select. Re-calling
  // openRightPanel on those echoes steals mode back from Browser (globe click) and
  // remounts xterm in a flicker loop.
  useEffect(() => {
    const onEvent = window.markusDesktop?.terminal?.onEvent;
    if (!onEvent || !openRightPanel) return;
    return onEvent((event) => {
      if (event.type === 'closed') {
        const tab = rightPanelTabsRef.current?.find(
          t => t.payload.kind === 'terminal' && t.payload.terminalId === event.id,
        );
        // Only remove UI tab if still present; LayoutContext destroy already closed PTY.
        if (tab && closeRightPanelTab) closeRightPanelTab(tab.id);
        return;
      }
      if (event.type === 'cwd') {
        if (event.cwd) updateRightPanelTerminalTab?.(event.id, { cwd: event.cwd });
        return;
      }
      if (event.type === 'selected') {
        // Never force-open / steal mode on select echoes from the active xterm.
        if (event.title || event.cwd) {
          updateRightPanelTerminalTab?.(event.id, { title: event.title, cwd: event.cwd });
        }
        return;
      }
      if (event.type === 'opened') {
        if (knownTerminalIds.has(event.id)) {
          if (event.title || event.cwd) {
            updateRightPanelTerminalTab?.(event.id, { title: event.title, cwd: event.cwd });
          }
          return;
        }
        rememberTerminalId(event.id);
        openRightPanel({
          kind: 'terminal',
          terminalId: event.id,
          title: event.title || 'Terminal',
          cwd: event.cwd,
        });
      }
    });
  }, [openRightPanel, closeRightPanelTab, updateRightPanelTerminalTab]);

  // PTY exit → close tab (multi) or replace with a fresh shell (sole tab).
  const handleTerminalExit = layout?.handleTerminalExit;
  useEffect(() => {
    const onExit = window.markusDesktop?.terminal?.onExit;
    if (!onExit || !handleTerminalExit) return;
    return onExit((event) => {
      handleTerminalExit(event.id);
    });
  }, [handleTerminalExit]);

  // Native WebContentsViews paint above HTML. Gate them synchronously in
  // useLayoutEffect (before paint) so leaving Team / closing the panel does
  // not leave a ghost browser over Overview/Settings for multiple frames.
  useLayoutEffect(() => {
    const allow = page === PAGE.TEAM && rightPanelOpen && layout?.rightPanelMode === 'browser';
    setNativeBrowserPagePaintAllowed(allow);
  }, [page, rightPanelOpen, layout?.rightPanelMode]);

  // Fresh renderer load: never inherit a stuck native view from a prior session.
  useEffect(() => {
    void window.markusDesktop?.browser?.hideAll?.();
  }, []);

  // Keep the L0 app rail in sync with the unified "left collapsed" command
  // (driven by Cmd+B and by opening the right panel). Skip the initial mount so
  // the persisted L0 collapse state is preserved on load.
  const didSyncL0 = useRef(false);
  useEffect(() => {
    if (!didSyncL0.current) { didSyncL0.current = true; return; }
    sidebar.setCollapsed(leftCollapsed);
  }, [leftCollapsed, sidebar.setCollapsed]);

  // Global search shortcut: Cmd+P (Mac) / Ctrl+P (Win/Linux)
  useEffect(() => {
    if (isMobile) return;
    const isMac = navigator.platform.toUpperCase().includes('MAC');
    const onKey = (e: KeyboardEvent) => {
      if (isMac && e.metaKey && !e.ctrlKey && e.key === 'p') {
        e.preventDefault();
        setShowSearchModal(prev => !prev);
      } else if (!isMac && e.ctrlKey && !e.metaKey && e.key === 'p') {
        e.preventDefault();
        setShowSearchModal(prev => !prev);
      }
    };
    const onOpen = () => setShowSearchModal(true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('markus:open-search', onOpen);
    return () => { document.removeEventListener('keydown', onKey); window.removeEventListener('markus:open-search', onOpen); };
  }, [isMobile]);

  const closeActiveRightPanelTab = useCallback(() => {
    if (!rightPanelOpen || !activeRightPanelTabId || !closeRightPanelTab) return false;
    // Browser / terminal (and other right-panel tabs): close active tab only — never the window.
    closeRightPanelTab(activeRightPanelTabId);
    return true;
  }, [rightPanelOpen, activeRightPanelTabId, closeRightPanelTab]);

  // Desktop menu accelerators (Cmd/Ctrl+W / T) arrive via IPC so they never close the window.
  useEffect(() => {
    const unsub = window.markusDesktop?.onAppShortcut?.((event) => {
      if (event.type === 'close-tab') {
        closeActiveRightPanelTab();
        return;
      }
      if (event.type === 'new-tab') {
        openNewRightPanelTab?.();
      }
    });
    return () => { unsub?.(); };
  }, [closeActiveRightPanelTab, openNewRightPanelTab]);

  // Layout shortcuts: B left, L browser panel, J terminal panel, / help,
  // Shift+] / [ cycle tabs, 1–9 jump tab, W close tab, T new tab.
  useEffect(() => {
    if (isMobile || !toggleLeftCollapsed || !toggleRightPanel) return;
    const isMac = navigator.platform.toUpperCase().includes('MAC');
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? (e.metaKey && !e.ctrlKey) : (e.ctrlKey && !e.metaKey);
      if (!mod || e.altKey) return;

      // Cmd/Ctrl+/ → shortcuts help (also Cmd+? on US keyboards)
      if (!e.shiftKey && (e.key === '/' || e.code === 'Slash')) {
        e.preventDefault();
        setShowShortcutsHelp(prev => !prev);
        return;
      }
      if (e.shiftKey && (e.key === '?' || e.key === '/')) {
        e.preventDefault();
        setShowShortcutsHelp(prev => !prev);
        return;
      }

      // Tab cycling within current right-panel mode
      if (e.shiftKey && rightPanelOpen && cycleRightPanelTab) {
        if (e.key === ']' || e.code === 'BracketRight') {
          e.preventDefault();
          cycleRightPanelTab(1);
          return;
        }
        if (e.key === '[' || e.code === 'BracketLeft') {
          e.preventDefault();
          cycleRightPanelTab(-1);
          return;
        }
      }

      // Cmd/Ctrl+1…9 → Nth tab
      if (!e.shiftKey && rightPanelOpen && activateRightPanelTabAt) {
        const digit = e.key >= '1' && e.key <= '9' ? Number(e.key) : 0;
        if (digit >= 1) {
          e.preventDefault();
          activateRightPanelTabAt(digit - 1);
          return;
        }
      }

      if (e.shiftKey) return;
      const key = e.key.toLowerCase();
      // Always prevent Cmd/Ctrl+W from reaching the OS / window-close path.
      if (key === 'w') {
        e.preventDefault();
        e.stopPropagation();
        closeActiveRightPanelTab();
        return;
      }
      if (key === 't') {
        e.preventDefault();
        openNewRightPanelTab?.();
        return;
      }
      if (key === 'b') {
        e.preventDefault();
        toggleLeftCollapsed();
      } else if (page === PAGE.TEAM && key === 'l') {
        // Team Chat only: browser right panel. Tasks page owns Cmd+L for item detail.
        // Don't steal Ctrl+L clear-screen from an focused xterm (Cmd+L still toggles on Mac).
        if (!isMac && isXtermTarget(e.target)) return;
        if (isMac && isXtermTarget(e.target) && e.ctrlKey) return;
        e.preventDefault();
        toggleRightPanel();
      } else if (page === PAGE.TEAM && key === 'j' && toggleTerminalPanel) {
        // Team Chat only: terminal right panel. Tasks page owns Cmd+J for project detail.
        e.preventDefault();
        toggleTerminalPanel();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [
    isMobile,
    page,
    toggleLeftCollapsed,
    toggleRightPanel,
    toggleTerminalPanel,
    cycleRightPanelTab,
    activateRightPanelTabAt,
    rightPanelOpen,
    closeActiveRightPanelTab,
    openNewRightPanelTab,
  ]);

  const navigate = useCallback((p: PageId, params?: Record<string, string>) => {
    let normalized = resolvePageId(p);
    if (isMobile) {
      normalized = MOBILE_REDIRECTS[normalized] ?? normalized;
    } else if (normalized === PAGE.NOTIFICATIONS) {
      normalized = PAGE.HOME;
    }
    // Hide native browser immediately — don't wait for React commit/effects.
    if (normalized !== PAGE.TEAM) {
      setNativeBrowserPagePaintAllowed(false);
    }
    // Save current page's full hash (e.g. 'team/d') so it can be restored later.
    // Compare against the page's slug (not its id) since the address bar shows
    // slugs — otherwise a plain page hash looks like a sub-route and gets saved.
    const curBase = getPageFromHash();
    const curFull = window.location.hash.slice(1);
    if (curFull !== pageToHash(curBase)) _savedPageHashes[curBase] = curFull;
    else delete _savedPageHashes[curBase];

    const fromPage = pageRef.current;
    // Remember origin before Settings so H / Back can restore it.
    if (normalized === PAGE.SETTINGS && fromPage !== PAGE.SETTINGS) {
      pageBeforeSettingsRef.current = fromPage;
      navBus.setSettingsReturnPage(fromPage);
      // Settings hides the app rail — land on its L1 tab sidebar for JK.
      setKeyboardPane?.('l1');
      setL0FocusPageId?.(PAGE.SETTINGS);
    }
    // Leaving Settings → restore L0 focus so JK works immediately again.
    if (fromPage === PAGE.SETTINGS && normalized !== PAGE.SETTINGS) {
      setKeyboardPane?.('l0');
      setL0FocusPageId?.(normalized);
    }

    // Explicit settings tab (e.g. Hub status → Account) must win over a restored
    // previous settings sub-hash like #settings/appearance.
    if (normalized === PAGE.SETTINGS && params?.tab) {
      const settingsHash = `settings/${params.tab}`;
      _savedPageHashes[normalized] = settingsHash;
      history.pushState(null, '', '#' + settingsHash);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      setPage(normalized);
      setMountedPages(prev => prev.has(normalized) ? prev : new Set([...prev, normalized]));
      return;
    }

    // Use pushState (silent, no events) for all URL changes, then dispatch
    // hashchange synchronously so external stores (e.g. Chat's hash store)
    // update in the same React render batch as setPage — eliminates flash.
    // Work page manages its own project/filter state in React; don't restore
    // a saved project-specific hash (e.g. work/proj_xxx) when clicking "Work".
    const savedHash = normalized !== PAGE.WORK ? _savedPageHashes[normalized] : undefined;
    if (savedHash && savedHash !== pageToHash(normalized)) {
      history.pushState(null, '', hashPath(normalized));
      history.pushState(null, '', '#' + savedHash);
    } else {
      history.pushState(null, '', hashPath(normalized));
    }
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    setPage(normalized);
    setMountedPages(prev => prev.has(normalized) ? prev : new Set([...prev, normalized]));
  }, [isMobile, setKeyboardPane, setL0FocusPageId]);

  useEffect(() => {
    navBus.setHandler((p, params) => navigate(p, params));
  }, [navigate]);

  // While on L0, keep the rail highlight aligned with the active page
  // (e.g. Overview selected when the app opens on Overview / when entering L0).
  useEffect(() => {
    if (keyboardPane !== 'l0') return;
    if (page === PAGE.SETTINGS) return; // Settings hides L0; don't steal focus id
    setL0FocusPageId?.(page);
  }, [keyboardPane, page, setL0FocusPageId]);

  // L0 app-rail + Settings H: j/k switch pages; L enters L1; H leaves Settings.
  useEffect(() => {
    if (isMobile || !setKeyboardPane || !setL0FocusPageId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditableTarget(e.target)) return;

      const bare = e.key.length === 1 ? e.key.toLowerCase() : e.key;

      // Settings L1: H / ← returns to the previous page (app rail is hidden here).
      if (page === PAGE.SETTINGS && (bare === 'h' || bare === 'ArrowLeft')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        navBus.leaveSettings();
        return;
      }

      if (keyboardPane !== 'l0') return;
      // While on Settings the app rail is hidden — tab JK is handled in Settings.tsx.
      if (page === PAGE.SETTINGS) return;

      const focusId = (l0FocusPageId && L0_NAV_PAGES.includes(l0FocusPageId as PageId)
        ? l0FocusPageId
        : page) as PageId;
      const idx = Math.max(0, L0_NAV_PAGES.indexOf(focusId));

      if (bare === 'j' || bare === 'ArrowDown') {
        e.preventDefault();
        e.stopImmediatePropagation();
        const next = L0_NAV_PAGES[Math.min(L0_NAV_PAGES.length - 1, idx + 1)]!;
        setL0FocusPageId(next);
        if (next !== page) navigate(next);
        requestAnimationFrame(() => {
          document.querySelector(`[data-l0-page-id="${next}"]`)?.scrollIntoView({ block: 'nearest' });
        });
        return;
      }
      if (bare === 'k' || bare === 'ArrowUp') {
        e.preventDefault();
        e.stopImmediatePropagation();
        const next = L0_NAV_PAGES[Math.max(0, idx - 1)]!;
        setL0FocusPageId(next);
        if (next !== page) navigate(next);
        requestAnimationFrame(() => {
          document.querySelector(`[data-l0-page-id="${next}"]`)?.scrollIntoView({ block: 'nearest' });
        });
        return;
      }
      if (bare === 'l' || bare === 'ArrowRight' || bare === 'Enter') {
        const target = (l0FocusPageId && L0_NAV_PAGES.includes(l0FocusPageId as PageId)
          ? l0FocusPageId
          : page) as PageId;
        // L only enters L1 — page switch is already done by j/k.
        if (!PAGES_WITH_L1.has(target)) {
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        if (target !== page) navigate(target);
        setLeftCollapsed?.(false);
        setKeyboardPane('l1');
        return;
      }
      // H on L0: no further left pane
      if (bare === 'h' || bare === 'ArrowLeft') {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [
    isMobile, keyboardPane, l0FocusPageId, page, navigate,
    setKeyboardPane, setL0FocusPageId, setLeftCollapsed,
  ]);

  useEffect(() => {
    const openEdit = () => setShowEditProfile(true);
    window.addEventListener('markus:open-edit-profile', openEdit);
    return () => window.removeEventListener('markus:open-edit-profile', openEdit);
  }, []);

  // Desktop: adjust traffic light position based on sidebar visibility
  useEffect(() => {
    if (!window.markusDesktop) return;
    const hasSidebar = !isMobile && page !== PAGE.SETTINGS;
    if (hasSidebar && !sidebar.collapsed) {
      window.markusDesktop.setTrafficLightPosition(16, 16);
    } else {
      window.markusDesktop.setTrafficLightPosition(6, 16);
    }
  }, [sidebar.collapsed, page, isMobile]);

  // Desktop: handle OS notification click — open panel + navigate to content
  useEffect(() => {
    if (!window.markusDesktop) return;
    window.markusDesktop.onNotificationClick((nav) => {
      if (nav.openNotifications) {
        window.dispatchEvent(new CustomEvent('markus:open-notifications'));
      }
      if (nav.page) {
        const page = resolvePageId(nav.page as PageId);
        if (nav.params) {
          Object.entries(nav.params).forEach(([k, v]) => localStorage.setItem(`markus_nav_${k}`, v));
        }
        navigate(page);
        window.dispatchEvent(new CustomEvent('markus:navigate', { detail: { page, params: nav.params } }));
      }
    });
  }, [navigate]);

  const checkLlmConfig = useCallback(() => {
    fetch('/api/settings/llm')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.providers) {
          const configured = Object.values(d.providers as Record<string, { configured: boolean }>).some(p => p.configured);
          setLlmConfigured(configured);
        }
      })
      .catch(() => {});
  }, []);

  const applyInstallDeepLink = useCallback((installItemId: string, itemType?: string | null) => {
    if (!installItemId) return;
    const tabMap: Record<string, string> = { agent: 'agents', team: 'teams', skill: 'skills' };
    const storeTab = (itemType && tabMap[itemType]) || 'agents';
    localStorage.setItem('markus_nav_installItem', installItemId);
    localStorage.setItem('markus_nav_storeTab', storeTab);
    // Keep ?install= in the URL until Store consumes it (auth/onboarding may delay mount).
    const urlParams = new URLSearchParams(window.location.search);
    if (!urlParams.get('install')) {
      urlParams.set('install', installItemId);
      if (itemType) urlParams.set('type', itemType);
    }
    const qs = urlParams.toString();
    window.history.replaceState(null, '', `${window.location.pathname}?${qs}${hashPath(PAGE.STORE)}`);
    const go = () => navBus.navigate(PAGE.STORE, { storeTab, installItem: installItemId });
    // Immediate + delayed: Store may not be mounted yet (auth gate / lazy chunk).
    go();
    setTimeout(go, 500);
    setTimeout(go, 1500);
  }, []);

  useEffect(() => {
    // Deep link: ?install=ITEM_ID&type=agent|team|skill — always apply (hash may already be #explore)
    const urlParams = new URLSearchParams(window.location.search);
    const installItemId = urlParams.get('install');
    if (installItemId) applyInstallDeepLink(installItemId, urlParams.get('type'));

    // Desktop IPC: warm markus://install while UI is already loaded
    const desktop = window.markusDesktop;
    desktop?.onDeepLinkInstall?.(({ id, type }) => applyInstallDeepLink(id, type));
    void desktop?.consumePendingDeepLinkInstall?.().then((pending) => {
      if (pending?.id) applyInstallDeepLink(pending.id, pending.type);
    });

    api.auth.me()
      .then(({ user }) => {
        setAuthUser(user);
        setSystemInitialized(true);
        syncLocalePreferences(user);
        wsClient.connect(user.id);
        checkLlmConfig();
        api.health().then(h => {
          if (h.updateAvailable && h.latestVersion) {
            setUpdateInfo({ latestVersion: h.latestVersion, currentVersion: h.version });
          }
        }).catch(() => {});
        const doPrefetch = () => {
          prefetch(PREFETCH_KEYS.builderArtifacts, () => api.builder.artifacts.list());
          prefetch(PREFETCH_KEYS.builderAgents, () => api.agents.list());
          prefetch(PREFETCH_KEYS.builderHubMyItems, () => hubApi.myItems());
          prefetch(PREFETCH_KEYS.builderInstalled, () => api.builder.artifacts.installed());
          prefetch(PREFETCH_KEYS.hubAgents, () => hubApi.search({ type: 'agent', limit: 50 }));
          prefetch(PREFETCH_KEYS.hubTeams, () => hubApi.search({ type: 'team', limit: 50 }));
          prefetch(PREFETCH_KEYS.hubSkills, () => hubApi.search({ type: 'skill', limit: 50 }));
        };
        if (typeof requestIdleCallback === 'function') {
          requestIdleCallback(doPrefetch, { timeout: 5000 });
        } else {
          setTimeout(doPrefetch, 3000);
        }
      })
      .catch(() => {
        setAuthUser(null);
        api.auth.status().then(({ initialized, hasOwner, hasMultipleUsers }) => {
          setSystemInitialized(initialized);
          setAuthStatus({ hasOwner, hasMultipleUsers });
        }).catch(() => setSystemInitialized(true));
      });

    wsClient.connect();
    const unsubNotif = wsClient.on('notification', () => {
      window.dispatchEvent(new CustomEvent('markus:notifications-changed'));
    });
    const onHash = () => {
      const p = resolveForViewport(getPageFromHash());
      if (p !== PAGE.TEAM) setNativeBrowserPagePaintAllowed(false);
      setPage(p);
      setMountedPages(prev => prev.has(p) ? prev : new Set([...prev, p]));
    };
    window.addEventListener('hashchange', onHash);
    window.addEventListener('popstate', onHash);
    return () => { unsubNotif(); wsClient.disconnect(); window.removeEventListener('hashchange', onHash); window.removeEventListener('popstate', onHash); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentUser = authUser !== 'loading' && authUser !== null ? authUser : undefined;
  const pageElements = useMemo<Partial<Record<PageId, React.JSX.Element>>>(() => {
    if (isMobile) {
      return {
        [PAGE.HOME]: <HomePage authUser={currentUser} />,
        [PAGE.TEAM]: <TeamPage authUser={currentUser} />,
        [PAGE.BUILDER]: <MobileBuilderTabs authUser={currentUser} />,
        [PAGE.SETTINGS]: <Settings theme={theme.mode} onThemeChange={theme.setMode} authUser={currentUser} onLogout={() => { api.auth.logout().catch(() => {}); clearHubAuth(); setAuthUser(null); }} onUserUpdated={(u) => setAuthUser(u)} />,
        [PAGE.WORK]: <WorkPage authUser={currentUser} />,
        [PAGE.DELIVERABLES]: <DeliverablesPage authUser={currentUser} />,
        [PAGE.NOTIFICATIONS]: <NotificationsPage authUser={currentUser} />,
        [PAGE.SEARCH]: <SearchPage />,
      };
    }
    return {
      [PAGE.HOME]: <HomePage authUser={currentUser} />,
      [PAGE.TEAM]: <TeamPage authUser={currentUser} />,
      [PAGE.SETTINGS]: <Settings theme={theme.mode} onThemeChange={theme.setMode} authUser={currentUser} onLogout={() => { api.auth.logout().catch(() => {}); clearHubAuth(); setAuthUser(null); }} onUserUpdated={(u) => setAuthUser(u)} />,
      [PAGE.STORE]: <StorePage authUser={currentUser} />,
      [PAGE.BUILDER]: <AgentBuilder authUser={currentUser} />,
      [PAGE.WORK]: <WorkPage authUser={currentUser} />,
      [PAGE.DELIVERABLES]: <DeliverablesPage authUser={currentUser} />,
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.id, currentUser?.role, theme.mode, isMobile]);

  if (authUser === 'loading' || (authUser === null && systemInitialized === null)) {
    return (
      <div className="min-h-dvh bg-surface-primary flex items-center justify-center">
        <div className="text-fg-tertiary text-sm animate-pulse">{t('loading')}</div>
      </div>
    );
  }

  // Handle invite setup flow: /#invite?token=xxx
  const hashStr = typeof window !== 'undefined' ? window.location.hash : '';
  const inviteMatch = hashStr.match(/^#invite\?token=([a-f0-9]+)/);
  if (inviteMatch) {
    return <InviteSetup token={inviteMatch[1]!} onComplete={() => {
      window.location.hash = '';
      localStorage.removeItem('markus_onboarded');
      setShowOnboarding(true);
      setSkipOnboardingProfile(true);
      setAuthUser('loading');
      api.auth.me().then(d => setAuthUser(d.user)).catch(() => setAuthUser(null));
    }} />;
  }

  if (authUser === null) {
    return <Login
      hasOwner={authStatus.hasOwner}
      hasMultipleUsers={authStatus.hasMultipleUsers}
      onLogin={(user, needsOnboarding, opts) => {
      setAuthUser(user);
      // Re-key the WebSocket to this user. The initial connect() ran anonymously
      // (or not at all when logged out), so without this the socket stays
      // unbound to the user until a full page reload.
      wsClient.connect(user.id);
      if (needsOnboarding) {
        localStorage.removeItem('markus_onboarded');
        setShowOnboarding(true);
        if (opts?.fromHub) setSkipOnboardingProfile(true);
      } else if (!localStorage.getItem('markus_onboarded')) {
        localStorage.setItem('markus_onboarded', '1');
        setShowOnboarding(false);
      }
    }} />;
  }

  if (mustChangePassword) {
    return <ChangePassword
      onComplete={() => setMustChangePassword(false)}
      isFirstTime
    />;
  }

  if (showOnboarding) {
    return <Onboarding
      theme={theme.mode}
      onThemeChange={theme.setMode}
      skipProfile={skipOnboardingProfile}
      onProfileUpdated={(u) => {
        const next: AuthUser = {
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.role,
          orgId: u.orgId ?? 'default',
          avatarUrl: u.avatarUrl,
        };
        setAuthUser(next);
      }}
      onComplete={() => {
        localStorage.setItem('markus_onboarded', '1');
        setShowOnboarding(false);
        setSkipOnboardingProfile(false);
        // Re-fetch so sidebar / People reflect the name saved during onboarding
        // (login may have still carried the placeholder "Admin").
        api.auth.me().then(d => setAuthUser(d.user)).catch(() => {});
        checkLlmConfig();
        navigate(PAGE.HOME);
      }}
    />;
  }

  return (
    <div className={`flex h-dvh bg-surface-primary text-fg-primary overflow-x-hidden ${isMobile ? 'flex-col' : ''}`}>
      {/* Desktop sidebar (hidden on Settings page) */}
      {!isMobile && page !== PAGE.SETTINGS && (
        <>
          <div
            className="relative z-40 shrink-0"
            style={{ width: sidebar.width }}
          >
            <Sidebar
              currentPage={page}
              onNavigate={(p) => {
                navigate(p);
                setSidebarOpen(false);
                // Clicking the app rail claims L0 — never dump into content (that kills JK/HL).
                setKeyboardPane?.('l0');
                setL0FocusPageId?.(p);
              }}
              authUser={authUser}
              collapsed={sidebar.collapsed}
              onToggleCollapse={sidebar.toggle}
              onLogout={() => { api.auth.logout().catch(() => {}); clearHubAuth(); setAuthUser(null); }}
              keyboardFocusPageId={l0FocusPageId}
              keyboardPaneActive={keyboardPane === 'l0'}
            />
          </div>

          <div
            className={`${sidebar.collapsed ? 'w-0' : 'w-1.5 cursor-col-resize'} shrink-0 group relative z-10 flex items-center justify-center`}
            onMouseDown={sidebar.collapsed ? undefined : sidebar.onResizeStart}
          >
            {!sidebar.collapsed && <div className="w-px h-2/3 border-l border-dashed border-transparent group-hover:border-border-default group-active:border-fg-tertiary transition-colors" />}
          </div>
        </>
      )}

      <div className={`flex-1 overflow-hidden flex flex-col min-w-0 ${isMobile && page !== PAGE.SETTINGS && page !== PAGE.SEARCH ? 'pb-14' : ''}`}>
        {llmConfigured === false && !llmBannerDismissed && page !== PAGE.SETTINGS && (
          <div className="flex items-center justify-between px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 text-amber-600 text-sm shrink-0">
            <span className={isMobile ? 'text-xs' : ''}>{t('llmBanner.message')}</span>
            <div className="flex items-center gap-3">
              <button onClick={() => { window.location.hash = '#settings/providers'; }} className="px-3 py-1 bg-amber-700/50 hover:bg-amber-700/70 text-white text-xs rounded-lg transition-colors">
                {t('llmBanner.goToSettings')}
              </button>
              <button onClick={() => setLlmBannerDismissed(true)} className="text-amber-500 hover:text-amber-600 text-xs">{t('dismiss')}</button>
            </div>
          </div>
        )}
        {updateInfo && updateBannerDismissed !== updateInfo.latestVersion && (
          <div className="flex items-center justify-between px-4 py-2 bg-brand-500/10 border-b border-brand-500/30 text-brand-400 text-sm shrink-0">
            <span className={isMobile ? 'text-xs' : ''}>
              {t('update.available', { latest: updateInfo.latestVersion, current: updateInfo.currentVersion })}
            </span>
            <span className="flex items-center gap-3 shrink-0">
              <a href="https://markus.global/#download" target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-brand-400 hover:text-brand-300 transition-colors">{t('update.download')}</a>
              <button onClick={() => { setUpdateBannerDismissed(updateInfo.latestVersion); localStorage.setItem('markus_update_dismissed', updateInfo.latestVersion); }} className="text-fg-tertiary hover:text-fg-secondary text-xs shrink-0">{t('dismiss')}</button>
            </span>
          </div>
        )}
        <main className="flex-1 overflow-hidden flex flex-col relative">
          {(Object.keys(pageElements) as PageId[]).map(id => (
            mountedPages.has(id) ? (
              <PageSlot key={id} id={id} activePage={page}>
                {pageElements[id]}
              </PageSlot>
            ) : null
          ))}
        </main>
      </div>

      {/* Mobile bottom nav (hidden on Settings/Search pages) */}
      {isMobile && page !== PAGE.SETTINGS && page !== PAGE.SEARCH && (
        <BottomNav currentPage={page} onNavigate={navigate} userId={currentUser?.id} />
      )}

      {/* Mobile drawer menu */}
      {isMobile && (
        <MobileDrawer authUser={currentUser} onNavigate={navigate} />
      )}

      {/* Global search modal (desktop) */}
      {!isMobile && showSearchModal && (
        <SearchModal onClose={() => setShowSearchModal(false)} currentPage={page} />
      )}
      {!isMobile && (
        <ShortcutsHelpModal open={showShortcutsHelp} onClose={() => setShowShortcutsHelp(false)} page={page} />
      )}

      {/* Edit profile — available from sidebar account menu without leaving the page */}
      {showEditProfile && currentUser && (
        <EditProfileModal
          authUser={currentUser}
          onClose={() => setShowEditProfile(false)}
          onUserUpdated={(u) => setAuthUser(u)}
          onSaved={(u) => { setShowEditProfile(false); setAuthUser(u); }}
        />
      )}
    </div>
  );
}
