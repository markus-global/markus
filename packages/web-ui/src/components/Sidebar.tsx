interface Props {
  currentPage: string;
  onNavigate: (page: 'dashboard' | 'agents' | 'tasks' | 'chat') => void;
}

const navItems = [
  { id: 'dashboard' as const, label: 'Dashboard', icon: '▦' },
  { id: 'agents' as const, label: 'Agents', icon: '⊕' },
  { id: 'tasks' as const, label: 'Task Board', icon: '☑' },
  { id: 'chat' as const, label: 'Chat', icon: '◈' },
];

export function Sidebar({ currentPage, onNavigate }: Props) {
  return (
    <aside className="w-60 bg-gray-900 border-r border-gray-800 flex flex-col shrink-0">
      <div className="p-5 border-b border-gray-800">
        <h1 className="text-xl font-bold bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">
          Markus
        </h1>
        <p className="text-xs text-gray-500 mt-0.5">AI Digital Employee Platform</p>
      </div>
      <nav className="p-3 flex-1">
        {navItems.map((item) => (
          <button
            key={item.id}
            onClick={() => onNavigate(item.id)}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm mb-0.5 transition-colors ${
              currentPage === item.id
                ? 'bg-indigo-600 text-white'
                : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
            }`}
          >
            <span className="text-base">{item.icon}</span>
            {item.label}
          </button>
        ))}
      </nav>
      <div className="p-4 border-t border-gray-800 text-xs text-gray-600">
        v0.4.0 Phase 4
      </div>
    </aside>
  );
}
