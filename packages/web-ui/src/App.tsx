import { useState } from 'react';
import { Dashboard } from './pages/Dashboard.tsx';
import { Agents } from './pages/Agents.tsx';
import { TaskBoard } from './pages/TaskBoard.tsx';
import { Chat } from './pages/Chat.tsx';
import { Sidebar } from './components/Sidebar.tsx';

type Page = 'dashboard' | 'agents' | 'tasks' | 'chat';

export function App() {
  const [page, setPage] = useState<Page>('dashboard');

  const pages: Record<Page, React.JSX.Element> = {
    dashboard: <Dashboard />,
    agents: <Agents />,
    tasks: <TaskBoard />,
    chat: <Chat />,
  };

  return (
    <div className="flex h-screen">
      <Sidebar currentPage={page} onNavigate={setPage} />
      <main className="flex-1 overflow-hidden flex flex-col">
        {pages[page]}
      </main>
    </div>
  );
}
