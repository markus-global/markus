import { useState } from 'react';
import { AgentBuilder } from '../pages/AgentBuilder.tsx';
import { TemplateMarketplace } from '../pages/TemplateMarketplace.tsx';
import { TeamsStore } from '../pages/TeamsStore.tsx';
import { SkillStore } from '../pages/SkillStore.tsx';
import type { AuthUser } from '../api.ts';

const tabs = [
  { id: 'builder', label: 'Builder' },
  { id: 'agents', label: 'Agents' },
  { id: 'teams', label: 'Teams' },
  { id: 'skills', label: 'Skills' },
] as const;

type TabId = (typeof tabs)[number]['id'];

export function MobileBuilderTabs({ authUser }: { authUser?: AuthUser }) {
  const [activeTab, setActiveTab] = useState<TabId>('builder');

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
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
