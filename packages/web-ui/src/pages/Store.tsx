import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { TemplateMarketplace } from './TemplateMarketplace.tsx';
import { TeamsStore } from './TeamsStore.tsx';
import { SkillStore } from './SkillStore.tsx';
import { InstalledStore } from './InstalledStore.tsx';
import { StoreDiscovery } from './StoreDiscovery.tsx';
import { useSwipeTabs } from '../hooks/useSwipeTabs.ts';
import { useIsMobile } from '../hooks/useIsMobile.ts';
import type { AuthUser } from '../api.ts';
import type { AssetType } from '../lib/assetIdentity.ts';

const tabs = [{ id: 'discover' }, { id: 'agents' }, { id: 'teams' }, { id: 'skills' }, { id: 'installed' }] as const;

type TabId = (typeof tabs)[number]['id'];

// Connectors are a subtype of skill, so they live inside the Skills tab.
const TYPE_TO_TAB: Record<string, TabId> = { agent: 'agents', team: 'teams', skill: 'skills', connector: 'skills' };

const TAB_ICONS: Record<TabId, string> = {
  discover: 'M12 2l2.4 6.9L21 9l-5.4 4 2 7-5.6-4.1L6.4 20l2-7L3 9l6.6-.1z',
  agents: 'M12 2a5 5 0 015 5v1a5 5 0 01-10 0V7a5 5 0 015-5zM4 21a8 8 0 0116 0z',
  teams: 'M16 11a4 4 0 10-4-4 4 4 0 004 4zM8 13a3 3 0 10-3-3 3 3 0 003 3zm0 2c-2.7 0-5 1.3-5 3v2h7v-2c0-.7.2-1.3.6-1.9A7.6 7.6 0 008 15zm8 0c-3 0-6 1.5-6 3.5V21h12v-2.5c0-2-3-3.5-6-3.5z',
  skills: 'M13 2L3 14h7l-1 8 10-12h-7z',
  installed: 'M12 3v12m0 0l-4-4m4 4l4-4M5 21h14',
};

function isValidTab(v: string | null): v is TabId {
  return v === 'discover' || v === 'agents' || v === 'teams' || v === 'skills' || v === 'installed';
}

function readInitialState(): { tab: TabId; installId: string | null } {
  const lsItem = localStorage.getItem('markus_nav_installItem');
  const lsTab = localStorage.getItem('markus_nav_storeTab');
  if (lsItem) localStorage.removeItem('markus_nav_installItem');
  if (lsTab) localStorage.removeItem('markus_nav_storeTab');
  if (lsItem) {
    const tab: TabId = isValidTab(lsTab) ? lsTab : 'agents';
    return { tab, installId: lsItem };
  }

  const params = new URLSearchParams(window.location.search);
  const id = params.get('install');
  if (id) {
    const itemType = params.get('type');
    const tab: TabId = (itemType && TYPE_TO_TAB[itemType]) || 'agents';
    params.delete('install');
    params.delete('type');
    const qs = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash);
    return { tab, installId: id };
  }

  const tab: TabId = isValidTab(lsTab) ? lsTab : 'discover';
  return { tab, installId: null };
}

export function StorePage({ authUser }: { authUser?: AuthUser }) {
  const { t } = useTranslation(['store', 'common']);
  const [initial] = useState(readInitialState);
  const [activeTab, setActiveTab] = useState<TabId>(initial.tab);
  const isMobile = useIsMobile();
  const swipe = useSwipeTabs(tabs, activeTab, setActiveTab);
  const [highlightItemId, setHighlightItemId] = useState<string | null>(initial.installId);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ page: string; params?: Record<string, string> }>).detail;
      if (detail.page === 'store') {
        const tab = localStorage.getItem('markus_nav_storeTab');
        if (tab) {
          localStorage.removeItem('markus_nav_storeTab');
          if (isValidTab(tab)) setActiveTab(tab);
        }
        const installId = localStorage.getItem('markus_nav_installItem');
        if (installId) {
          localStorage.removeItem('markus_nav_installItem');
          setHighlightItemId(installId);
        }
      }
    };
    window.addEventListener('markus:navigate', handler);
    return () => window.removeEventListener('markus:navigate', handler);
  }, []);

  const openType = (type: AssetType, itemId?: string) => {
    const tab = TYPE_TO_TAB[type] ?? 'agents';
    if (itemId) setHighlightItemId(itemId);
    setActiveTab(tab);
  };

  const renderContent = () => (
    <>
      {activeTab === 'discover' && <StoreDiscovery onOpenType={openType} />}
      {activeTab === 'agents' && <TemplateMarketplace authUser={authUser} highlightItemId={highlightItemId} onHighlightDone={() => setHighlightItemId(null)} />}
      {activeTab === 'teams' && <TeamsStore highlightItemId={highlightItemId} onHighlightDone={() => setHighlightItemId(null)} />}
      {activeTab === 'skills' && <SkillStore highlightItemId={highlightItemId} onHighlightDone={() => setHighlightItemId(null)} />}
      {activeTab === 'installed' && <InstalledStore />}
    </>
  );

  if (isMobile) {
    return (
      <div className="flex-1 overflow-hidden flex flex-col" onTouchStart={swipe.onTouchStart} onTouchEnd={swipe.onTouchEnd}>
        <div className="flex shrink-0 overflow-x-auto scrollbar-hide">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 min-w-fit px-4 py-3 text-sm font-medium text-center whitespace-nowrap transition-colors border-b-2 ${
                activeTab === tab.id
                  ? 'border-brand-500 text-brand-500'
                  : 'border-transparent text-fg-tertiary hover:text-fg-secondary'
              }`}
            >
              {t(`tabs.${tab.id}`)}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-hidden flex flex-col">
          {renderContent()}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-hidden flex flex-row">
      <nav className="w-36 shrink-0 bg-surface-secondary rounded-xl m-1 mr-0 flex flex-col py-4 px-2 gap-1">
        <div className="px-3 pb-3 mb-1">
          <h2 className="text-xs font-semibold text-fg-tertiary uppercase tracking-wider">{t('title')}</h2>
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
            <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d={TAB_ICONS[tab.id]} />
            </svg>
            {t(`tabs.${tab.id}`)}
          </button>
        ))}
      </nav>
      <div className="flex-1 overflow-hidden flex flex-col">
        {renderContent()}
      </div>
    </div>
  );
}
