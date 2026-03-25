import type { PageId } from '../types.ts';

const ICONS: Record<string, string> = {
  dashboard: 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M9 22V12h6v10',
  chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  projects: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',
  deliverables: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20 M4 19.5A2.5 2.5 0 0 0 6.5 22H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15z',
  builder: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
};

const tabs: Array<{ id: PageId; label: string; iconKey: string; group: PageId[] }> = [
  { id: 'dashboard', label: 'Home', iconKey: 'dashboard', group: ['dashboard'] },
  { id: 'chat', label: 'Chat', iconKey: 'chat', group: ['chat'] },
  { id: 'projects', label: 'Projects', iconKey: 'projects', group: ['projects'] },
  { id: 'deliverables', label: 'Deliverables', iconKey: 'deliverables', group: ['deliverables'] },
  { id: 'builder', label: 'Builder', iconKey: 'builder', group: ['builder', 'agents', 'teams', 'skills'] },
  { id: 'settings', label: 'Settings', iconKey: 'settings', group: ['settings', 'governance', 'reports'] },
];

interface Props {
  currentPage: PageId;
  onNavigate: (page: PageId) => void;
}

export function BottomNav({ currentPage, onNavigate }: Props) {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 bg-surface-secondary border-t border-border-default flex items-stretch h-14 safe-area-bottom">
      {tabs.map(tab => {
        const isActive = tab.group.includes(currentPage);
        return (
          <button
            key={tab.id}
            onClick={() => onNavigate(tab.id)}
            className={`flex-1 flex flex-col items-center justify-center gap-0.5 transition-colors ${
              isActive
                ? 'text-brand-500'
                : 'text-fg-tertiary active:text-fg-secondary'
            }`}
          >
            <svg
              width={20}
              height={20}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={isActive ? 2 : 1.75}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="shrink-0"
            >
              <path d={ICONS[tab.iconKey]!} />
            </svg>
            <span className={`text-[10px] leading-tight ${isActive ? 'font-semibold' : ''}`}>
              {tab.label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
