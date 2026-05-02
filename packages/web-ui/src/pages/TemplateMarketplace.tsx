import { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { api, hubApi, type AuthUser, type HubItem } from '../api.ts';
import { consume, PREFETCH_KEYS } from '../prefetchCache.ts';
import { ArtifactDetail } from './ArtifactDetail.tsx';

type FilterId = 'all' | 'hub';

interface LocalArtifactInfo {
  installed: boolean;
  localVersion?: string;
  localUpdatedAt?: string;
}

function toSlug(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, '-').replace(/[\/\\:*?"<>|]+/g, '').replace(/-{2,}/g, '-').replace(/^-|-$/g, '') || 'unnamed';
}

function isNewerVersion(latest: string, current: string): boolean {
  const a = latest.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return false;
}

interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  source: 'official' | 'community' | 'custom';
  version: string;
  author: string;
  roleId: string;
  agentRole: 'manager' | 'worker';
  skills: string[];
  tags: string[];
  category: string;
  icon?: string;
  starterTasks?: Array<{ title: string; description: string; priority: string }>;
  i18n?: Record<string, { displayName?: string; name?: string; description?: string }>;
}

function localizedName(tpl: TemplateInfo, lang: string): string {
  const loc = tpl.i18n?.[lang];
  return loc?.displayName || loc?.name || tpl.name;
}

function localizedDesc(tpl: TemplateInfo, lang: string): string {
  return tpl.i18n?.[lang]?.description || tpl.description;
}

const CATEGORY_ICONS: Record<string, string> = {
  development: '{ }',
  devops: '⚙',
  management: '◎',
  productivity: '⚡',
  general: '◆',
};

const CATEGORY_COLORS: Record<string, string> = {
  development: 'bg-blue-500/15 text-blue-600 border-blue-500/20',
  devops: 'bg-amber-500/15 text-amber-600 border-amber-500/20',
  management: 'bg-brand-500/15 text-brand-500 border-brand-500/20',
  productivity: 'bg-green-500/15 text-green-600 border-green-500/20',
  general: 'bg-gray-500/15 text-fg-secondary border-gray-500/20',
};

const ROLE_COLORS: Record<string, string> = {
  manager: 'bg-brand-500/15 text-brand-500',
  worker: 'bg-blue-500/15 text-blue-600',
};

export function TemplateMarketplace({ authUser: _authUser, highlightItemId, onHighlightDone }: { authUser?: AuthUser; highlightItemId?: string | null; onHighlightDone?: () => void } = {}) {
  const { t, i18n } = useTranslation(['store', 'common']);
  const lang = i18n.language;
  const [filter, setFilter] = useState<FilterId>(highlightItemId ? 'hub' : 'all');
  const [search, setSearch] = useState('');
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [hubItems, setHubItems] = useState<HubItem[]>([]);
  const [selected, setSelected] = useState<TemplateInfo | null>(null);
  const [roleFiles, setRoleFiles] = useState<Record<string, string>>({});
  const [showHireModal, setShowHireModal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [localArtifacts, setLocalArtifacts] = useState<Map<string, LocalArtifactInfo>>(new Map());
  const [detailItem, setDetailItem] = useState<{ type: string; name: string } | null>(null);

  useEffect(() => {
    if (highlightItemId) setFilter('hub');
  }, [highlightItemId]);

  const loadLocalStatus = useCallback(async () => {
    try {
      const [artRes, instRes] = await Promise.all([
        api.builder.artifacts.list().catch(() => ({ artifacts: [] as Array<{ type: string; name: string; meta: Record<string, unknown>; updatedAt: string }> })),
        api.builder.artifacts.installed().catch(() => ({ installed: {} as Record<string, unknown> })),
      ]);
      const map = new Map<string, LocalArtifactInfo>();
      for (const art of artRes.artifacts) {
        if (art.type !== 'agent') continue;
        const isInstalled = !!instRes.installed[`agent/${art.name}`];
        map.set(art.name, {
          installed: isInstalled,
          localVersion: (art.meta.version as string) || undefined,
          localUpdatedAt: art.updatedAt,
        });
      }
      setLocalArtifacts(map);
    } catch { /* ignore */ }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (filter === 'hub') {
        const hubPromise = !search
          ? (consume<{ items: HubItem[]; total: number }>(PREFETCH_KEYS.hubAgents) ?? hubApi.search({ type: 'agent', limit: 50 }))
          : hubApi.search({ type: 'agent', q: search, limit: 50 });
        const [res] = await Promise.all([
          hubPromise.catch(() => ({ items: [] as HubItem[], total: 0 })),
          loadLocalStatus(),
        ]);
        setHubItems(res?.items ?? []);
        setTemplates([]);
      } else {
        setHubItems([]);
        const params = new URLSearchParams();
        if (search) params.set('q', search);
        const res = await fetch('/api/templates?' + params.toString()).then(r => r.json()).catch(() => ({ templates: [] }));
        setTemplates(Array.isArray(res.templates) ? res.templates : []);
      }
    } catch {
      setTemplates([]);
      setHubItems([]);
    } finally {
      setLoading(false);
    }
  }, [filter, search, loadLocalStatus]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!selected || filter !== 'all') { setRoleFiles({}); return; }
    fetch(`/api/templates/${encodeURIComponent(selected.id)}/files`, { credentials: 'include' })
      .then(r => r.json())
      .then((data: { files?: Record<string, string> }) => setRoleFiles(data.files ?? {}))
      .catch(() => setRoleFiles({}));
  }, [selected, filter]);

  const handleInstantiate = async (templateId: string, name: string, teamId?: string) => {
    try {
      const res = await fetch('/api/templates/instantiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ templateId, name, orgId: 'default', teamId }),
      });
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      setShowHireModal(false);
      setSelected(null);
    } catch (err) {
      alert(`Failed to create agent: ${err}`);
    }
  };

  if (detailItem) {
    return (
      <ArtifactDetail
        type={detailItem.type}
        name={detailItem.name}
        onBack={() => setDetailItem(null)}
      />
    );
  }

  if (selected && filter === 'all') {
    const manifestData = {
      type: 'agent',
      name: selected.id,
      displayName: localizedName(selected, lang),
      version: selected.version,
      description: localizedDesc(selected, lang),
      author: selected.author,
      category: selected.category,
      tags: selected.tags,
      icon: selected.icon,
      files: roleFiles,
      agent: { roleName: selected.roleId, agentRole: selected.agentRole === 'manager' ? 'manager' : 'worker' },
      dependencies: { skills: selected.skills },
    };

    const agentContentSlot = (
      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="rounded-xl border border-border-default bg-surface-secondary/40 p-5">
            <h3 className="text-xs text-fg-tertiary uppercase tracking-wider mb-3">{t('agentStore.roleConfig')}</h3>
            <div className="space-y-2.5 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-fg-tertiary w-20">{t('agentStore.role')}</span>
                <span className="text-fg-secondary font-mono text-xs bg-surface-elevated px-2 py-0.5 rounded">{selected.roleId}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-fg-tertiary w-20">{t('agentStore.position')}</span>
                <span className={`px-2 py-0.5 rounded text-xs capitalize ${ROLE_COLORS[selected.agentRole] ?? ''}`}>{selected.agentRole}</span>
              </div>
            </div>
          </div>
          <div className="rounded-xl border border-border-default bg-surface-secondary/40 p-5">
            <h3 className="text-xs text-fg-tertiary uppercase tracking-wider mb-3">{t('agentStore.skills')}</h3>
            <div className="flex flex-wrap gap-1.5">
              {selected.skills.map(s => (
                <span key={s} className="px-2.5 py-1 text-xs bg-brand-500/10 text-brand-500 rounded-lg border border-brand-500/20">{s}</span>
              ))}
              {selected.skills.length === 0 && <span className="text-xs text-fg-tertiary italic">{t('agentStore.noSkills')}</span>}
            </div>
          </div>
        </div>
        {selected.starterTasks && selected.starterTasks.length > 0 && (
          <div className="rounded-xl border border-border-default bg-surface-secondary/40 p-5">
            <h3 className="text-xs text-fg-tertiary uppercase tracking-wider mb-3">{t('agentStore.starterTasks')}</h3>
            <div className="space-y-2">
              {selected.starterTasks.map((task, i) => (
                <div key={i} className="flex items-start gap-3 bg-surface-elevated/50 rounded-lg p-3">
                  <span className={`inline-block w-2 h-2 rounded-full shrink-0 mt-1 ${
                    task.priority === 'high' ? 'bg-red-400' : task.priority === 'medium' ? 'bg-amber-400' : 'bg-green-400'
                  }`} />
                  <div>
                    <div className="text-sm text-fg-primary">{task.title}</div>
                    {task.description && <div className="text-xs text-fg-tertiary mt-0.5">{task.description}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );

    return (
      <>
        <ArtifactDetail
          type="agent"
          name={selected.id}
          onBack={() => setSelected(null)}
          readOnly
          initialManifest={manifestData}
          actionSlot={
            <button
              onClick={() => setShowHireModal(true)}
              className="px-4 py-1.5 text-xs bg-brand-600 hover:bg-brand-500 text-white rounded-lg transition-colors font-medium"
            >
              {t('agentStore.hireAgent')}
            </button>
          }
          contentSlot={agentContentSlot}
        />
        {showHireModal && (
          <HireFromTemplateModal
            template={selected}
            lang={lang}
            onClose={() => setShowHireModal(false)}
            onHire={handleInstantiate}
          />
        )}
      </>
    );
  }

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      <div className="px-6 h-14 flex items-center border-b border-border-default bg-surface-secondary shrink-0">
        <h2 className="text-lg font-semibold">{t('agentStore.title')}</h2>
      </div>

      <div className="flex flex-wrap items-center gap-2 px-6 py-2 border-b border-border-default/50 bg-surface-secondary/50 shrink-0">
        <div className="flex gap-1">
          {([
            { id: 'all' as const, labelKey: 'agentStore.builtin' },
            { id: 'hub' as const, labelKey: 'agentStore.markusHub' },
          ]).map(f => (
            <button
              key={f.id}
              onClick={() => { setFilter(f.id); setSelected(null); }}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                filter === f.id ? 'bg-brand-600 text-white' : 'text-fg-secondary hover:text-fg-primary hover:bg-surface-elevated'
              }`}
            >
              {t(f.labelKey)}
            </button>
          ))}
        </div>
        {filter === 'all' && (
          <div className="text-xs text-fg-tertiary">
            {t('agentStore.available', { count: templates.length })}
          </div>
        )}
        <div className="flex-1 min-w-[120px]">
          <input
            type="text"
            placeholder={t('agentStore.searchPlaceholder')}
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="px-3 py-1.5 bg-surface-elevated border border-border-default rounded-lg text-sm w-full focus:border-brand-500 focus:outline-none"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-7">
        {loading ? (
          <div className="text-center text-fg-tertiary py-20 animate-pulse">{t('agentStore.loading')}</div>
        ) : filter === 'hub' ? (
          hubItems.length === 0 ? (
            <div className="text-center py-16">
              <div className="text-fg-tertiary text-3xl mb-3">🏪</div>
              <p className="text-sm text-fg-tertiary">{t('agentStore.noHub')}</p>
              <p className="text-xs text-fg-tertiary mt-1">{t('agentStore.noHubHint')}</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {hubItems.map(item => (
                <HubAgentCard key={item.id} item={item} localInfo={localArtifacts.get(toSlug(item.name))} onStatusChange={loadLocalStatus} highlight={item.id === highlightItemId} onHighlightDone={onHighlightDone} onViewDetail={(name) => setDetailItem({ type: 'agent', name })} />
              ))}
            </div>
          )
        ) : templates.length === 0 ? (
          <div className="text-center py-20">
            <div className="text-4xl mb-4 opacity-30">&#x29C9;</div>
            <div className="text-fg-secondary font-medium mb-1">
              {search ? t('agentStore.noResults', { search }) : t('agentStore.noAgents')}
            </div>
            <div className="text-fg-tertiary text-sm">
              {search ? t('agentStore.noResultsHint') : t('agentStore.noAgentsHint')}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {templates.map(tpl => (
              <TemplateCard
                key={tpl.id}
                template={tpl}
                lang={lang}
                isSelected={false}
                onSelect={() => setSelected(tpl)}
              />
            ))}
          </div>
        )}
      </div>

      {showHireModal && selected && (
        <HireFromTemplateModal
          template={selected}
          lang={lang}
          onClose={() => setShowHireModal(false)}
          onHire={handleInstantiate}
        />
      )}
    </div>
  );
}

export function installHubItem(item: HubItem): Promise<string> {
  return (async () => {
    const data = await hubApi.download(item.id);
    const name = data.name || item.name;
    const slug = toSlug(name);
    const mode = (data.itemType === 'team' ? 'team' : data.itemType === 'skill' ? 'skill' : 'agent') as 'agent' | 'team' | 'skill';
    const hubSource = { type: 'hub', hubItemId: item.id };
    if (data.files && Object.keys(data.files).length > 0) {
      await api.builder.artifacts.import(mode, slug, data.files, hubSource);
    } else {
      const artifact = { ...(data.config as Record<string, unknown>), name, description: item.description, source: hubSource };
      await api.builder.artifacts.save(mode, artifact);
    }
    await api.builder.artifacts.install(mode, slug);
    window.dispatchEvent(new CustomEvent('markus:data-changed'));
    return name;
  })();
}

function HubAgentCard({ item, localInfo, onStatusChange, highlight, onHighlightDone, onViewDetail }: { item: HubItem; localInfo?: LocalArtifactInfo; onStatusChange: () => void; highlight?: boolean; onHighlightDone?: () => void; onViewDetail?: (name: string) => void }) {
  const { t } = useTranslation(['store']);
  const [installing, setInstalling] = useState(false);
  const [status, setStatus] = useState('');
  const cardRef = useRef<HTMLDivElement>(null);
  const [glowing, setGlowing] = useState(false);

  useEffect(() => {
    if (highlight && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setGlowing(true);
      const timer = setTimeout(() => { setGlowing(false); onHighlightDone?.(); }, 4000);
      return () => clearTimeout(timer);
    }
  }, [highlight, onHighlightDone]);

  const isInstalled = localInfo?.installed ?? false;
  const canUpgrade = isInstalled && item.version && localInfo?.localVersion && isNewerVersion(item.version, localInfo.localVersion);
  const isPaid = (item.priceCents ?? 0) > 0;

  const handleInstall = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (installing) return;
    setInstalling(true);
    setStatus('');
    try {
      await installHubItem(item);
      setStatus(canUpgrade ? t('card.upgraded') : t('card.installed') + '!');
      onStatusChange();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('402') || msg.includes('Purchase required')) {
        setStatus(t('card.purchaseRequired'));
      } else {
        setStatus(t('card.failed'));
      }
    } finally {
      setInstalling(false);
    }
  };

  const priceLabel = isPaid ? `$${((item.priceCents ?? 0) / 100).toFixed(2)}` : null;
  const iconIsEmoji = item.icon && !item.icon.startsWith('/') && !item.icon.startsWith('http');
  const iconSrc = item.icon && (item.icon.startsWith('http') ? item.icon : item.icon.startsWith('/') ? `${hubApi.getUrl()}${item.icon}` : null);
  const catColor = CATEGORY_COLORS[item.category] ?? CATEGORY_COLORS.general ?? 'bg-gray-500/15 text-fg-secondary border-gray-500/20';
  const catIcon = CATEGORY_ICONS[item.category] ?? CATEGORY_ICONS.general ?? '\u25C6';
  const rating = Math.round(parseFloat(item.avgRating));

  const hubDetailUrl = item.slug && item.author?.username
    ? `${hubApi.getUrl()}/${encodeURIComponent(item.author.username)}/${encodeURIComponent(item.slug)}`
    : null;

  const handleCardClick = () => {
    if (isInstalled && onViewDetail) {
      onViewDetail(toSlug(item.name));
    } else if (hubDetailUrl) {
      window.open(hubDetailUrl, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <div ref={cardRef} onClick={handleCardClick} className={`group relative bg-surface-secondary rounded-xl cursor-pointer transition-all duration-300 overflow-hidden hover:shadow-xl hover:shadow-brand-500/5 hover:-translate-y-0.5 ${glowing ? 'ring-2 ring-brand-500 shadow-lg shadow-brand-500/20 animate-pulse' : ''}`}>
      <div className={`absolute inset-0 rounded-xl border transition-colors duration-300 ${glowing ? 'border-brand-500/60' : 'border-border-default group-hover:border-brand-500/30'}`} />
      <div className={`absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-green-500/40 to-transparent transition-opacity duration-300 ${glowing ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`} />

      <div className="relative p-5">
        <div className="flex items-start gap-3 mb-3">
          <div className="w-10 h-10 rounded-lg bg-surface-elevated/80 border border-border-default/50 flex items-center justify-center shrink-0 text-lg">
            {iconSrc ? <img src={iconSrc} alt="" className="w-8 h-8 rounded object-cover" /> : iconIsEmoji ? item.icon : '\u{1F916}'}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold truncate group-hover:text-brand-400 transition-colors">{item.name}</h3>
              {isPaid && <span className="text-[10px] px-1.5 py-0.5 bg-amber-500/15 text-amber-400 rounded-md border border-amber-500/10 shrink-0">{priceLabel}</span>}
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[11px] text-fg-tertiary truncate">by {item.author?.displayName ?? item.author?.username}</span>
              {item.version && <span className="text-[10px] px-1.5 py-0.5 bg-brand-500/15 text-brand-400 rounded-md border border-brand-500/10 shrink-0">v{item.version}</span>}
            </div>
          </div>
        </div>

        <p className="text-sm text-fg-secondary line-clamp-2 leading-relaxed mb-3">{item.description}</p>

        <div className="flex flex-wrap gap-1.5 mb-3">
          {item.category && (
            <span className={`px-2 py-0.5 rounded-md text-[10px] font-medium border capitalize ${catColor}`}>
              {catIcon} {item.category}
            </span>
          )}
          {item.tags?.slice(0, 3).map(tag => (
            <span key={tag} className="px-2 py-0.5 text-[10px] bg-surface-elevated/80 text-fg-secondary rounded-md border border-border-default/50">{tag}</span>
          ))}
          {(item.tags?.length ?? 0) > 3 && <span className="px-1 text-[10px] text-fg-muted">+{item.tags.length - 3}</span>}
        </div>

        <div className="flex items-center gap-3 text-xs text-fg-tertiary mb-3">
          <span className="text-amber-500 tracking-tight">{'\u2605'.repeat(rating)}{'\u2606'.repeat(5 - rating)}</span>
          <span className="text-fg-muted">({item.ratingCount})</span>
          <span>{'\u2193'} {item.downloadCount}</span>
        </div>

        <div className="flex items-center justify-end gap-2 pt-3 border-t border-border-default/50" onClick={e => e.stopPropagation()}>
          {canUpgrade ? (
            <button onClick={e => void handleInstall(e)} disabled={installing}
              className="px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-500 text-white rounded-lg transition-colors disabled:opacity-50">
              {installing ? t('card.upgrading') : t('card.upgrade', { version: item.version })}
            </button>
          ) : isInstalled ? (
            <span className="px-3 py-1.5 text-xs bg-green-500/10 text-green-500 rounded-lg border border-green-500/20 inline-flex items-center gap-1">
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              {t('card.installed')}{localInfo?.localVersion ? ` v${localInfo.localVersion}` : ''}
            </span>
          ) : isPaid ? (
            <a href={`${hubApi.getUrl()}/${encodeURIComponent(item.author?.username ?? '')}/${encodeURIComponent(item.slug ?? item.id)}`}
              target="_blank" rel="noopener noreferrer"
              className="px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-500 text-white rounded-lg transition-colors inline-flex items-center gap-1">
              {t('card.buy', { price: priceLabel })}
            </a>
          ) : (
            <button onClick={e => void handleInstall(e)} disabled={installing}
              className="px-3 py-1.5 text-xs bg-brand-600 hover:bg-brand-500 text-white rounded-lg transition-colors disabled:opacity-50">
              {installing ? t('card.installing') : t('card.install')}
            </button>
          )}
          {status && <span className={`text-[10px] ${status === t('card.failed') || status === t('card.purchaseRequired') ? 'text-red-500' : 'text-green-600'}`}>{status}</span>}
        </div>
      </div>
    </div>
  );
}

function TemplateCard({ template: tpl, lang, isSelected, onSelect }: { template: TemplateInfo; lang: string; isSelected: boolean; onSelect: () => void }) {
  return (
    <div
      onClick={onSelect}
      className={`group relative bg-surface-secondary rounded-xl cursor-pointer transition-all duration-300 overflow-hidden ${
        isSelected
          ? 'ring-1 ring-brand-500/60 shadow-lg shadow-brand-500/10'
          : 'hover:shadow-xl hover:shadow-brand-500/5 hover:-translate-y-0.5'
      }`}
    >
      <div className={`absolute inset-0 rounded-xl border transition-colors duration-300 ${
        isSelected ? 'border-brand-500/50' : 'border-border-default group-hover:border-brand-500/30'
      }`} />
      <div className={`absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-brand-500/40 to-transparent transition-opacity duration-300 ${
        isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
      }`} />

      <div className="relative p-5">
        <div className="flex items-center gap-2">
          <div className="font-semibold text-fg-primary truncate group-hover:text-brand-400 transition-colors">{localizedName(tpl, lang)}</div>
          <span className="px-2 py-0.5 rounded-md text-[10px] font-medium shrink-0 bg-brand-500/15 text-brand-400 border border-brand-500/10">
            v{tpl.version}
          </span>
        </div>
        <div className="text-[11px] text-fg-tertiary mt-0.5">by {tpl.author}</div>

        <p className="text-sm text-fg-secondary mt-3 line-clamp-2 leading-relaxed">{localizedDesc(tpl, lang)}</p>

        <div className="flex flex-wrap gap-1.5 mt-3">
          {tpl.skills.slice(0, 4).map(s => (
            <span key={s} className="px-2 py-0.5 text-[10px] bg-surface-elevated/80 text-fg-secondary rounded-md border border-border-default/50">{s}</span>
          ))}
          {tpl.skills.length > 4 && (
            <span className="px-2 py-0.5 text-[10px] text-fg-muted">+{tpl.skills.length - 4}</span>
          )}
        </div>

        <div className="mt-3 pt-3 border-t border-border-default/50 flex items-center gap-2 text-xs">
          <span className={`inline-block px-2 py-0.5 rounded-md text-[10px] font-medium capitalize ${
            ROLE_COLORS[tpl.agentRole] ?? 'bg-surface-overlay text-fg-secondary'
          }`}>
            {tpl.agentRole}
          </span>
          {tpl.tags.length > 0 && (
            <span className="text-fg-muted text-[10px]">{tpl.tags.slice(0, 2).join(' · ')}</span>
          )}
        </div>
      </div>
    </div>
  );
}

function HireFromTemplateModal({
  template,
  lang,
  onClose,
  onHire,
}: {
  template: TemplateInfo;
  lang: string;
  onClose: () => void;
  onHire: (templateId: string, name: string, teamId?: string) => Promise<void>;
}) {
  const { t } = useTranslation(['store']);
  const [name, setName] = useState(`${localizedName(template, lang)} Agent`);
  const [teamId, setTeamId] = useState('');
  const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch('/api/teams', { credentials: 'include' })
      .then(r => r.json())
      .then(d => setTeams(d.teams ?? []))
      .catch(() => {});
  }, []);

  const handleSubmit = async () => {
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      await onHire(template.id, name.trim(), teamId || undefined);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-surface-secondary border border-border-default rounded-xl p-6 w-[440px] shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 mb-5">
          <div>
            <h3 className="text-base font-semibold">{t('hireModal.title')}</h3>
            <p className="text-xs text-fg-tertiary">{t('hireModal.creating', { name: localizedName(template, lang) })}</p>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-xs text-fg-tertiary mb-1.5">{t('hireModal.agentName')}</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="input-field"
              autoFocus
            />
          </div>

          {teams.length > 0 && (
            <div>
              <label className="block text-xs text-fg-tertiary mb-1.5">{t('hireModal.assignTeam')}</label>
              <select value={teamId} onChange={e => setTeamId(e.target.value)} className="input-field">
                <option value="">{t('hireModal.noTeam')}</option>
                {teams.map(tm => (
                  <option key={tm.id} value={tm.id}>{tm.name}</option>
                ))}
              </select>
            </div>
          )}

          <div className="bg-surface-elevated/50 rounded-lg p-3">
            <div className="text-xs text-fg-tertiary mb-2 font-medium">{t('hireModal.agentConfig')}</div>
            <div className="grid grid-cols-2 gap-y-1.5 gap-x-4 text-xs">
              <div className="text-fg-tertiary">{t('hireModal.role')}</div>
              <div className="text-fg-secondary font-mono">{template.roleId}</div>
              <div className="text-fg-tertiary">{t('hireModal.position')}</div>
              <div className="text-fg-secondary capitalize">{template.agentRole}</div>
              <div className="text-fg-tertiary">{t('hireModal.skills')}</div>
              <div className="text-fg-secondary">{template.skills.join(', ') || t('hireModal.none')}</div>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <button onClick={onClose} className="btn-secondary">{t('hireModal.cancel')}</button>
          <button
            onClick={handleSubmit}
            disabled={!name.trim() || submitting}
            className="btn-primary"
          >
            {submitting ? t('hireModal.creating_progress') : t('hireModal.create')}
          </button>
        </div>
      </div>
    </div>
  );
}
