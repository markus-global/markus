import { useEffect, useState, useCallback, useMemo } from 'react';
import type { PageId } from './types.ts';
import { Dashboard } from './pages/Dashboard.tsx';
import { TaskBoard } from './pages/TaskBoard.tsx';
import { Chat } from './pages/Chat.tsx';
import { TeamPage } from './pages/Team.tsx';
import { Settings } from './pages/Settings.tsx';
import { SkillStore } from './pages/SkillStore.tsx';
import { TemplateMarketplace } from './pages/TemplateMarketplace.tsx';
import { AgentBuilder } from './pages/AgentBuilder.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { Onboarding } from './components/Onboarding.tsx';
import { Login } from './pages/Login.tsx';
import { ChangePassword } from './pages/ChangePassword.tsx';
import { api, type AuthUser, wsClient } from './api.ts';
import { navBus } from './navBus.ts';

const validPages: PageId[] = ['dashboard', 'tasks', 'chat', 'team', 'skills', 'templates', 'builder', 'settings'];

function getPageFromHash(): PageId {
  const hash = window.location.hash.slice(1);
  if (hash === 'agents') return 'team';
  return validPages.includes(hash as PageId) ? (hash as PageId) : 'dashboard';
}

export function App() {
  const [page, setPage] = useState<PageId>(getPageFromHash);
  const [showOnboarding, setShowOnboarding] = useState(() => !localStorage.getItem('markus_onboarded'));
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mountedPages, setMountedPages] = useState<Set<PageId>>(() => new Set([getPageFromHash()]));
  const [authUser, setAuthUser] = useState<AuthUser | null | 'loading'>('loading');
  const [mustChangePassword, setMustChangePassword] = useState(false);

  const navigate = useCallback((p: PageId) => {
    setPage(p);
    setMountedPages(prev => prev.has(p) ? prev : new Set([...prev, p]));
    window.location.hash = p;
  }, []);

  useEffect(() => {
    navBus.setHandler((p) => navigate(p as PageId));
  }, [navigate]);

  useEffect(() => {
    api.auth.me()
      .then(({ user }) => setAuthUser(user))
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
  const pageElements = useMemo<Record<PageId, React.JSX.Element>>(() => ({
    dashboard: <Dashboard />,
    tasks: <TaskBoard />,
    chat: <Chat authUser={currentUser} />,
    team: <TeamPage authUser={currentUser} />,
    settings: <Settings />,
    skills: <SkillStore />,
    templates: <TemplateMarketplace />,
    builder: <AgentBuilder />,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [currentUser?.id]);

  if (authUser === 'loading') {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
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
    <div className="flex h-screen bg-gray-950 text-gray-100">
      <button
        onClick={() => setSidebarOpen(!sidebarOpen)}
        className="md:hidden fixed top-3 left-3 z-50 p-2 bg-gray-800 rounded-lg text-gray-300"
      >
        {sidebarOpen ? '✕' : '☰'}
      </button>

      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 bg-black/50 z-30" onClick={() => setSidebarOpen(false)} />
      )}

      <div className={`${sidebarOpen ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0 fixed md:relative z-40 transition-transform duration-200`}>
        <Sidebar
          currentPage={page}
          onNavigate={(p) => { navigate(p); setSidebarOpen(false); }}
          authUser={authUser !== 'loading' && authUser !== null ? authUser : undefined}
          onLogout={() => setAuthUser(null)}
        />
      </div>

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
