import type { PageId } from '../types.ts';
import { api, type AuthUser } from '../api.ts';

interface Props {
  currentPage: string;
  onNavigate: (page: PageId) => void;
  authUser?: AuthUser;
  onLogout?: () => void;
}

function Icon({ d, size = 18 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <path d={d} />
    </svg>
  );
}

const ICONS: Record<string, string> = {
  dashboard: 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M9 22V12h6v10',
  projects:  'M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2 M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v0H9z M9 14l2 2 4-4',
  team:      'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
  chat:      'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  reports:   'M18 20V10 M12 20V4 M6 20v-6',
  knowledge: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20 M4 19.5A2.5 2.5 0 0 0 6.5 22H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15z',
  usage:     'M21.21 15.89A10 10 0 1 1 8 2.83 M22 12A10 10 0 0 0 12 2v10z',
  builder:   'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
  templates: 'M8 3H5a2 2 0 0 0-2 2v3 M21 8V5a2 2 0 0 0-2-2h-3 M3 16v3a2 2 0 0 0 2 2h3 M16 21h3a2 2 0 0 0 2-2v-3 M9 9h6v6H9z',
  skills:    'M12 2L2 7l10 5 10-5-10-5z M2 17l10 5 10-5 M2 12l10 5 10-5',
  governance:'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  settings:  'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
};

const navItems: Array<{ id: PageId; label: string; section: string }> = [
  { id: 'dashboard', label: 'Overview', section: 'workspace' },
  { id: 'projects', label: 'Work', section: 'workspace' },
  { id: 'team', label: 'Team', section: 'workspace' },
  { id: 'chat', label: 'Chat', section: 'workspace' },
  { id: 'reports', label: 'Reports', section: 'insights' },
  { id: 'knowledge', label: 'Knowledge', section: 'insights' },
  { id: 'usage', label: 'Usage', section: 'insights' },
  { id: 'builder', label: 'Builder', section: 'build' },
  { id: 'templates', label: 'Templates', section: 'build' },
  { id: 'skills', label: 'Skills', section: 'build' },
  { id: 'governance', label: 'Governance', section: 'system' },
  { id: 'settings', label: 'Settings', section: 'system' },
];

const sections = [
  { key: 'workspace', label: 'WORKSPACE' },
  { key: 'insights', label: 'INSIGHTS' },
  { key: 'build', label: 'BUILD' },
  { key: 'system', label: 'SYSTEM' },
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
                <Icon d={ICONS[item.id] ?? ''} />
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
