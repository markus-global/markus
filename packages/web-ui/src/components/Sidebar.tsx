import type { PageId } from '../types.ts';
import { api, type AuthUser } from '../api.ts';

interface Props {
  currentPage: string;
  onNavigate: (page: PageId) => void;
  authUser?: AuthUser;
  onLogout?: () => void;
}

const navItems: Array<{ id: PageId; label: string; icon: string; section: string }> = [
  { id: 'dashboard', label: 'Overview', icon: '▦', section: 'workspace' },
  { id: 'team', label: 'Team', icon: '◎', section: 'workspace' },
  { id: 'chat', label: 'Chat', icon: '◈', section: 'workspace' },
  { id: 'tasks', label: 'Tasks', icon: '☑', section: 'workspace' },
  { id: 'projects', label: 'Projects', icon: '◫', section: 'workspace' },
  { id: 'usage', label: 'Usage & Costs', icon: '◇', section: 'workspace' },
  { id: 'governance', label: 'Governance', icon: '⛨', section: 'govern' },
  { id: 'reports', label: 'Reports', icon: '▤', section: 'govern' },
  { id: 'knowledge', label: 'Knowledge', icon: '◉', section: 'govern' },
  { id: 'templates', label: 'Templates', icon: '⧉', section: 'explore' },
  { id: 'builder', label: 'Builder', icon: '⊞', section: 'explore' },
  { id: 'skills', label: 'Skill Store', icon: '◆', section: 'explore' },
  { id: 'settings', label: 'Settings', icon: '⚙', section: 'explore' },
];

const sections = [
  { key: 'workspace', label: 'WORKSPACE' },
  { key: 'govern', label: 'GOVERNANCE' },
  { key: 'explore', label: 'EXPLORE' },
];

export function Sidebar({ currentPage, onNavigate, authUser, onLogout }: Props) {
  const handleLogout = async () => {
    try { await api.auth.logout(); } catch { /* ignore */ }
    onLogout?.();
  };

  return (
    <aside className="w-60 h-screen bg-gray-900 border-r border-gray-800 flex flex-col shrink-0">
      <div className="p-5 border-b border-gray-800">
        <h1 className="text-xl font-bold bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">
          Markus
        </h1>
        <p className="text-xs text-gray-500 mt-0.5">AI Digital Employee Platform</p>
      </div>
      <nav className="p-3 flex-1 overflow-y-auto">
        {sections.map((section) => (
          <div key={section.key} className="mb-3">
            <div className="px-3 py-1.5 text-[10px] font-semibold text-gray-600 uppercase tracking-wider">
              {section.label}
            </div>
            {navItems.filter(i => i.section === section.key).map((item) => (
              <button
                key={item.id}
                onClick={() => onNavigate(item.id)}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm mb-0.5 transition-colors ${
                  currentPage === item.id
                    ? 'bg-indigo-600 text-white'
                    : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                }`}
              >
                <span className="text-base">{item.icon}</span>
                {item.label}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="p-4 border-t border-gray-800 space-y-2">
        {authUser && (
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-full bg-indigo-600 flex items-center justify-center text-white text-xs font-bold shrink-0">
              {authUser.name?.[0]?.toUpperCase() ?? 'A'}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs text-gray-300 truncate">{authUser.name ?? authUser.email}</div>
              <div className="text-[10px] text-gray-600 truncate">{authUser.role}</div>
            </div>
            <button
              onClick={handleLogout}
              title="Sign out"
              className="text-gray-600 hover:text-gray-300 transition-colors text-sm"
            >
              ⇥
            </button>
          </div>
        )}
        <div className="text-[10px] text-gray-700">v0.7.0</div>
      </div>
    </aside>
  );
}
