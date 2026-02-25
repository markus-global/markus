import { useEffect, useState, useCallback } from 'react';
import type { PageId } from './types.ts';
import { Dashboard } from './pages/Dashboard.tsx';
import { Agents } from './pages/Agents.tsx';
import { TaskBoard } from './pages/TaskBoard.tsx';
import { Chat } from './pages/Chat.tsx';
import { TeamPage } from './pages/Team.tsx';
import { Settings } from './pages/Settings.tsx';
import { SkillStore } from './pages/SkillStore.tsx';
import { Messages } from './pages/Messages.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { CommandBar } from './components/CommandBar.tsx';
import { Onboarding } from './components/Onboarding.tsx';
import { wsClient } from './api.ts';

const validPages: PageId[] = ['dashboard', 'agents', 'tasks', 'chat', 'messages', 'team', 'skills', 'settings'];

function getPageFromHash(): PageId {
  const hash = window.location.hash.slice(1);
  return validPages.includes(hash as PageId) ? (hash as PageId) : 'dashboard';
}

export function App() {
  const [page, setPage] = useState<PageId>(getPageFromHash);
  const [showOnboarding, setShowOnboarding] = useState(() => !localStorage.getItem('markus_onboarded'));
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const navigate = useCallback((p: PageId) => {
    setPage(p);
    window.location.hash = p;
  }, []);

  useEffect(() => {
    wsClient.connect();
    const onHash = () => setPage(getPageFromHash());
    window.addEventListener('hashchange', onHash);
    return () => { wsClient.disconnect(); window.removeEventListener('hashchange', onHash); };
  }, []);

  if (showOnboarding) {
    return <Onboarding onComplete={() => { localStorage.setItem('markus_onboarded', '1'); setShowOnboarding(false); }} />;
  }

  const pages: Record<PageId, React.JSX.Element> = {
    dashboard: <Dashboard />,
    agents: <Agents />,
    tasks: <TaskBoard />,
    chat: <Chat />,
    messages: <Messages />,
    team: <TeamPage />,
    settings: <Settings />,
    skills: <SkillStore />,
  };

  return (
    <div className="flex h-screen bg-gray-950 text-gray-100">
      {/* Mobile menu button */}
      <button
        onClick={() => setSidebarOpen(!sidebarOpen)}
        className="md:hidden fixed top-3 left-3 z-50 p-2 bg-gray-800 rounded-lg text-gray-300"
      >
        {sidebarOpen ? '✕' : '☰'}
      </button>

      {/* Sidebar overlay on mobile */}
      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 bg-black/50 z-30" onClick={() => setSidebarOpen(false)} />
      )}

      <div className={`${sidebarOpen ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0 fixed md:relative z-40 transition-transform duration-200`}>
        <Sidebar currentPage={page} onNavigate={(p) => { navigate(p); setSidebarOpen(false); }} />
      </div>

      <div className="flex-1 overflow-hidden flex flex-col min-w-0">
        <main className="flex-1 overflow-hidden flex flex-col">
          {pages[page]}
        </main>
        <CommandBar onNavigate={(p) => navigate(p as PageId)} />
      </div>
    </div>
  );
}
