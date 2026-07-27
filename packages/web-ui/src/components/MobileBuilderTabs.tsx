import { useState, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { AgentBuilder } from '../pages/AgentBuilder.tsx';
import { TemplateMarketplace } from '../pages/TemplateMarketplace.tsx';
import { TeamsStore } from '../pages/TeamsStore.tsx';
import { SkillStore } from '../pages/SkillStore.tsx';
import { StoreDiscovery } from '../pages/StoreDiscovery.tsx';
import { InstalledStore } from '../pages/InstalledStore.tsx';
import { useSwipeTabs } from '../hooks/useSwipeTabs.ts';
import { MobileMenuButton } from './MobileMenuButton.tsx';
import type { AuthUser } from '../api.ts';
import type { AssetType } from '../lib/assetIdentity.ts';

const tabIds = ['builder', 'discover', 'agents', 'teams', 'skills', 'installed'] as const;
type TabId = (typeof tabIds)[number];

// Connectors are a subtype of skill, so they live inside the Skills tab.
const TYPE_TO_TAB: Record<string, TabId> = { agent: 'agents', team: 'teams', skill: 'skills', connector: 'skills' };

function isTabId(v: string | null | undefined): v is TabId {
  return !!v && (tabIds as readonly string[]).includes(v);
}

function peekInstall(): { tab: TabId; installId: string | null } {
  const lsItem = localStorage.getItem('markus_nav_installItem');
  const lsTab = localStorage.getItem('markus_nav_storeTab');
  const tab: TabId = isTabId(lsTab) ? lsTab : 'builder';
  return { tab, installId: lsItem };
}

export function MobileBuilderTabs({ authUser }: { authUser?: AuthUser }) {
  const { t } = useTranslation(['nav', 'store', 'common']);
  const tabs = useMemo(() => [
    { id: 'builder' as const, label: t('nav:tabs.create') },
    { id: 'discover' as const, label: t('nav:tabs.discover') },
    { id: 'agents' as const, label: t('nav:tabs.agents') },
    { id: 'teams' as const, label: t('nav:tabs.teams') },
    { id: 'skills' as const, label: t('nav:tabs.skills') },
    { id: 'installed' as const, label: t('nav:tabs.installed') },
  ], [t]);
  const [initial] = useState(peekInstall);
  const [activeTab, setActiveTab] = useState<TabId>(initial.tab);
  const [highlightItemId, setHighlightItemId] = useState<string | null>(initial.installId);
  const swipe = useSwipeTabs(tabs, activeTab, setActiveTab);

  useEffect(() => {
    const peek = peekInstall();
    if (peek.installId) {
      setHighlightItemId(peek.installId);
      if (isTabId(peek.tab)) setActiveTab(peek.tab);
      localStorage.removeItem('markus_nav_installItem');
      localStorage.removeItem('markus_nav_storeTab');
    }
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ page: string; params?: Record<string, string> }>).detail;
      const tab = detail.params?.storeTab ?? localStorage.getItem('markus_nav_storeTab');
      if (isTabId(tab)) setActiveTab(tab);
      const installId = detail.params?.installItem ?? localStorage.getItem('markus_nav_installItem');
      if (installId) setHighlightItemId(installId);
      localStorage.removeItem('markus_nav_storeTab');
      localStorage.removeItem('markus_nav_installItem');
    };
    window.addEventListener('markus:navigate', handler);
    return () => window.removeEventListener('markus:navigate', handler);
  }, []);
  const openType = (type: AssetType, itemId?: string) => {
    if (itemId) setHighlightItemId(itemId);
    setActiveTab(TYPE_TO_TAB[type] ?? 'agents');
  };

  return (
    <div className="flex-1 overflow-hidden flex flex-col" onTouchStart={swipe.onTouchStart} onTouchEnd={swipe.onTouchEnd}>
      <div className="flex items-center shrink-0 overflow-x-auto scrollbar-hide">
        <MobileMenuButton className="ml-2" />
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 min-w-fit px-3 py-2.5 text-xs font-medium text-center whitespace-nowrap transition-colors border-b-2 ${
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
        {activeTab === 'builder' && <AgentBuilder authUser={authUser} />}
        {activeTab === 'discover' && <StoreDiscovery onOpenType={openType} />}
        {activeTab === 'agents' && <TemplateMarketplace authUser={authUser} highlightItemId={highlightItemId} onHighlightDone={() => setHighlightItemId(null)} />}
        {activeTab === 'teams' && <TeamsStore highlightItemId={highlightItemId} onHighlightDone={() => setHighlightItemId(null)} />}
        {activeTab === 'skills' && <SkillStore highlightItemId={highlightItemId} onHighlightDone={() => setHighlightItemId(null)} />}
        {activeTab === 'installed' && <InstalledStore />}
      </div>
    </div>
  );
}
