import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AgentBuilder } from '../pages/AgentBuilder.tsx';
import { TemplateMarketplace } from '../pages/TemplateMarketplace.tsx';
import { TeamsStore } from '../pages/TeamsStore.tsx';
import { SkillStore } from '../pages/SkillStore.tsx';
import { useSwipeTabs } from '../hooks/useSwipeTabs.ts';
import type { AuthUser } from '../api.ts';

const tabIds = ['builder', 'agents', 'teams', 'skills'] as const;
type TabId = (typeof tabIds)[number];

export function MobileBuilderTabs({ authUser }: { authUser?: AuthUser }) {
  const { t } = useTranslation(['nav', 'common']);
  const tabs = useMemo(() => [
    { id: 'builder' as const, label: t('nav:builder') },
    { id: 'agents' as const, label: t('nav:tabs.agents') },
    { id: 'teams' as const, label: t('nav:tabs.teams') },
    { id: 'skills' as const, label: t('nav:tabs.skills') },
  ], [t]);
  const [activeTab, setActiveTab] = useState<TabId>('builder');
  const swipe = useSwipeTabs(tabs, activeTab, setActiveTab);

  return (
    <div className="flex-1 overflow-hidden flex flex-col" onTouchStart={swipe.onTouchStart} onTouchEnd={swipe.onTouchEnd}>
      <div className="flex border-b border-border-default bg-surface-secondary shrink-0 overflow-x-auto scrollbar-hide">
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
