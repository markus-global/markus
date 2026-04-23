import { useEffect, useState, useCallback, useMemo } from 'react';
import { type PageId, PAGE, resolvePageId, getPageFromHash, MOBILE_REDIRECTS } from './routes.ts';
import { HomePage } from './pages/Home.tsx';
import { TeamPage } from './pages/Team.tsx';
import { Settings } from './pages/Settings.tsx';
import { StorePage } from './pages/Store.tsx';
import { AgentBuilder } from './pages/AgentBuilder.tsx';
import { WorkPage } from './pages/Work.tsx';
import { DeliverablesPage } from './pages/Deliverables.tsx';
import { ReportsPage } from './pages/Reports.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { BottomNav } from './components/BottomNav.tsx';
import { MobileBuilderTabs } from './components/MobileBuilderTabs.tsx';
import { MobileSettingsTabs } from './components/MobileSettingsTabs.tsx';
import { Onboarding } from './components/Onboarding.tsx';
import { Login } from './pages/Login.tsx';
import { ChangePassword } from './pages/ChangePassword.tsx';
import { api, hubApi, type AuthUser, wsClient } from './api.ts';
import { navBus } from './navBus.ts';
import { useResizablePanel } from './hooks/useResizablePanel.ts';
import { useTheme } from './hooks/useTheme.ts';
import { useIsMobile } from './hooks/useIsMobile.ts';
import { prefetch, PREFETCH_KEYS } from './prefetchCache.ts';

// Preserve sub-path hashes (e.g. #team/d) across page switches
const _savedPageHashes: Record<string, string> = {};

