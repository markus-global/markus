import type { PageId } from '../types.ts';

interface Props {
  currentPage: string;
  onNavigate: (page: PageId) => void;
}

const navItems: Array<{ id: PageId; label: string; icon: string; section?: string }> = [
  { id: 'dashboard', label: 'Overview', icon: '▦', section: 'team' },
  { id: 'chat', label: 'Workspace', icon: '◈', section: 'team' },
  { id: 'messages', label: 'Messages', icon: '✉', section: 'team' },
  { id: 'tasks', label: 'Tasks', icon: '☑', section: 'team' },
  { id: 'team', label: 'Team', icon: '◎', section: 'members' },
  { id: 'agents', label: 'Agents', icon: '⊕', section: 'members' },
  { id: 'skills', label: 'Skill Store', icon: '◆', section: 'tools' },
  { id: 'settings', label: 'Settings', icon: '⚙', section: 'tools' },
];

export function Sidebar({ currentPage, onNavigate }: Props) {
  const sections = [
    { key: 'team', label: 'WORKSPACE' },
    { key: 'members', label: 'ORGANIZATION' },
    { key: 'tools', label: 'TOOLS & SETTINGS' },
  ];

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
      <div className="p-4 border-t border-gray-800 text-xs text-gray-600">
        v0.7.0
      </div>
    </aside>
  );
}
