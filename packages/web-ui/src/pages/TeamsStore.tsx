import { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { api, hubApi, ownsHubItem, type TeamTemplateInfo, type HubItem } from '../api.ts';
import { consume, PREFETCH_KEYS } from '../prefetchCache.ts';
import { installHubItem, purchaseAndInstall, hubItemSlug } from './TemplateMarketplace.tsx';
import { ArtifactDetail } from './ArtifactDetail.tsx';
import { AssetCard } from '../components/AssetCard.tsx';
import { Masonry } from '../components/Masonry.tsx';

const TEAM_CATEGORY_ICONS: Record<string, string> = {
  development: '{ }',
  review: '⊘',
  operations: '⚙',
  general: '◎',
};

const TEAM_CATEGORY_COLORS: Record<string, string> = {
  development: 'bg-blue-500/15 text-blue-600 border-blue-500/20',
  review: 'bg-brand-500/15 text-brand-500 border-brand-500/20',
  operations: 'bg-amber-500/15 text-amber-600 border-amber-500/20',
  general: 'bg-gray-500/15 text-fg-secondary border-gray-500/20',
};

interface LocalArtifactInfo {
  installed: boolean;
  localVersion?: string;
  localUpdatedAt?: string;
}

function localizedTeamName(tpl: TeamTemplateInfo, lang: string): string {
  const loc = tpl.i18n?.[lang];
  return loc?.displayName || loc?.name || tpl.name;
}

function localizedTeamDesc(tpl: TeamTemplateInfo, lang: string): string {
  return tpl.i18n?.[lang]?.description || tpl.description;
}

function localizedMemberName(tpl: TeamTemplateInfo, memberName: string, lang: string): string {
  return tpl.i18n?.[lang]?.members?.[memberName] || memberName;
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

export function TeamsStore({ highlightItemId, onHighlightDone }: { highlightItemId?: string | null; onHighlightDone?: () => void } = {}) {
  const { t, i18n } = useTranslation(['store', 'common']);
  const lang = i18n.language;
  const [search, setSearch] = useState('');
  const [templates, setTemplates] = useState<TeamTemplateInfo[]>([]);
  const [hubItems, setHubItems] = useState<HubItem[]>([]);
  const [selected, setSelected] = useState<TeamTemplateInfo | null>(null);
  const [memberFiles, setMemberFiles] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [localArtifacts, setLocalArtifacts] = useState<Map<string, LocalArtifactInfo>>(new Map());
  const [purchasedIds, setPurchasedIds] = useState<Set<string>>(new Set());
  const [detailItem, setDetailItem] = useState<{ type: string; name: string } | null>(null);

  const loadLocalStatus = useCallback(async () => {
    try {
      const [artRes, instRes] = await Promise.all([
        api.builder.artifacts.list().catch(() => ({ artifacts: [] as Array<{ type: string; name: string; meta: Record<string, unknown>; updatedAt: string }> })),
        api.builder.artifacts.installed().catch(() => ({ installed: {} as Record<string, unknown> })),
      ]);
      const map = new Map<string, LocalArtifactInfo>();
      for (const art of artRes.artifacts) {
        if (art.type !== 'team') continue;
        const isInstalled = !!instRes.installed[`team/${art.name}`];
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
      const hubPromise = !search
        ? (consume<{ items: HubItem[]; total: number }>(PREFETCH_KEYS.hubTeams) ?? hubApi.search({ type: 'team', limit: 50 }))
        : hubApi.search({ type: 'team', q: search, limit: 50 });
      const [hubRes, tplRes] = await Promise.all([
        hubPromise.catch(() => ({ items: [] as HubItem[], total: 0 })),
        api.teamTemplates.list(search || undefined).catch(() => ({ templates: [] as TeamTemplateInfo[] })),
        loadLocalStatus(),
        hubApi.isAuthenticated()
          ? hubApi.purchases.mine().then(r => setPurchasedIds(new Set(r.purchases.map(p => p.itemId)))).catch(() => {})
          : Promise.resolve(),
      ]);
      setHubItems(hubRes?.items ?? []);
      setTemplates(tplRes?.templates ?? []);
    } catch {
      setTemplates([]);
      setHubItems([]);
    } finally {
      setLoading(false);
    }
  }, [search, loadLocalStatus]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!selected) { setMemberFiles({}); return; }
    fetch(`/api/team-templates/${encodeURIComponent(selected.id)}/files`, { credentials: 'include' })
      .then(r => r.json())
      .then((data: { files?: Record<string, string> }) => setMemberFiles(data.files ?? {}))
      .catch(() => setMemberFiles({}));
  }, [selected]);

  const handleDeploy = async (tpl: TeamTemplateInfo) => {
    setDeploying(true);
    setDeployResult(null);
    try {
      const teamRes = await api.teams.create(tpl.name, tpl.description);
      const teamId = teamRes.team.id;
      let managerId: string | undefined;
      let deployed = 0;
      const errors: string[] = [];

      for (const member of tpl.members) {
        const count = member.count ?? 1;
        for (let i = 0; i < count; i++) {
          const name = member.name ?? `${tpl.name} Agent ${i + 1}`;
          const displayName = count > 1 ? `${name} ${i + 1}` : name;
          const roleName = member.roleName ?? member.templateId;
          try {
            const res = await fetch('/api/agents', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({
                name: displayName,
                ...(roleName ? { roleName } : {}),
                orgId: 'default',
                teamId,
                agentRole: member.role ?? 'worker',
                skills: member.skills ?? [],
              }),
            });
            if (res.ok) {
              deployed++;
              const data = await res.json();
              if (member.role === 'manager' && !managerId) managerId = data.agent?.id;
            } else {
              const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
              errors.push(`${displayName}: ${data.error ?? res.statusText}`);
            }
          } catch (err) {
            errors.push(`${displayName}: ${String(err)}`);
          }
        }
      }

      if (managerId) {
        await api.teams.update(teamId, { managerId, managerType: 'agent' }).catch(() => {});
      }

      const errMsg = errors.length > 0 ? ` (${errors.length} failed: ${errors[0]})` : '';
      setDeployResult({ ok: deployed > 0, message: `Team "${localizedTeamName(tpl, lang)}" deployed with ${deployed} agent(s)${errMsg}` });
    } catch (err) {
      setDeployResult({ ok: false, message: `Failed: ${err}` });
    } finally {
      setDeploying(false);
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

  if (selected) {
    const allFiles: Record<string, string> = { ...memberFiles };
    if (selected.announcements) allFiles['ANNOUNCEMENT.md'] = selected.announcements;
    if (selected.norms) allFiles['NORMS.md'] = selected.norms;

    const manifestData = {
      type: 'team',
      name: selected.id,
      displayName: localizedTeamName(selected, lang),
      version: selected.version,
      description: localizedTeamDesc(selected, lang),
      author: selected.author,
      category: selected.category ?? 'general',
      tags: selected.tags ?? [],
      files: allFiles,
      team: {
        members: selected.members.map(m => ({
          name: localizedMemberName(selected, m.name ?? m.roleName ?? m.templateId ?? 'Agent', lang),
          role: m.role ?? 'worker',
          roleName: m.roleName ?? m.templateId,
          count: m.count ?? 1,
          skills: m.skills ?? [],
        })),
      },
    };

    const teamContentSlot = (
      <div className="rounded-xl border border-border-default bg-surface-secondary/40 overflow-hidden">
        <div className="px-5 py-3 border-b border-border-default bg-surface-elevated/30">
          <h3 className="text-xs text-fg-tertiary uppercase tracking-wider">{t('teamStore.teamComposition')}</h3>
        </div>
        <div className="p-5 space-y-2">
          {selected.members.map((m, i) => {
            const displayName = localizedMemberName(selected, m.name ?? m.roleName ?? m.templateId ?? 'Agent', lang);
            return (
            <div key={i} className="flex items-center gap-3 bg-surface-elevated/50 rounded-lg p-3">
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center text-sm font-bold shrink-0 ${
                m.role === 'manager' ? 'bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/30' : 'bg-blue-500/15 text-blue-400 ring-1 ring-blue-500/30'
              }`}>
                {(displayName[0] ?? '?').toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-fg-primary font-medium">{displayName}</span>
                  <span className={`px-1.5 py-0.5 rounded text-[10px] capitalize font-medium ${
                    m.role === 'manager' ? 'bg-amber-500/15 text-amber-400' : 'bg-blue-500/15 text-blue-400'
                  }`}>{m.role ?? 'worker'}</span>
                  {(m.count ?? 1) > 1 && <span className="text-[10px] text-fg-muted">&times;{m.count}</span>}
                </div>
                {(m.roleName || m.templateId) && <div className="text-[10px] text-fg-tertiary font-mono mt-0.5">{m.roleName ?? m.templateId}</div>}
              </div>
              {m.skills && m.skills.length > 0 && (
                <div className="flex flex-wrap gap-1 shrink-0">
                  {m.skills.slice(0, 3).map(s => <span key={s} className="px-1.5 py-0.5 text-[9px] bg-surface-elevated text-fg-muted rounded border border-border-default">{s}</span>)}
                  {m.skills.length > 3 && <span className="text-[9px] text-fg-muted">+{m.skills.length - 3}</span>}
                </div>
              )}
            </div>
            );
          })}
        </div>
      </div>
    );

    return (
      <>
        <ArtifactDetail
          type="team"
          name={selected.id}
          onBack={() => { setSelected(null); setDeployResult(null); }}
          readOnly
          initialManifest={manifestData}
          contentSlot={teamContentSlot}
          actionSlot={
            <>
              {deployResult && (
                <span className={`text-xs ${deployResult.ok ? 'text-green-500' : 'text-red-500'}`}>{deployResult.message}</span>
              )}
              <button
                onClick={() => void handleDeploy(selected)}
                disabled={deploying}
                className="px-4 py-1.5 text-xs bg-brand-600 hover:bg-brand-500 text-white rounded-lg transition-colors font-medium disabled:opacity-50"
              >
                {deploying ? t('teamStore.deploying') : t('teamStore.deployTeam')}
              </button>
            </>
          }
        />
      </>
    );
  }

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      <div className="px-6 h-14 flex items-center justify-between shrink-0 gap-3">
        <h2 className="text-lg font-semibold">{t('teamStore.title')}</h2>
        <input
          type="text"
          placeholder={t('teamStore.searchPlaceholder')}
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="px-3 py-1.5 bg-surface-elevated border border-border-default rounded-lg text-sm max-w-xs w-full focus:border-brand-500 focus:outline-none"
        />
      </div>

      <div className="flex-1 overflow-y-auto p-7 space-y-8">
        {loading ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-56 rounded-2xl skeleton" />)}
          </div>
        ) : templates.length === 0 && hubItems.length === 0 ? (
          <div className="text-center py-20">
            <div className="text-4xl mb-4 opacity-30">&#9673;</div>
            <div className="text-fg-secondary font-medium mb-1">
              {search ? t('teamStore.noResults', { search }) : t('teamStore.noTeams')}
            </div>
            <div className="text-fg-tertiary text-sm">
              {search ? t('teamStore.noResultsHint') : t('teamStore.noTeamsHint')}
            </div>
          </div>
        ) : (
          <>
            {templates.length > 0 && (
              <section>
                <div className="flex items-baseline gap-2 mb-3">
                  <h3 className="section-title">{t('teamStore.builtin')}</h3>
                  <span className="text-xs text-fg-tertiary">{t('teamStore.available', { count: templates.length })}</span>
                </div>
                <Masonry columns={2}>
                  {templates.map(tpl => (
                    <AssetCard
                      key={tpl.id}
                      type="team"
                      name={localizedTeamName(tpl, lang)}
                      description={localizedTeamDesc(tpl, lang)}
                      seed={tpl.id}
                      icon={tpl.icon || 'users'}
                      version={tpl.version}
                      category={tpl.category}
                      tags={tpl.tags}
                      authorLabel={tpl.author}
                      hideStats
                      showTypeBadge={false}
                      cornerLabel={t('teamStore.builtin')}
                      onClick={() => setSelected(tpl)}
                    />
                  ))}
                </Masonry>
              </section>
            )}

            {hubItems.length > 0 && (
              <section>
                <h3 className="section-title mb-3">{t('teamStore.markusHub')}</h3>
                <Masonry columns={2}>
                  {hubItems.map(item => (
                    <HubTeamCard key={item.id} item={item} localInfo={localArtifacts.get(hubItemSlug(item))} purchased={ownsHubItem(item, purchasedIds)} onStatusChange={loadLocalStatus} highlight={item.id === highlightItemId} onHighlightDone={onHighlightDone} onViewDetail={(name) => setDetailItem({ type: 'team', name })} />
                  ))}
                </Masonry>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function HubTeamCard({ item, localInfo, purchased, onStatusChange, highlight, onHighlightDone, onViewDetail }: { item: HubItem; localInfo?: LocalArtifactInfo; purchased?: boolean; onStatusChange: () => void; highlight?: boolean; onHighlightDone?: () => void; onViewDetail?: (name: string) => void }) {
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
  const priceLabel = isPaid ? `$${((item.priceCents ?? 0) / 100).toFixed(2)}` : null;

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

  const handleBuy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (installing) return;
    setInstalling(true);
    setStatus('');
    try {
      const result = await purchaseAndInstall(item, (s) => {
        if (s === 'checkout_opened') setStatus(t('card.waitingPurchase', 'Waiting for purchase...'));
        else if (s === 'installing') setStatus(t('card.installing'));
      });
      if (result === 'installed') {
        setStatus(t('card.installed') + '!');
        onStatusChange();
      } else {
        setStatus('');
      }
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : t('card.failed'));
    } finally {
      setInstalling(false);
    }
  };

  const hubDetailUrl = item.slug && item.author?.username
    ? `${hubApi.getUrl()}/@${encodeURIComponent(item.author.username)}/${encodeURIComponent(item.slug)}`
    : null;

  const handleCardClick = () => {
    if (isInstalled && onViewDetail) {
      onViewDetail(hubItemSlug(item));
    } else if (hubDetailUrl) {
      window.open(hubDetailUrl, '_blank', 'noopener,noreferrer');
    }
  };

  const actions = (
    <>
      {canUpgrade ? (
        <button onClick={e => void handleInstall(e)} disabled={installing}
          className="px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-500 text-white rounded-lg transition-colors disabled:opacity-50">
          {installing ? t('card.upgrading') : t('card.upgrade', { version: item.version })}
        </button>
      ) : isInstalled ? (
        <button onClick={e => void handleInstall(e)} disabled={installing}
          className="px-3 py-1.5 text-xs bg-surface-elevated hover:bg-surface-overlay text-fg-secondary border border-border-default rounded-lg transition-colors disabled:opacity-50">
          {t('card.installed')}{localInfo?.localVersion ? ` v${localInfo.localVersion}` : ''}
        </button>
      ) : isPaid && !purchased ? (
        <button onClick={e => void handleBuy(e)} disabled={installing}
          className="px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-500 text-white rounded-lg transition-colors disabled:opacity-50 inline-flex items-center gap-1">
          {installing ? (status || t('card.installing')) : <>{t('card.buy', 'Buy')} {priceLabel}</>}
        </button>
      ) : (
        <button onClick={e => void handleInstall(e)} disabled={installing}
          className="px-3 py-1.5 text-xs bg-brand-600 hover:bg-brand-500 text-white rounded-lg transition-colors disabled:opacity-50">
          {installing ? t('card.installing') : t('card.install')}
        </button>
      )}
      {status && <span className={`text-[10px] ${status === t('card.failed') || status === t('card.purchaseRequired') ? 'text-red-500' : 'text-green-600'}`}>{status}</span>}
    </>
  );

  return (
    <div ref={cardRef} className={glowing ? 'animate-pulse' : ''}>
      <AssetCard
        type="team"
        showTypeBadge={false}
        name={item.name}
        description={item.description}
        seed={item.slug || item.name}
        icon={item.icon || 'users'}
        cover={item.thumbnailUrl}
        hubBase={hubApi.getUrl()}
        author={item.author}
        version={item.version}
        category={item.category}
        tags={item.tags}
        rating={parseFloat(item.avgRating) || 0}
        ratingCount={item.ratingCount}
        downloadCount={item.downloadCount}
        priceCents={item.priceCents}
        currency={item.currency}
        installed={isInstalled}
        glowing={glowing}
        onClick={handleCardClick}
        actions={actions}
      />
    </div>
  );
}