export function App() {
  const [page, setPage] = useState<PageId>(getPageFromHash);
  const [showOnboarding, setShowOnboarding] = useState(() => !localStorage.getItem('markus_onboarded'));
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const isMobile = useIsMobile();
  const theme = useTheme();
  const sidebar = useResizablePanel({
    side: 'left',
    defaultWidth: 240,
    minWidth: 180,
    maxWidth: 400,
    collapsedWidth: 48,
    storageKey: 'markus_sidebar',
  });
  const [mountedPages, setMountedPages] = useState<Set<PageId>>(() => new Set([getPageFromHash()]));
  const [authUser, setAuthUser] = useState<AuthUser | null | 'loading'>('loading');
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [llmConfigured, setLlmConfigured] = useState<boolean | null>(null);
  const [llmBannerDismissed, setLlmBannerDismissed] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<{ latestVersion: string; currentVersion: string } | null>(null);
  const [updateBannerDismissed, setUpdateBannerDismissed] = useState(() => {
    const stored = localStorage.getItem('markus_update_dismissed');
    return stored ? stored : null;
  });

  const navigate = useCallback((p: PageId) => {
    let normalized = resolvePageId(p);
    if (isMobile) {
      normalized = MOBILE_REDIRECTS[normalized] ?? normalized;
    }
    // Save current page's full hash (e.g. 'team/d') so it can be restored later
    const curBase = getPageFromHash();
    const curFull = window.location.hash.slice(1);
    if (curFull !== curBase) _savedPageHashes[curBase] = curFull;
    else delete _savedPageHashes[curBase];

    // Use pushState (silent, no events) for all URL changes, then dispatch
    // hashchange synchronously so external stores (e.g. Chat's hash store)
    // update in the same React render batch as setPage — eliminates flash.
    // Work page manages its own project/filter state in React; don't restore
    // a saved project-specific hash (e.g. work/proj_xxx) when clicking "Work".
    const savedHash = normalized !== PAGE.WORK ? _savedPageHashes[normalized] : undefined;
    if (savedHash && savedHash !== normalized) {
      history.pushState(null, '', '#' + normalized);
      history.pushState(null, '', '#' + savedHash);
    } else {
      history.pushState(null, '', '#' + normalized);
    }
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    setPage(normalized);
    setMountedPages(prev => prev.has(normalized) ? prev : new Set([...prev, normalized]));
  }, [isMobile]);

  useEffect(() => {
    navBus.setHandler((p) => navigate(p));
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

  useEffect(() => {
    api.auth.me()
      .then(({ user }) => {
        setAuthUser(user);
        checkLlmConfig();
        api.health().then(h => {
          if (h.updateAvailable && h.latestVersion) {
            setUpdateInfo({ latestVersion: h.latestVersion, currentVersion: h.version });
          }
        }).catch(() => {});
        prefetch(PREFETCH_KEYS.builderArtifacts, () => api.builder.artifacts.list());
        prefetch(PREFETCH_KEYS.builderAgents, () => api.agents.list());
        prefetch(PREFETCH_KEYS.builderHubMyItems, () => hubApi.myItems());
        prefetch(PREFETCH_KEYS.builderInstalled, () => api.builder.artifacts.installed());
        prefetch(PREFETCH_KEYS.hubAgents, () => hubApi.search({ type: 'agent', limit: 50 }));
        prefetch(PREFETCH_KEYS.hubTeams, () => hubApi.search({ type: 'team', limit: 50 }));
        prefetch(PREFETCH_KEYS.hubSkills, () => hubApi.search({ type: 'skill', limit: 50 }));
      })
      .catch(() => setAuthUser(null));

    wsClient.connect();
    const unsubNotif = wsClient.on('notification', () => {
      window.dispatchEvent(new CustomEvent('markus:notifications-changed'));
    });
    const onHash = () => {
      const p = getPageFromHash();
      setPage(p);
      setMountedPages(prev => prev.has(p) ? prev : new Set([...prev, p]));
    };
    window.addEventListener('hashchange', onHash);
    return () => { unsubNotif(); wsClient.disconnect(); window.removeEventListener('hashchange', onHash); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentUser = authUser !== 'loading' && authUser !== null ? authUser : undefined;
  const pageElements = useMemo<Partial<Record<PageId, React.JSX.Element>>>(() => {
    if (isMobile) {
      return {
        [PAGE.HOME]: <HomePage authUser={currentUser} />,
        [PAGE.TEAM]: <TeamPage authUser={currentUser} />,
        [PAGE.BUILDER]: <MobileBuilderTabs authUser={currentUser} />,
        [PAGE.SETTINGS]: <MobileSettingsTabs theme={theme.mode} onThemeChange={theme.setMode} />,
        [PAGE.WORK]: <WorkPage authUser={currentUser} />,
        [PAGE.DELIVERABLES]: <DeliverablesPage />,
      };
    }
    return {
      [PAGE.HOME]: <HomePage />,
      [PAGE.TEAM]: <TeamPage authUser={currentUser} />,
      [PAGE.SETTINGS]: <Settings theme={theme.mode} onThemeChange={theme.setMode} />,
      [PAGE.STORE]: <StorePage authUser={currentUser} />,
      [PAGE.BUILDER]: <AgentBuilder />,
      [PAGE.WORK]: <WorkPage authUser={currentUser} />,
      [PAGE.DELIVERABLES]: <DeliverablesPage />,
      [PAGE.REPORTS]: <ReportsPage authUser={currentUser} />,
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.id, theme.mode, isMobile]);

  if (authUser === 'loading') {
    return (
      <div className="min-h-dvh bg-surface-primary flex items-center justify-center">
        <div className="text-fg-tertiary text-sm animate-pulse">Loading…</div>
      </div>
    );
  }

  if (authUser === null) {
    return <Login onLogin={(user, isDefaultPassword) => {
      setAuthUser(user);
      if (isDefaultPassword) setMustChangePassword(true);
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
      onComplete={() => { localStorage.setItem('markus_onboarded', '1'); setShowOnboarding(false); checkLlmConfig(); }}
    />;
  }

  return (
    <div className={`flex h-dvh bg-surface-primary text-fg-primary overflow-x-hidden ${isMobile ? 'flex-col' : ''}`}>
      {/* Desktop sidebar */}
      {!isMobile && (
        <>
          <div
            className="relative z-40 shrink-0"
            style={{ width: sidebar.width }}
          >
            <Sidebar
              currentPage={page}
              onNavigate={(p) => { navigate(p); setSidebarOpen(false); }}
              authUser={authUser}
              onLogout={() => setAuthUser(null)}
              onUserUpdated={(u) => setAuthUser(u)}
              collapsed={sidebar.collapsed}
              onToggleCollapse={sidebar.toggle}
            />
          </div>

          {!sidebar.collapsed && (
            <div
              className="w-1 cursor-col-resize shrink-0 group relative z-10"
              onMouseDown={sidebar.onResizeStart}
            >
              <div className="absolute inset-y-0 -left-0.5 -right-0.5 group-hover:bg-brand-500/30 group-active:bg-brand-500/50 transition-colors" />
            </div>
          )}
        </>
      )}

      <div className={`flex-1 overflow-hidden flex flex-col min-w-0 ${isMobile ? 'pb-14' : ''}`}>
        {llmConfigured === false && !llmBannerDismissed && page !== PAGE.SETTINGS && (
          <div className="flex items-center justify-between px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 text-amber-600 text-sm shrink-0">
            <span className={isMobile ? 'text-xs' : ''}>No LLM provider configured — agents cannot process requests.</span>
            <div className="flex items-center gap-3">
              <button onClick={() => { navigate(PAGE.SETTINGS); }} className="px-3 py-1 bg-amber-700/50 hover:bg-amber-700/70 text-white text-xs rounded-lg transition-colors">
                Go to Settings
              </button>
              <button onClick={() => setLlmBannerDismissed(true)} className="text-amber-500 hover:text-amber-600 text-xs">Dismiss</button>
            </div>
          </div>
        )}
        {updateInfo && updateBannerDismissed !== updateInfo.latestVersion && (
          <div className="flex items-center justify-between px-4 py-2 bg-brand-500/10 border-b border-brand-500/30 text-brand-400 text-sm shrink-0">
            <span className={isMobile ? 'text-xs' : ''}>
              New version available: <strong>v{updateInfo.latestVersion}</strong> (current: v{updateInfo.currentVersion})
              {!isMobile && <span className="text-fg-tertiary ml-2">— run <code className="bg-surface-overlay px-1.5 py-0.5 rounded text-xs font-mono">npm i -g @markus-global/cli</code> to upgrade</span>}
            </span>
            <button onClick={() => { setUpdateBannerDismissed(updateInfo.latestVersion); localStorage.setItem('markus_update_dismissed', updateInfo.latestVersion); }} className="text-brand-400 hover:text-brand-300 text-xs shrink-0">Dismiss</button>
          </div>
        )}
        <main className="flex-1 overflow-hidden flex flex-col">
          {(Object.keys(pageElements) as PageId[]).map(id => (
            mountedPages.has(id) ? (
              <div
                key={id}
                className="flex-1 overflow-hidden flex flex-col"
                style={{ display: id === page ? 'flex' : 'none' }}
              >
                {pageElements[id]}
              </div>
            ) : null
          ))}
        </main>
      </div>

      {/* Mobile bottom nav */}
      {isMobile && (
        <BottomNav currentPage={page} onNavigate={navigate} />
      )}
    </div>
  );
}
