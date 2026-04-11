import { useState, useEffect } from 'react';
import { TemplateMarketplace } from './TemplateMarketplace.tsx';
import { TeamsStore } from './TeamsStore.tsx';
import { SkillStore } from './SkillStore.tsx';
import { useSwipeTabs } from '../hooks/useSwipeTabs.ts';
import { useIsMobile } from '../hooks/useIsMobile.ts';
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
  const isMobile = useIsMobile();
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

  if (isMobile) {
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

  return (
    <div className="flex-1 overflow-hidden flex flex-row">
      <nav className="w-48 shrink-0 border-r border-border-default bg-surface-secondary/50 flex flex-col py-4 px-2 gap-1">
        <div className="px-3 pb-3 mb-1 border-b border-border-default/50">
          <h2 className="text-xs font-semibold text-fg-tertiary uppercase tracking-wider">Store</h2>
        </div>
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
              activeTab === tab.id
                ? 'bg-brand-600/15 text-brand-400 shadow-sm shadow-brand-500/10'
                : 'text-fg-tertiary hover:text-fg-secondary hover:bg-surface-elevated/50'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </nav>
      <div className="flex-1 overflow-hidden flex flex-col">
        {activeTab === 'agents' && <TemplateMarketplace authUser={authUser} />}
        {activeTab === 'teams' && <TeamsStore />}
        {activeTab === 'skills' && <SkillStore />}
      </div>
    </div>
  );
}
