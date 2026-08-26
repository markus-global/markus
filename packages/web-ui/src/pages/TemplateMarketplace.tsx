import { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { api, hubApi, kebab, ownsHubItem, type AuthUser, type HubItem } from '../api.ts';
import { consume, PREFETCH_KEYS } from '../prefetchCache.ts';
import { mergeHighlightedHubItem } from '../lib/hubDeepLink.ts';
import { ArtifactDetail } from './ArtifactDetail.tsx';
import { AssetCard } from '../components/AssetCard.tsx';
import { Masonry } from '../components/Masonry.tsx';
import { ConfirmModal } from '../components/ConfirmModal.tsx';
import { isElectron, openExternal } from '../hooks/useElectron.ts';

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

const ROLE_COLORS: Record<string, string> = {
  manager: 'bg-brand-500/15 text-brand-500',
  worker: 'bg-blue-500/15 text-blue-600',
};

export function TemplateMarketplace({ authUser: _authUser, highlightItemId, onHighlightDone }: { authUser?: AuthUser; highlightItemId?: string | null; onHighlightDone?: () => void } = {}) {
  const { t, i18n } = useTranslation(['store', 'common']);
  const lang = i18n.language;
  const [search, setSearch] = useState('');
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [hubItems, setHubItems] = useState<HubItem[]>([]);
  const [selected, setSelected] = useState<TemplateInfo | null>(null);
  const [roleFiles, setRoleFiles] = useState<Record<string, string>>({});
  const [showHireModal, setShowHireModal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [localArtifacts, setLocalArtifacts] = useState<Map<string, LocalArtifactInfo>>(new Map());
  const [purchasedIds, setPurchasedIds] = useState<Set<string>>(new Set());
  const [detailItem, setDetailItem] = useState<{ type: string; name: string } | null>(null);
  const [notice, setNotice] = useState<{ title: string; message: string; variant?: 'primary' | 'danger' } | null>(null);

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
      const hubPromise = !search
        ? (consume<{ items: HubItem[]; total: number }>(PREFETCH_KEYS.hubAgents) ?? hubApi.search({ type: 'agent', limit: 50 }))
        : hubApi.search({ type: 'agent', q: search, limit: 50 });
      const params = new URLSearchParams();
      if (search) params.set('q', search);
      const templatesPromise = fetch('/api/templates?' + params.toString()).then(r => r.json()).catch(() => ({ templates: [] }));
      const [hubRes, tplRes] = await Promise.all([
        hubPromise.catch(() => ({ items: [] as HubItem[], total: 0 })),
        templatesPromise,
        loadLocalStatus(),
        hubApi.isAuthenticated()
          ? hubApi.purchases.mine().then(r => setPurchasedIds(new Set(r.purchases.map(p => p.itemId)))).catch(() => {})
          : Promise.resolve(),
      ]);
      const merged = await mergeHighlightedHubItem(hubRes?.items ?? [], highlightItemId);
      setHubItems(merged.items);
      setTemplates(Array.isArray(tplRes.templates) ? tplRes.templates : []);
      if (merged.missing) onHighlightDone?.();
    } catch {
      setTemplates([]);
      setHubItems([]);
    } finally {
      setLoading(false);
    }
  }, [search, loadLocalStatus, highlightItemId, onHighlightDone]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!selected) { setRoleFiles({}); return; }
    fetch(`/api/templates/${encodeURIComponent(selected.id)}/files`, { credentials: 'include' })
      .then(r => r.json())
      .then((data: { files?: Record<string, string> }) => setRoleFiles(data.files ?? {}))
      .catch(() => setRoleFiles({}));
  }, [selected]);

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
      setNotice({ title: t('common:create', { defaultValue: 'Create' }), message: `Failed to create agent: ${err}`, variant: 'danger' });
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
        {notice && (
          <ConfirmModal
            alertOnly
            variant={notice.variant ?? 'danger'}
            title={notice.title}
            message={notice.message}
            onConfirm={() => setNotice(null)}
            onCancel={() => setNotice(null)}
          />
        )}
      </>
    );
  }

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      <div data-electron-drag className="px-6 h-14 flex items-center justify-between shrink-0 gap-3">
        <h2 className="text-lg font-semibold">{t('agentStore.title')}</h2>
        <input
          type="text"
          placeholder={t('agentStore.searchPlaceholder')}
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="px-3 py-1.5 bg-surface-elevated border border-border-default rounded-lg text-sm max-w-xs w-full focus:border-brand-500 focus:outline-none"
        />
      </div>

      <div className="flex-1 overflow-y-auto p-7 space-y-8">
        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-56 rounded-2xl skeleton" />)}
          </div>
        ) : templates.length === 0 && hubItems.length === 0 ? (
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
          <>
            {templates.length > 0 && (
              <section>
                <div className="flex items-baseline gap-2 mb-3">
                  <h3 className="section-title">{t('agentStore.builtin')}</h3>
                  <span className="text-xs text-fg-tertiary">{t('agentStore.available', { count: templates.length })}</span>
                </div>
                <Masonry columns={3}>
                  {templates.map(tpl => (
                    <AssetCard
                      key={tpl.id}
                      type="agent"
                      name={localizedName(tpl, lang)}
                      description={localizedDesc(tpl, lang)}
                      seed={tpl.id}
                      icon={tpl.icon}
                      version={tpl.version}
                      category={tpl.category}
                      tags={tpl.tags}
                      authorLabel={tpl.author}
                      hideStats
                      showTypeBadge={false}
                      cornerLabel={t('agentStore.builtin')}
                      onClick={() => setSelected(tpl)}
                    />
                  ))}
                </Masonry>
              </section>
            )}

            {hubItems.length > 0 && (
              <section>
                <h3 className="section-title mb-3">{t('agentStore.markusHub')}</h3>
                <Masonry columns={3}>
                  {hubItems.map(item => (
                    <HubAgentCard key={item.id} item={item} localInfo={localArtifacts.get(hubItemSlug(item))} purchased={ownsHubItem(item, purchasedIds)} onStatusChange={loadLocalStatus} highlight={item.id === highlightItemId} onHighlightDone={onHighlightDone} onViewDetail={(name) => setDetailItem({ type: 'agent', name })} />
                  ))}
                </Masonry>
              </section>
            )}
          </>
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
      {notice && (
        <ConfirmModal
          alertOnly
          variant={notice.variant ?? 'danger'}
          title={notice.title}
          message={notice.message}
          onConfirm={() => setNotice(null)}
          onCancel={() => setNotice(null)}
        />
      )}
    </div>
  );
}

