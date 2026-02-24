import { useEffect, useState } from 'react';
import type { PageId } from './types.ts';
import { Dashboard } from './pages/Dashboard.tsx';
import { Agents } from './pages/Agents.tsx';
import { TaskBoard } from './pages/TaskBoard.tsx';
import { Chat } from './pages/Chat.tsx';
import { TeamPage } from './pages/Team.tsx';
import { Settings } from './pages/Settings.tsx';
import { SkillStore } from './pages/SkillStore.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { CommandBar } from './components/CommandBar.tsx';
import { wsClient } from './api.ts';

export function App() {
  const [page, setPage] = useState<PageId>('dashboard');

  useEffect(() => {
    wsClient.connect();
    return () => wsClient.disconnect();
  }, []);

  const pages: Record<PageId, React.JSX.Element> = {
    dashboard: <Dashboard />,
    agents: <Agents />,
    tasks: <TaskBoard />,
    chat: <Chat />,
    team: <TeamPage />,
    settings: <Settings />,
    skills: <SkillStore />,
  };

  return (
    <div className="flex h-screen">
      <Sidebar currentPage={page} onNavigate={setPage} />
      <div className="flex-1 overflow-hidden flex flex-col">
        <main className="flex-1 overflow-hidden flex flex-col">
          {pages[page]}
        </main>
        <CommandBar onNavigate={(p) => setPage(p as PageId)} />
      </div>
    </div>
  );
}
