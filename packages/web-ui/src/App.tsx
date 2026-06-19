import { useEffect, useState, useCallback, useMemo, memo } from 'react';
import { type PageId, PAGE, resolvePageId, getPageFromHash, MOBILE_REDIRECTS } from './routes.ts';
import { HomePage } from './pages/Home.tsx';
import { TeamPage } from './pages/Team.tsx';
import { Settings } from './pages/Settings.tsx';
import { StorePage } from './pages/Store.tsx';
import { AgentBuilder } from './pages/AgentBuilder.tsx';
import { WorkPage } from './pages/Work.tsx';
import { DeliverablesPage } from './pages/Deliverables.tsx';
import { ReportsPage } from './pages/Reports.tsx';
import { NotificationsPage } from './pages/Notifications.tsx';
import { SearchPage } from './pages/Search.tsx';
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
import { useTheme } from './hooks/useTheme.ts';
import { useIsMobile } from './hooks/useIsMobile.ts';
import { prefetch, PREFETCH_KEYS } from './prefetchCache.ts';
import { useTranslation } from 'react-i18next';
import { SearchModal } from './components/SearchModal.tsx';

const HIDDEN_STYLE: React.CSSProperties = {
  visibility: 'hidden',
  position: 'absolute',
  inset: 0,
  pointerEvents: 'none',
  zIndex: -1,
};

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
      {children}
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

export function App() {
  const { t } = useTranslation('common');
  const [page, setPage] = useState<PageId>(getPageFromHash);
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
  const [mountedPages, setMountedPages] = useState<Set<PageId>>(() => new Set([getPageFromHash()]));
  const [authUser, setAuthUser] = useState<AuthUser | null | 'loading'>('loading');
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
  const [licenseLimit, setLicenseLimit] = useState<{ teams?: boolean; toolCalls?: boolean } | null>(null);
  const [licenseLimitDismissed, setLicenseLimitDismissed] = useState(false);

  const checkLicenseLimits = useCallback(() => {
    api.license.get().then(lic => {
      if (lic.plan === 'enterprise') { setLicenseLimit(null); return; }
      if (lic.usage && lic.limits) {
        const hitTeams = lic.limits.maxTeams > 0 && lic.usage.teams >= lic.limits.maxTeams;
        const hitTools = lic.limits.maxToolCallsPerDay > 0 && lic.usage.toolCallsToday >= lic.limits.maxToolCallsPerDay;
        if (hitTeams || hitTools) { setLicenseLimit({ teams: hitTeams || undefined, toolCalls: hitTools || undefined }); setLicenseLimitDismissed(false); }
        else setLicenseLimit(null);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') checkLicenseLimits(); };
    window.addEventListener('markus:check-license-limits', checkLicenseLimits);
    document.addEventListener('visibilitychange', onVisible);
    const interval = setInterval(checkLicenseLimits, 5 * 60 * 1000);
    return () => { window.removeEventListener('markus:check-license-limits', checkLicenseLimits); document.removeEventListener('visibilitychange', onVisible); clearInterval(interval); };
  }, [checkLicenseLimits]);

  const [showSearchModal, setShowSearchModal] = useState(false);

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

  const navigate = useCallback((p: PageId) => {
    let normalized = resolvePageId(p);
    if (isMobile) {
      normalized = MOBILE_REDIRECTS[normalized] ?? normalized;
    } else if (normalized === PAGE.NOTIFICATIONS) {
      normalized = PAGE.HOME;
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

  useEffect(() => {
    // Deep link: ?install=ITEM_ID&type=agent|team|skill — navigate to Store if not already there
    const urlParams = new URLSearchParams(window.location.search);
    const installItemId = urlParams.get('install');
    if (installItemId && getPageFromHash() !== PAGE.STORE) {
      const itemType = urlParams.get('type');
      const tabMap: Record<string, string> = { agent: 'agents', team: 'teams', skill: 'skills' };
      const storeTab = (itemType && tabMap[itemType]) || 'agents';
      localStorage.setItem('markus_nav_installItem', installItemId);
      localStorage.setItem('markus_nav_storeTab', storeTab);
      urlParams.delete('install');
      urlParams.delete('type');
      const qs = urlParams.toString();
      window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : '') + '#store');
      setTimeout(() => navBus.navigate(PAGE.STORE, { storeTab, installItem: installItemId }), 300);
    }

    api.auth.me()
      .then(({ user }) => {
        setAuthUser(user);
        setSystemInitialized(true);
        wsClient.connect(user.id);
        checkLlmConfig();
        api.health().then(h => {
          if (h.updateAvailable && h.latestVersion) {
            setUpdateInfo({ latestVersion: h.latestVersion, currentVersion: h.version });
          }
        }).catch(() => {});
        checkLicenseLimits();
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
      const p = getPageFromHash();
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
        [PAGE.REPORTS]: <ReportsPage authUser={currentUser} />,
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
      [PAGE.REPORTS]: <ReportsPage authUser={currentUser} />,
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
      onComplete={() => {
        localStorage.setItem('markus_onboarded', '1');
        setShowOnboarding(false);
        setSkipOnboardingProfile(false);
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
              onNavigate={(p) => { navigate(p); setSidebarOpen(false); }}
              authUser={authUser}
              collapsed={sidebar.collapsed}
              onToggleCollapse={sidebar.toggle}
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
              <a href="https://markus.global/download" target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-brand-400 hover:text-brand-300 transition-colors">{t('update.download')}</a>
              <button onClick={() => { setUpdateBannerDismissed(updateInfo.latestVersion); localStorage.setItem('markus_update_dismissed', updateInfo.latestVersion); }} className="text-fg-tertiary hover:text-fg-secondary text-xs shrink-0">{t('dismiss')}</button>
            </span>
          </div>
        )}
        {licenseLimit && !licenseLimitDismissed && page !== PAGE.SETTINGS && (
          <div className="flex items-center justify-between px-4 py-2 bg-orange-500/10 border-b border-orange-500/30 text-orange-400 text-sm shrink-0">
            <span className={isMobile ? 'text-xs' : ''}>
              {licenseLimit.teams && licenseLimit.toolCalls
                ? t('license.limitReachedBoth')
                : licenseLimit.teams
                  ? t('license.limitReachedTeams')
                  : t('license.limitReachedToolCalls')}
            </span>
            <span className="flex items-center gap-3 shrink-0">
              <button onClick={() => { window.location.hash = 'settings/account'; }} className="px-3 py-1 bg-orange-600/50 hover:bg-orange-600/70 text-white text-xs rounded-lg transition-colors">{t('license.upgradeLicense')}</button>
              <button onClick={() => setLicenseLimitDismissed(true)} className="text-fg-tertiary hover:text-fg-secondary text-xs shrink-0">{t('dismiss')}</button>
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
    </div>
  );
}
