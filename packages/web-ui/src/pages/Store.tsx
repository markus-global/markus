import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { TemplateMarketplace, installHubItem } from './TemplateMarketplace.tsx';
import { TeamsStore } from './TeamsStore.tsx';
import { SkillStore } from './SkillStore.tsx';
import { InstalledStore } from './InstalledStore.tsx';
import { StoreDiscovery } from './StoreDiscovery.tsx';
import { useSwipeTabs } from '../hooks/useSwipeTabs.ts';
import { useIsMobile } from '../hooks/useIsMobile.ts';
import { usePageActive } from '../hooks/usePageActive.ts';
import { useLayout } from '../contexts/LayoutContext.tsx';
import { isEditableTarget } from '../lib/keyboard-shortcuts.ts';
import { PAGE } from '../routes.ts';
import { hubApi, type AuthUser, type HubItem } from '../api.ts';
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

/** Peek deep-link target without consuming — StrictMode runs state inits twice. */
function peekInstallDeepLink(): { tab: TabId; installId: string | null } {
  const lsItem = localStorage.getItem('markus_nav_installItem');
  const lsTab = localStorage.getItem('markus_nav_storeTab');
  if (lsItem) {
    return { tab: isValidTab(lsTab) ? lsTab : 'agents', installId: lsItem };
  }

  const params = new URLSearchParams(window.location.search);
  const id = params.get('install');
  if (id) {
    const itemType = params.get('type');
    return { tab: (itemType && TYPE_TO_TAB[itemType]) || 'agents', installId: id };
  }

  return { tab: isValidTab(lsTab) ? lsTab! : 'discover', installId: null };
}

function consumeInstallDeepLink(): void {
  localStorage.removeItem('markus_nav_installItem');
  localStorage.removeItem('markus_nav_storeTab');
  const params = new URLSearchParams(window.location.search);
  if (params.has('install') || params.has('type')) {
    params.delete('install');
    params.delete('type');
    const qs = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash);
  }
}