/**
 * Compute the local artifact slug for a Hub item. Prefer the Hub's canonical
 * slug (already URL-safe and unique), then the manifest's canonical name, and
 * only fall back to kebab-casing the display name. This avoids non-ASCII names
 * (e.g. Chinese) collapsing to a shared slug like "ai"/"hub-pkg" and clobbering
 * unrelated artifacts.
 */
export function hubItemSlug(item: HubItem, config?: Record<string, unknown>): string {
  if (item.slug && item.slug.trim()) return item.slug.trim();
  const configName = config && typeof config.name === 'string' ? config.name.trim() : '';
  if (configName) return kebab(configName, 'hub-pkg');
  return kebab(item.name, 'hub-pkg');
}

export function installHubItem(item: HubItem): Promise<string> {
  return (async () => {
    const data = await hubApi.download(item.id);
    const name = data.name || item.name;
    const config = (data.config ?? {}) as Record<string, unknown>;
    const slug = hubItemSlug(item, config);
    const mode = (data.itemType === 'team' ? 'team' : data.itemType === 'skill' ? 'skill' : 'agent') as 'agent' | 'team' | 'skill';
    const hubSource = { type: 'hub', hubItemId: item.id };
    // Prefer Hub marketplace version so local install matches the card and
    // does not fall back to buildManifest's default 1.0.0 (false Upgrade).
    const version = (data.version || item.version || (typeof config.version === 'string' ? config.version : '') || '').trim() || undefined;
    if (data.files && Object.keys(data.files).length > 0) {
      await api.builder.artifacts.import(mode, slug, data.files, hubSource, version);
    } else {
      const artifact = { ...config, ...(version ? { version } : {}), name: slug, displayName: (config.displayName as string) || name, description: item.description, source: hubSource };
      await api.builder.artifacts.save(mode, artifact);
    }
    await api.builder.artifacts.install(mode, slug);
    window.dispatchEvent(new CustomEvent('markus:data-changed'));
    return name;
  })();
}

/**
 * Purchase a paid Hub item in-place: tries earnings first, falls back to
 * opening checkout in browser and polling until purchased, then auto-installs.
 *
 * @returns 'installed' | 'cancelled' (user closed checkout without completing)
 */
