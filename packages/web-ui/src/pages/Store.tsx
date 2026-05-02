import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { TemplateMarketplace } from './TemplateMarketplace.tsx';
import { TeamsStore } from './TeamsStore.tsx';
import { SkillStore } from './SkillStore.tsx';
import { InstalledStore } from './InstalledStore.tsx';
import { useSwipeTabs } from '../hooks/useSwipeTabs.ts';
import { useIsMobile } from '../hooks/useIsMobile.ts';
import type { AuthUser } from '../api.ts';

const tabs = [{ id: 'agents' }, { id: 'teams' }, { id: 'skills' }, { id: 'installed' }] as const;

type TabId = (typeof tabs)[number]['id'];

const TYPE_TO_TAB: Record<string, TabId> = { agent: 'agents', team: 'teams', skill: 'skills' };

function isValidTab(v: string | null): v is TabId {
  return v === 'agents' || v === 'teams' || v === 'skills' || v === 'installed';
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

  const tab: TabId = isValidTab(lsTab) ? lsTab : 'agents';
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

  const renderContent = () => (
    <>
      {activeTab === 'agents' && <TemplateMarketplace authUser={authUser} highlightItemId={highlightItemId} onHighlightDone={() => setHighlightItemId(null)} />}
      {activeTab === 'teams' && <TeamsStore highlightItemId={highlightItemId} onHighlightDone={() => setHighlightItemId(null)} />}
      {activeTab === 'skills' && <SkillStore highlightItemId={highlightItemId} onHighlightDone={() => setHighlightItemId(null)} />}
      {activeTab === 'installed' && <InstalledStore />}
    </>
  );

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
      <nav className="w-48 shrink-0 border-r border-border-default bg-surface-secondary/50 flex flex-col py-4 px-2 gap-1">
        <div className="px-3 pb-3 mb-1 border-b border-border-default/50">
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
