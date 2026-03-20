import { useEffect, useState, useCallback, useMemo } from 'react';
import type { PageId } from './types.ts';
import { Dashboard } from './pages/Dashboard.tsx';
import { Chat } from './pages/Chat.tsx';
import { Settings } from './pages/Settings.tsx';
import { SkillStore } from './pages/SkillStore.tsx';
import { TemplateMarketplace } from './pages/TemplateMarketplace.tsx';
import { TeamsStore } from './pages/TeamsStore.tsx';
import { AgentBuilder } from './pages/AgentBuilder.tsx';
import { GovernancePage } from './pages/Governance.tsx';
import { ProjectsPage } from './pages/Projects.tsx';
import { DeliverablesPage } from './pages/Deliverables.tsx';
import { ReportsPage } from './pages/Reports.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { Onboarding } from './components/Onboarding.tsx';
import { Login } from './pages/Login.tsx';
import { ChangePassword } from './pages/ChangePassword.tsx';
import { api, hubApi, type AuthUser, wsClient } from './api.ts';
import { navBus } from './navBus.ts';
import { useResizablePanel } from './hooks/useResizablePanel.ts';
import { prefetch, PREFETCH_KEYS } from './prefetchCache.ts';

const validPages: PageId[] = ['dashboard', 'tasks', 'chat', 'team', 'usage', 'skills', 'agents', 'teams', 'builder', 'prompts', 'settings', 'governance', 'projects', 'deliverables', 'reports'];

function getPageFromHash(): PageId {
  const hash = window.location.hash.slice(1).split('/')[0];
  if (hash === 'team') return 'chat';
  if (hash === 'tasks') return 'projects';
  if (hash === 'usage') return 'reports';
  if (hash === 'prompts') return 'builder';
  if (hash === 'templates') return 'agents';
  if (hash === 'knowledge') return 'deliverables';
  return validPages.includes(hash as PageId) ? (hash as PageId) : 'dashboard';
}

export function App() {
  const [page, setPage] = useState<PageId>(getPageFromHash);
  const [showOnboarding, setShowOnboarding] = useState(() => !localStorage.getItem('markus_onboarded'));
  const [sidebarOpen, setSidebarOpen] = useState(true);
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

  const navigate = useCallback((p: PageId) => {
    const normalized: PageId = p === 'tasks' ? 'projects' : p === 'team' ? 'chat' : p === 'usage' ? 'reports' : p === 'prompts' ? 'builder' : (p as string) === 'templates' ? 'agents' : p;
    setPage(normalized);
    setMountedPages(prev => prev.has(normalized) ? prev : new Set([...prev, normalized]));
    window.location.hash = normalized;
  }, []);

  useEffect(() => {
    navBus.setHandler((p) => navigate(p as PageId));
  }, [navigate]);

  useEffect(() => {
    api.auth.me()
      .then(({ user }) => {
        setAuthUser(user);
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
    const onHash = () => {
      const p = getPageFromHash();
      setPage(p);
      setMountedPages(prev => prev.has(p) ? prev : new Set([...prev, p]));
    };
    window.addEventListener('hashchange', onHash);
    return () => { wsClient.disconnect(); window.removeEventListener('hashchange', onHash); };
  }, []);

  const currentUser = authUser !== 'loading' && authUser !== null ? authUser : undefined;
  const pageElements = useMemo<Partial<Record<PageId, React.JSX.Element>>>(() => ({
    dashboard: <Dashboard />,
    chat: <Chat authUser={currentUser} />,
    settings: <Settings />,
    skills: <SkillStore />,
    agents: <TemplateMarketplace authUser={currentUser} />,
    teams: <TeamsStore />,
    builder: <AgentBuilder />,
    governance: <GovernancePage />,
    projects: <ProjectsPage authUser={currentUser} />,
    deliverables: <DeliverablesPage />,
    reports: <ReportsPage />,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [currentUser?.id]);

  if (authUser === 'loading') {
    return (
      <div className="min-h-screen bg-surface-primary flex items-center justify-center">
        <div className="text-gray-600 text-sm animate-pulse">Loading…</div>
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
    return <Onboarding onComplete={() => { localStorage.setItem('markus_onboarded', '1'); setShowOnboarding(false); }} />;
  }

  return (
    <div className="flex h-screen bg-surface-primary text-gray-100">
      <button
        onClick={() => setSidebarOpen(!sidebarOpen)}
        className="md:hidden fixed top-3 left-3 z-50 p-2 bg-surface-elevated rounded-lg text-gray-300"
      >
        {sidebarOpen ? '✕' : '☰'}
      </button>

      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 bg-black/50 z-30" onClick={() => setSidebarOpen(false)} />
      )}

      <div
        className={`${sidebarOpen ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0 fixed md:relative z-40 transition-transform duration-200 shrink-0`}
        style={{ width: sidebar.width }}
      >
        <Sidebar
          currentPage={page}
          onNavigate={(p) => { navigate(p); setSidebarOpen(false); }}
          authUser={authUser !== 'loading' && authUser !== null ? authUser : undefined}
          onLogout={() => setAuthUser(null)}
          collapsed={sidebar.collapsed}
          onToggleCollapse={sidebar.toggle}
        />
      </div>

      {/* Resize handle for main sidebar */}
      {!sidebar.collapsed && (
        <div
          className="hidden md:block w-1 cursor-col-resize shrink-0 group relative z-10"
          onMouseDown={sidebar.onResizeStart}
        >
          <div className="absolute inset-y-0 -left-0.5 -right-0.5 group-hover:bg-brand-500/30 group-active:bg-brand-500/50 transition-colors" />
        </div>
      )}

      <div className="flex-1 overflow-hidden flex flex-col min-w-0">
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
    </div>
  );
}