export async function purchaseAndInstall(
  item: HubItem,
  onStatus: (status: 'checking' | 'checkout_opened' | 'installing') => void,
): Promise<'installed' | 'cancelled'> {
  onStatus('checking');
  await hubApi.ensureAuth();

  // Already owned? Skip straight to install
  const checkRes = await hubApi.purchases.checkout(item.id);
  if (checkRes.alreadyOwned) {
    onStatus('installing');
    await installHubItem(item);
    return 'installed';
  }

  // Try earnings balance first
  try {
    const balance = await hubApi.creator.getBalance();
    if (balance.availableBalance >= (item.priceCents ?? 0)) {
      const payRes = await hubApi.purchases.payWithEarnings(item.id);
      if (payRes.ok || payRes.alreadyOwned) {
        onStatus('installing');
        await installHubItem(item);
        return 'installed';
      }
    }
  } catch { /* no earnings or not logged in — continue to card checkout */ }

  // Card checkout: open in browser and poll
  if (!checkRes.checkoutUrl) throw new Error('No checkout URL');

  onStatus('checkout_opened');
  const electron = isElectron();
  // In Electron we open the checkout in the *system browser* via the IPC bridge
  // (shell.openExternal). There is no popup handle we can watch: `window.open`
  // gets denied by the window-open handler and returns null, so instead we rely
  // on a timeout and keep polling the backend until the purchase lands.
  let matcher: Window | null = null;
  if (electron) {
    openExternal(checkRes.checkoutUrl);
  } else {
    matcher = window.open(checkRes.checkoutUrl, '_blank', 'noopener');
  }

  // Poll until purchased, popup closed (web), or timed out (system browser).
  return new Promise<'installed' | 'cancelled'>((resolve, reject) => {
    const started = Date.now();
    const timeoutMs = 5 * 60 * 1000; // 5 min grace for card checkout in system browser
    const interval = setInterval(async () => {
      const elapsed = Date.now() - started;
      if (elapsed > timeoutMs) {
        clearInterval(interval);
        resolve('cancelled');
        return;
      }
      // System browser has no handle to watch — skip the popupClosed shortcut.
      const popupClosed = !electron && matcher ? matcher.closed : false;
      try {
        const poll = await hubApi.purchases.checkout(item.id);
        if (poll.alreadyOwned) {
          clearInterval(interval);
          onStatus('installing');
          try {
            await installHubItem(item);
            resolve('installed');
          } catch (e) { reject(e); }
          return;
        }
      } catch { /* ignore transient errors */ }
      if (popupClosed) {
        clearInterval(interval);
        // One final check in case purchase completed just as popup closed
        try {
          const finalCheck = await hubApi.purchases.checkout(item.id);
          if (finalCheck.alreadyOwned) {
            onStatus('installing');
            await installHubItem(item);
            resolve('installed');
            return;
          }
        } catch { /* ignore */ }
        resolve('cancelled');
      }
    }, 2000);
  });
}

function HubAgentCard({ item, localInfo, purchased, onStatusChange, highlight, onHighlightDone, onViewDetail }: { item: HubItem; localInfo?: LocalArtifactInfo; purchased?: boolean; onStatusChange: () => void; highlight?: boolean; onHighlightDone?: () => void; onViewDetail?: (name: string) => void }) {
  const { t } = useTranslation(['store']);
  const [installing, setInstalling] = useState(false);
  const [status, setStatus] = useState('');
  const cardRef = useRef<HTMLDivElement>(null);
  const [glowing, setGlowing] = useState(false);

  useEffect(() => {
    if (highlight && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setGlowing(true);
      // Keep parent highlightId until banner dismiss/install — only end the glow pulse here.
      const timer = setTimeout(() => { setGlowing(false); }, 4000);
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

  const priceLabel = isPaid ? `$${((item.priceCents ?? 0) / 100).toFixed(2)}` : null;

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
      {status && !(isPaid && !purchased) && <span className={`text-[10px] ${status === t('card.failed') || status === t('card.purchaseRequired') ? 'text-red-500' : 'text-green-600'}`}>{status}</span>}
    </>
  );

  return (
    <div ref={cardRef} className={glowing ? 'animate-pulse' : ''}>
      <AssetCard
        type="agent"
        showTypeBadge={false}
        name={item.name}
        description={item.description}
        seed={item.slug || item.name}
        icon={item.icon || 'bot'}
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
