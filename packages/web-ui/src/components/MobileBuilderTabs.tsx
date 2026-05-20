import { useState, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { AgentBuilder } from '../pages/AgentBuilder.tsx';
import { TemplateMarketplace } from '../pages/TemplateMarketplace.tsx';
import { TeamsStore } from '../pages/TeamsStore.tsx';
import { SkillStore } from '../pages/SkillStore.tsx';
import { useSwipeTabs } from '../hooks/useSwipeTabs.ts';
import { MobileMenuButton } from './MobileMenuButton.tsx';
import type { AuthUser } from '../api.ts';

const tabIds = ['builder', 'agents', 'teams', 'skills'] as const;
type TabId = (typeof tabIds)[number];

function getInitialTab(): TabId {
  const stored = localStorage.getItem('markus_nav_storeTab');
  if (stored) {
    localStorage.removeItem('markus_nav_storeTab');
    if (tabIds.includes(stored as TabId)) return stored as TabId;
  }
  return 'builder';
}

export function MobileBuilderTabs({ authUser }: { authUser?: AuthUser }) {
  const { t } = useTranslation(['nav', 'common']);
  const tabs = useMemo(() => [
    { id: 'builder' as const, label: t('nav:builder') },
    { id: 'agents' as const, label: t('nav:tabs.agents') },
    { id: 'teams' as const, label: t('nav:tabs.teams') },
    { id: 'skills' as const, label: t('nav:tabs.skills') },
  ], [t]);
  const [activeTab, setActiveTab] = useState<TabId>(getInitialTab);
  const swipe = useSwipeTabs(tabs, activeTab, setActiveTab);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ page: string; params?: Record<string, string> }>).detail;
      if (detail.params?.storeTab && tabIds.includes(detail.params.storeTab as TabId)) {
        setActiveTab(detail.params.storeTab as TabId);
      }
    };
    window.addEventListener('markus:navigate', handler);
    return () => window.removeEventListener('markus:navigate', handler);
  }, []);

  return (
    <div className="flex-1 overflow-hidden flex flex-col" onTouchStart={swipe.onTouchStart} onTouchEnd={swipe.onTouchEnd}>
      <div className="flex items-center shrink-0 overflow-x-auto scrollbar-hide">
        <MobileMenuButton className="ml-2" />
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 min-w-0 px-3 py-2.5 text-xs font-medium text-center whitespace-nowrap transition-colors border-b-2 ${
              activeTab === tab.id
                ? 'border-brand-500 text-brand-500'
                : 'border-transparent text-fg-tertiary'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-hidden flex flex-col">
        {activeTab === 'builder' && <AgentBuilder />}
        {activeTab === 'agents' && <TemplateMarketplace authUser={authUser} />}
        {activeTab === 'teams' && <TeamsStore />}
        {activeTab === 'skills' && <SkillStore />}
      </div>
    </div>
  );
}
