import { useState, useEffect } from 'react';
import { TemplateMarketplace } from './TemplateMarketplace.tsx';
import { TeamsStore } from './TeamsStore.tsx';
import { SkillStore } from './SkillStore.tsx';
import { useSwipeTabs } from '../hooks/useSwipeTabs.ts';
import type { AuthUser } from '../api.ts';

const tabs = [
  { id: 'agents', label: 'Agents' },
  { id: 'teams', label: 'Teams' },
  { id: 'skills', label: 'Skills' },
] as const;

type TabId = (typeof tabs)[number]['id'];

function readStoreTab(): TabId {
  const raw = localStorage.getItem('markus_nav_storeTab');
  if (raw) localStorage.removeItem('markus_nav_storeTab');
  if (raw === 'agents' || raw === 'teams' || raw === 'skills') return raw;
  return 'agents';
}

export function StorePage({ authUser }: { authUser?: AuthUser }) {
  const [activeTab, setActiveTab] = useState<TabId>(readStoreTab);
  const swipe = useSwipeTabs(tabs, activeTab, setActiveTab);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ page: string; params?: Record<string, string> }>).detail;
      if (detail.page === 'store') {
        const tab = localStorage.getItem('markus_nav_storeTab');
        if (tab) {
          localStorage.removeItem('markus_nav_storeTab');
          if (tab === 'agents' || tab === 'teams' || tab === 'skills') setActiveTab(tab);
        }
      }
    };
    window.addEventListener('markus:navigate', handler);
    return () => window.removeEventListener('markus:navigate', handler);
  }, []);

  return (
    <div className="flex-1 overflow-hidden flex flex-col" onTouchStart={swipe.onTouchStart} onTouchEnd={swipe.onTouchEnd}>
      <div className="flex border-b border-border-default bg-surface-secondary shrink-0">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 min-w-0 px-4 py-3 text-sm font-medium text-center whitespace-nowrap transition-colors border-b-2 ${
              activeTab === tab.id
                ? 'border-brand-500 text-brand-500'
                : 'border-transparent text-fg-tertiary hover:text-fg-secondary'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-hidden flex flex-col">
        {activeTab === 'agents' && <TemplateMarketplace authUser={authUser} />}
        {activeTab === 'teams' && <TeamsStore />}
        {activeTab === 'skills' && <SkillStore />}
      </div>
    </div>
  );
}