/** Banner for Hub → desktop deep links: fetch by id so we don't depend on search page size. */
function DeepLinkBanner({
  itemId,
  onDismiss,
  onInstalled,
}: {
  itemId: string;
  onDismiss: () => void;
  onInstalled: () => void;
}) {
  const { t } = useTranslation(['store', 'common']);
  const [item, setItem] = useState<HubItem | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [installing, setInstalling] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setItem(null);
    setMsg('');
    hubApi.getItem(itemId)
      .then(({ item: fetched }) => {
        if (cancelled) return;
        if (fetched) {
          setItem(fetched);
          setStatus('ready');
        } else {
          setStatus('missing');
        }
      })
      .catch(() => {
        if (!cancelled) setStatus('missing');
      });
    return () => { cancelled = true; };
  }, [itemId]);

  const handleInstall = async () => {
    if (!item || installing) return;
    setInstalling(true);
    setMsg('');
    try {
      await installHubItem(item);
      setMsg(t('deepLink.installed'));
      onInstalled();
    } catch (err: unknown) {
      const text = err instanceof Error ? err.message : '';
      setMsg(text.includes('402') || text.includes('Purchase') ? t('deepLink.purchaseRequired') : t('deepLink.failed'));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="shrink-0 mx-3 mt-3 mb-1 rounded-xl border border-brand-500/30 bg-brand-600/10 px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-brand-400/90 mb-0.5">
          {t('deepLink.fromHub')}
        </div>
        {status === 'loading' && (
          <p className="text-sm text-fg-secondary">{t('deepLink.loading')}</p>
        )}
        {status === 'missing' && (
          <p className="text-sm text-rose-300">{t('deepLink.missing')}</p>
        )}
        {status === 'ready' && item && (
          <>
            <p className="text-sm font-semibold text-fg-primary truncate">{item.name}</p>
            {item.description && (
              <p className="text-xs text-fg-tertiary line-clamp-2 mt-0.5">{item.description}</p>
            )}
            {msg && <p className="text-xs mt-1 text-brand-300">{msg}</p>}
          </>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {status === 'ready' && item && (
          <button
            type="button"
            disabled={installing}
            onClick={() => void handleInstall()}
            className="px-3.5 py-2 rounded-lg text-xs font-semibold bg-brand-600 hover:bg-brand-500 text-white disabled:opacity-60"
          >
            {installing ? t('deepLink.installing') : t('deepLink.install')}
          </button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          className="px-2.5 py-2 rounded-lg text-xs text-fg-tertiary hover:text-fg-secondary hover:bg-surface-elevated/60"
        >
          {t('deepLink.dismiss')}
        </button>
      </div>
    </div>
  );
}

export function StorePage({ authUser }: { authUser?: AuthUser }) {
  const { t } = useTranslation(['store', 'common']);
  const [initial] = useState(peekInstallDeepLink);
  const [activeTab, setActiveTab] = useState<TabId>(initial.tab);
  const isMobile = useIsMobile();
  const isActive = usePageActive(PAGE.STORE);
  const layout = useLayout();
  const keyboardPane = layout?.keyboardPane ?? 'content';
  const swipe = useSwipeTabs(tabs, activeTab, setActiveTab);
  const [highlightItemId, setHighlightItemId] = useState<string | null>(initial.installId);
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  // Store L1 = tab rail. H → L0; j/k switch tabs; L focuses L1.
  useEffect(() => {
    if (isMobile || !isActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (layout?.keyboardPane === 'l0') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditableTarget(e.target)) return;
      const bare = e.key.length === 1 ? e.key.toLowerCase() : e.key;

      if (bare === 'h' || bare === 'ArrowLeft') {
        e.preventDefault();
        layout?.setL0FocusPageId(PAGE.STORE);
        layout?.setLeftCollapsed(false);
        layout?.setKeyboardPane('l0');
        return;
      }
      // L1 is deepest — L only re-asserts L1 focus (never leaves the JK pane).
      if (bare === 'l' || bare === 'ArrowRight') {
        e.preventDefault();
        if (layout?.keyboardPane !== 'l1') layout?.setKeyboardPane('l1');
        return;
      }

      const move = bare === 'j' || bare === 'ArrowDown' ? 1
        : bare === 'k' || bare === 'ArrowUp' ? -1
        : 0;
      if (!move) return;
      e.preventDefault();
      layout?.setKeyboardPane('l1');
      const idx = tabs.findIndex(tab => tab.id === activeTabRef.current);
      const next = tabs[Math.max(0, Math.min(tabs.length - 1, idx + move))]!;
      setActiveTab(next.id);
      requestAnimationFrame(() => {
        document.querySelector(`[data-store-tab-id="${next.id}"]`)?.scrollIntoView({ block: 'nearest' });
      });
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [isMobile, isActive, layout]);

  // Consume after mount (once). Do not clear in useState init — StrictMode double-invokes it.
  useEffect(() => {
    const peek = peekInstallDeepLink();
    if (peek.installId) {
      setHighlightItemId(peek.installId);
      if (isValidTab(peek.tab)) setActiveTab(peek.tab);
      consumeInstallDeepLink();
    }
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ page: string; params?: Record<string, string> }>).detail;
      if (detail.page === 'store' || detail.page === 'explore') {
        const tab = detail.params?.storeTab ?? localStorage.getItem('markus_nav_storeTab');
        const installId = detail.params?.installItem ?? localStorage.getItem('markus_nav_installItem');
        if (tab && isValidTab(tab)) setActiveTab(tab);
        if (installId) setHighlightItemId(installId);
        if (tab || installId) consumeInstallDeepLink();
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

  const clearHighlight = () => setHighlightItemId(null);

  const renderContent = () => (
    <>
      {highlightItemId && (
        <DeepLinkBanner
          itemId={highlightItemId}
          onDismiss={clearHighlight}
          onInstalled={clearHighlight}
        />
      )}
      {activeTab === 'discover' && <StoreDiscovery onOpenType={openType} />}
      {activeTab === 'agents' && <TemplateMarketplace authUser={authUser} highlightItemId={highlightItemId} onHighlightDone={clearHighlight} />}
      {activeTab === 'teams' && <TeamsStore highlightItemId={highlightItemId} onHighlightDone={clearHighlight} />}
      {activeTab === 'skills' && <SkillStore highlightItemId={highlightItemId} onHighlightDone={clearHighlight} />}
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
      <nav data-keyboard-pane="l1" className={`w-36 shrink-0 bg-surface-secondary rounded-xl m-1 mr-0 flex flex-col py-4 px-2 gap-1 ${keyboardPane === 'l1' ? 'ring-1 ring-inset ring-brand-500/30' : ''}`}>
        <div className="px-3 pb-3 mb-1">
          <h2 className="text-xs font-semibold text-fg-tertiary uppercase tracking-wider">{t('title')}</h2>
        </div>
        {tabs.map(tab => (
          <button
            key={tab.id}
            data-store-tab-id={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
              activeTab === tab.id
                ? (keyboardPane === 'l1'
                  ? 'bg-brand-500/25 text-brand-400 ring-1 ring-inset ring-brand-500/40'
                  : 'bg-brand-600/15 text-brand-400 shadow-sm shadow-brand-500/10')
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
