import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api, hubApi, type AgentInfo, type AuthUser } from '../api.ts';
import { navBus } from '../navBus.ts';
import { PAGE } from '../routes.ts';
import { consume, PREFETCH_KEYS } from '../prefetchCache.ts';
import { useIsMobile } from '../hooks/useIsMobile.ts';
import { ArtifactDetail } from './ArtifactDetail.tsx';

function shortenPath(p: string): string {
  const home = '~/.markus/builder-artifacts/';
  const idx = p.indexOf('.markus/builder-artifacts/');
  return idx >= 0 ? '~/' + p.slice(idx) : p;
}

const BUILDER_PROMPTS = [
  {
    id: 'hireAgent' as const,
    icon: '✦',
    color: 'from-brand-500 to-purple-600',
    borderColor: 'border-brand-500/30 hover:border-brand-400/50',
    bgColor: 'bg-brand-500/10',
  },
  {
    id: 'buildTeam' as const,
    icon: '◈',
    color: 'from-blue-500 to-blue-600',
    borderColor: 'border-blue-500/30 hover:border-blue-400/50',
    bgColor: 'bg-blue-500/10',
  },
  {
    id: 'createSkill' as const,
    icon: '⬡',
    color: 'from-green-500 to-green-600',
    borderColor: 'border-green-500/30 hover:border-green-400/50',
    bgColor: 'bg-green-500/10',
  },
];

interface BuilderArtifact {
  type: string;
  name: string;
  meta: Record<string, unknown>;
  path: string;
  updatedAt: string;
}

const TYPE_STYLES: Record<string, { icon: string; color: string; bg: string }> = {
  agent: { icon: '✦', color: 'text-brand-500', bg: 'bg-brand-500/10' },
  team: { icon: '◈', color: 'text-blue-600', bg: 'bg-blue-500/10' },
  skill: { icon: '⬡', color: 'text-green-600', bg: 'bg-green-500/10' },
};

interface InstalledInfo {
  agentId?: string;
  teamId?: string;
  agentIds?: string[];
}

function ConfirmDialog({ title, message, cancelLabel, confirmLabel, onConfirm, onCancel }: { title: string; message: string; cancelLabel: string; confirmLabel: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onCancel}>
      <div className="bg-surface-secondary border border-border-default rounded-xl p-6 max-w-sm mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-red-500/15 flex items-center justify-center shrink-0">
            <svg className="w-5 h-5 text-red-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
            </svg>
          </div>
          <div>
            <div className="text-sm font-medium text-fg-primary">{title}</div>
            <div className="text-xs text-fg-secondary mt-0.5">{message}</div>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-4 py-1.5 text-xs text-fg-secondary hover:text-fg-primary border border-border-default hover:border-gray-600 rounded-lg transition-colors">{cancelLabel}</button>
          <button onClick={onConfirm} className="px-4 py-1.5 text-xs bg-red-600 hover:bg-red-500 text-white rounded-lg transition-colors">{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

function useBuilderSubRoute(): { type: string; name: string } | null {
  const [sub, setSub] = useState<{ type: string; name: string } | null>(() => {
    const hash = window.location.hash.slice(1);
    const parts = hash.split('/');
    if (parts[0] === 'builder' && parts[1] && parts[2]) return { type: parts[1], name: decodeURIComponent(parts[2]) };
    return null;
  });
  useEffect(() => {
    const onHash = () => {
      const hash = window.location.hash.slice(1);
      const parts = hash.split('/');
      if (parts[0] === 'builder' && parts[1] && parts[2]) setSub({ type: parts[1], name: decodeURIComponent(parts[2]) });
      else setSub(null);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return sub;
}

export function AgentBuilder({ authUser }: { authUser?: AuthUser } = {}) {
  const { t } = useTranslation(['builder', 'common']);
  const isMobile = useIsMobile();
  const subRoute = useBuilderSubRoute();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [artifacts, setArtifacts] = useState<BuilderArtifact[]>([]);
  const [loading, setLoading] = useState(false);
  const [filterType, setFilterType] = useState<string>('all');
  const [actionInProgress, setActionInProgress] = useState<{ key: string; action: string } | null>(null);
  const [installedMap, setInstalledMap] = useState<Map<string, InstalledInfo>>(new Map());
  const [deleteTarget, setDeleteTarget] = useState<BuilderArtifact | null>(null);
  const [sharedMap, setSharedMap] = useState<Map<string, { id: string; name: string; slug: string; version: string }>>(new Map());
  const [hubDeleteTarget, setHubDeleteTarget] = useState<{ key: string; name: string } | null>(null);
  const [sharePrompt, setSharePrompt] = useState<BuilderArtifact | null>(null);
  const [shareModeTarget, setShareModeTarget] = useState<BuilderArtifact | null>(null);

  const loadAll = useCallback(() => {
    setLoading(true);
    Promise.all([
      (consume<{ artifacts: BuilderArtifact[] }>(PREFETCH_KEYS.builderArtifacts) ?? api.builder.artifacts.list()).then(d => d?.artifacts ?? []).catch(() => [] as BuilderArtifact[]),
      (consume<{ agents: AgentInfo[] }>(PREFETCH_KEYS.builderAgents) ?? api.agents.list()).then(d => d?.agents ?? []).catch(() => [] as AgentInfo[]),
      (consume<{ items: Array<{ id: string; itemType: string; name: string; slug: string; version: string }> }>(PREFETCH_KEYS.builderHubMyItems) ?? hubApi.myItems()).then(d => d?.items ?? []).catch(() => [] as Array<{ id: string; itemType: string; name: string; slug: string; version: string }>),
      (consume<{ installed: Record<string, { agentId?: string; agentIds?: string[]; teamId?: string }> }>(PREFETCH_KEYS.builderInstalled) ?? api.builder.artifacts.installed()).then(d => d?.installed ?? {}).catch(() => ({} as Record<string, { agentId?: string; agentIds?: string[]; teamId?: string }>)),
    ]).then(([arts, agentList, hubItems, installedData]) => {
      setArtifacts(arts);
      setAgents(agentList);

      // Populate shared status from Hub published items (key → { id, name, slug })
      if (hubItems.length > 0) {
        const shared = new Map<string, { id: string; name: string; slug: string; version: string }>();
        for (const hi of hubItems) {
          const typeDir = hi.itemType === 'agent' ? 'agent' : hi.itemType === 'team' ? 'team' : 'skill';
          for (const art of arts) {
            if (art.type === typeDir && (hi.slug === art.name || hi.name === ((art.meta.displayName as string) || (art.meta.name as string) || art.name))) {
              shared.set(`${art.type}/${art.name}`, { id: hi.id, name: hi.name, slug: hi.slug || art.name, version: (hi as Record<string, string>).version || '1.0.0' });
            }
          }
        }
        if (shared.size > 0) setSharedMap(prev => { const m = new Map(prev); for (const [k, v] of shared) m.set(k, v); return m; });
      }

      // Detect installed artifacts from backend scan (uses .role-origin.json markers + skill dirs)
      const detected = new Map<string, InstalledInfo>();
      for (const art of arts) {
        const key = `${art.type}/${art.name}`;
        const backendEntry = installedData[key];
        if (backendEntry) {
          detected.set(key, {
            agentId: backendEntry.agentId,
            agentIds: backendEntry.agentIds,
            teamId: backendEntry.teamId,
          });
        }
      }
      setInstalledMap(detected);
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadAll();
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent).detail as { page?: string } | undefined;
      if (detail?.page === PAGE.BUILDER) loadAll();
    };
    window.addEventListener('markus:navigate', onNav);
    return () => window.removeEventListener('markus:navigate', onNav);
  }, [loadAll]);

  const navigateToSecretary = (prompt: string) => {
    const secretary = agents.find(a => a.role === 'Secretary' || a.name === 'Secretary');
    if (secretary) {
      navBus.navigate(PAGE.TEAM, { agentId: secretary.id, prefillMessage: prompt });
    } else {
      navBus.navigate(PAGE.TEAM, { prefillMessage: prompt });
    }
  };

  const handleInstall = async (art: BuilderArtifact) => {
    const key = `${art.type}/${art.name}`;
    if (installedMap.has(key)) return;
    setActionInProgress({ key, action: 'install' });
    try {
      const result = await api.builder.artifacts.install(art.type, art.name);
      const info: InstalledInfo = {};
      if (result.agent && typeof result.agent === 'object') info.agentId = (result.agent as Record<string, string>).id;
      if (result.team && typeof result.team === 'object') info.teamId = (result.team as Record<string, string>).id;
      if (Array.isArray(result.agents)) info.agentIds = (result.agents as Array<Record<string, string>>).map(a => a.id);
      setInstalledMap(prev => new Map(prev).set(key, info));
      window.dispatchEvent(new CustomEvent('markus:data-changed'));
    } catch (err) {
      console.error('Install failed:', err);
      alert(t('installFailed', { error: String(err) }));
    } finally {
      setActionInProgress(null);
    }
  };

  const handleUninstall = async (art: BuilderArtifact) => {
    const key = `${art.type}/${art.name}`;
    if (!installedMap.has(key)) return;
    setActionInProgress({ key, action: 'uninstall' });
    try {
      await api.builder.artifacts.uninstall(art.type, art.name);
      setInstalledMap(prev => { const m = new Map(prev); m.delete(key); return m; });
      window.dispatchEvent(new CustomEvent('markus:data-changed'));
    } catch (err) {
      console.error('Uninstall failed:', err);
      alert(t('uninstallFailed', { error: String(err) }));
    } finally {
      setActionInProgress(null);
    }
  };

  const handleShare = async (art: BuilderArtifact, opts?: { priceCents?: number; donationsEnabled?: boolean }) => {
    const key = `${art.type}/${art.name}`;
    setActionInProgress({ key, action: 'share' });
    try {
      const detail = await api.builder.artifacts.get(art.type, art.name);
      const name = (art.meta.displayName as string) || (art.meta.name as string) || art.name;
      const description = (art.meta.description as string) || '';
      const category = (art.meta.category as string) || 'general';
      const tags = Array.isArray(art.meta.tags) ? (art.meta.tags as string[]) : [];
      const slug = art.name;
      let icon: string | undefined = (art.meta.icon as string) || undefined;
      const version = (art.meta.version as string) || '1.0.0';

      // If icon is a local image path, upload it to Hub
      if (icon && !icon.startsWith('http') && /\.(png|jpe?g|gif|webp|svg)$/i.test(icon)) {
        const iconFilename = icon.split('/').pop() ?? icon;
        try {
          const iconResp = await fetch(`/api/builder/artifacts/${art.type}s/${encodeURIComponent(art.name)}/images/${encodeURIComponent(iconFilename)}`);
          if (iconResp.ok) {
            const blob = await iconResp.blob();
            const file = new File([blob], iconFilename, { type: blob.type });
            const uploaded = await hubApi.uploadImage(file);
            if (uploaded?.url) icon = uploaded.url;
          }
        } catch { /* keep original icon */ }
      }

      let thumbnailUrl: string | undefined;
      const hubImages: Array<{ url: string; alt: string; order: number }> = [];
      const screenshots = Array.isArray(art.meta.screenshots) ? (art.meta.screenshots as string[]) : [];
      for (let i = 0; i < screenshots.length; i++) {
        const imgPath = screenshots[i]!;
        const filename = imgPath.split('/').pop() ?? imgPath;
        try {
          const imgResp = await fetch(`/api/builder/artifacts/${art.type}s/${encodeURIComponent(art.name)}/images/${encodeURIComponent(filename)}`);
          if (imgResp.ok) {
            const blob = await imgResp.blob();
            const file = new File([blob], filename, { type: blob.type });
            const uploaded = await hubApi.uploadImage(file);
            if (uploaded?.url) {
              hubImages.push({ url: uploaded.url, alt: filename, order: i });
              if (i === 0 || (art.meta.thumbnail as string) === imgPath) thumbnailUrl = uploaded.url;
            }
          }
        } catch { /* skip failed image uploads */ }
      }

      const result = await hubApi.publishViaProxy({
        itemType: art.type === 'team' ? 'team' : art.type === 'skill' ? 'skill' : 'agent',
        name,
        slug,
        description,
        category,
        tags,
        icon,
        version,
        config: art.meta,
        files: detail.files && Object.keys(detail.files).length > 0 ? detail.files : undefined,
        thumbnailUrl,
        images: hubImages.length > 0 ? hubImages : undefined,
        priceCents: opts?.priceCents,
        donationsEnabled: opts?.donationsEnabled,
      });
      if (result.id) setSharedMap(prev => { const m = new Map(prev); m.set(key, { id: result.id!, name, slug: result.slug ?? slug, version }); return m; });
    } catch (err) {
      console.error('Share failed:', err);
      alert(t('shareFailed', { error: String(err) }));
    } finally {
      setActionInProgress(null);
    }
  };

  const confirmHubDelete = async () => {
    if (!hubDeleteTarget) return;
    const { key } = hubDeleteTarget;
    const hubItem = sharedMap.get(key);
    setHubDeleteTarget(null);
    if (!hubItem) return;
    const hubItemId = hubItem.id;
    setActionInProgress({ key, action: 'hubDelete' });
    try {
      await hubApi.deleteItem(hubItemId);
      setSharedMap(prev => { const m = new Map(prev); m.delete(key); return m; });
    } catch (err) {
      console.error('Hub delete failed:', err);
      alert(t('hubDeleteFailed', { error: String(err) }));
    } finally {
      setActionInProgress(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const art = deleteTarget;
    const key = `${art.type}/${art.name}`;
    setDeleteTarget(null);
    setActionInProgress({ key, action: 'delete' });
    try {
      await api.builder.artifacts.delete(art.type, art.name);
      setArtifacts(prev => prev.filter(a => !(a.type === art.type && a.name === art.name)));
      setInstalledMap(prev => { const m = new Map(prev); m.delete(key); return m; });
      window.dispatchEvent(new CustomEvent('markus:data-changed'));
    } catch (err) {
      console.error('Delete failed:', err);
    } finally {
      setActionInProgress(null);
    }
  };

  const filtered = filterType === 'all' ? artifacts : artifacts.filter(a => a.type === filterType);

  const navigateToDetail = (art: BuilderArtifact) => {
    history.pushState(null, '', `#builder/${art.type}/${encodeURIComponent(art.name)}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  };

  if (subRoute) {
    return (
      <ArtifactDetail
        type={subRoute.type}
        name={subRoute.name}
        authUser={authUser}
        onBack={() => {
          history.pushState(null, '', '#builder');
          window.dispatchEvent(new HashChangeEvent('hashchange'));
        }}
      />
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className={`max-w-4xl ${isMobile ? 'px-4 py-5' : 'px-6 py-10'}`}>
        {/* Builder prompts → navigate to Secretary */}
        <div className="mb-10">
          <h1 className="text-2xl font-bold text-fg-primary">{t('title')}</h1>
          <p className="text-sm text-fg-tertiary mt-2">
            {t('subtitle')}
          </p>
        </div>

        <div className="grid gap-5">
          {BUILDER_PROMPTS.map(b => {
            const examplesRaw = t(`prompts.${b.id}Examples`, { returnObjects: true });
            const examples = Array.isArray(examplesRaw) ? examplesRaw : [];
            const promptPrefix = t(`prompts.${b.id}Prompt`);
            return (
            <button
              key={b.id}
              onClick={() => navigateToSecretary(promptPrefix)}
              className={`group text-left w-full rounded-xl border ${b.borderColor} bg-surface-secondary/60 ${isMobile ? 'p-4' : 'p-6'} transition-all hover:bg-surface-secondary/80 hover:shadow-lg`}
            >
              <div className={`flex items-start ${isMobile ? 'gap-3' : 'gap-5'}`}>
                <div className={`${isMobile ? 'w-10 h-10 text-xl' : 'w-14 h-14 text-2xl'} rounded-xl ${b.bgColor} flex items-center justify-center shrink-0`}>
                  {b.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className={`${isMobile ? 'text-base' : 'text-lg'} font-semibold bg-gradient-to-r ${b.color} bg-clip-text text-transparent`}>
                      {t(`prompts.${b.id}`)}
                    </h3>
                  </div>
                  <p className="text-sm text-fg-secondary leading-relaxed">{t(`prompts.${b.id}Desc`)}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {examples.map((ex, i) => (
                      <span key={i} className="text-[11px] text-fg-tertiary bg-surface-elevated/60 rounded-full px-3 py-1 border border-border-default cursor-pointer hover:bg-surface-elevated/80 hover:text-fg-secondary transition-colors"
                        onClick={(e) => { e.stopPropagation(); navigateToSecretary(promptPrefix + ex); }}>
                        &ldquo;{ex}&rdquo;
                      </span>
                    ))}
                  </div>
                </div>
                <svg className="w-5 h-5 text-fg-muted group-hover:text-fg-secondary transition-colors shrink-0 mt-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </div>
            </button>
            );
          })}
        </div>

        {/* Artifact management section */}
        <div className="mt-14 mb-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-fg-primary">{t('myCreations.title')}</h2>
              <p className="text-xs text-fg-tertiary mt-1">{t('myCreations.subtitle')}</p>
            </div>
            <button
              onClick={loadAll}
              className="text-xs text-fg-tertiary hover:text-fg-secondary transition-colors px-3 py-1.5 rounded-lg border border-border-default hover:border-gray-600"
            >
              {t('common:refresh')}
            </button>
          </div>

          <div className="flex gap-2 mt-4">
            {(['all', 'agent', 'team', 'skill'] as const).map(ft => (
              <button
                key={ft}
                onClick={() => setFilterType(ft)}
                className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                  filterType === ft
                    ? 'border-gray-600 bg-surface-elevated text-fg-primary'
                    : 'border-border-default text-fg-tertiary hover:text-fg-secondary hover:border-gray-600'
                }`}
              >
                {ft === 'all'
                  ? t('myCreations.filterAll')
                  : ft === 'agent'
                    ? t('myCreations.filterAgents')
                    : ft === 'team'
                      ? t('myCreations.filterTeams')
                      : t('myCreations.filterSkills')}
              </button>
            ))}
          </div>
        </div>

        {loading && artifacts.length === 0 ? (
          <div className="text-center text-fg-tertiary py-12 text-sm">{t('myCreations.loadingArtifacts')}</div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-fg-tertiary text-sm">{t('myCreations.noArtifacts')}</div>
            <div className="text-fg-muted text-xs mt-1">{t('myCreations.noArtifactsHint')}</div>
          </div>
        ) : (
          <div className="grid gap-3">
            {filtered.map(art => {
              const style = TYPE_STYLES[art.type] ?? TYPE_STYLES.agent!;
              const displayName = (art.meta.displayName as string) || (art.meta.name as string) || art.name;
              const description = (art.meta.description as string) || '';
              const key = `${art.type}/${art.name}`;
              const busyAction = actionInProgress?.key === key ? actionInProgress.action : null;

              const hubItem = sharedMap.get(key);
              const localVersion = (art.meta.version as string) || '1.0.0';
              const isShared = !!hubItem;
              const hasNewVersion = isShared && hubItem.version !== localVersion;

              const getHubLink = () => {
                const hubUser = hubApi.getUser();
                if (!hubItem || !hubUser) return null;
                return `${hubApi.getUrl()}/${encodeURIComponent(hubUser.username)}/${encodeURIComponent(hubItem.slug)}`;
              };

              const actionButtons = (
                <div className={`flex items-center gap-1.5 ${isMobile ? 'flex-wrap' : 'shrink-0'}`} onClick={e => e.stopPropagation()}>
                  {installedMap.has(key) ? (
                    <button onClick={() => handleUninstall(art)} disabled={!!busyAction}
                      className="text-xs px-3 py-1.5 rounded-lg border border-green-600/30 text-green-600 hover:bg-red-500/10 hover:text-red-500 hover:border-red-500/30 transition-colors disabled:opacity-50">
                      {busyAction === 'uninstall' ? t('common:uninstalling') : t('common:uninstall')}
                    </button>
                  ) : (
                    <button onClick={() => handleInstall(art)} disabled={!!busyAction}
                      className="text-xs px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors disabled:opacity-50">
                      {busyAction === 'install' ? t('common:installing') : t('common:install')}
                    </button>
                  )}
                  {isShared && hasNewVersion ? (
                    <button onClick={() => setShareModeTarget(art)} disabled={!!busyAction}
                      className="text-xs px-3 py-1.5 rounded-lg border border-amber-500/30 text-amber-400 hover:bg-amber-500/10 hover:border-amber-500/50 transition-colors disabled:opacity-50">
                      {busyAction === 'share' ? t('common:sharing') : t('share.updateVersion', { version: localVersion })}
                    </button>
                  ) : isShared ? (
                    <div className="flex items-center gap-1">
                      <a href={getHubLink() ?? '#'} target="_blank" rel="noopener noreferrer"
                        className="text-xs px-3 py-1.5 rounded-lg border border-green-600/30 text-green-600 hover:text-green-500 hover:border-green-500/40 transition-colors inline-flex items-center gap-1">
                        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                        {t('common:shared')}
                      </a>
                      <button onClick={() => setHubDeleteTarget({ key, name: displayName })} disabled={!!busyAction}
                        className="text-xs px-1.5 py-1.5 rounded-lg text-fg-tertiary hover:text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50" title={t('removeFromHubTooltip')}>
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                      </button>
                    </div>
                  ) : (
                    <button onClick={async () => {
                      await hubApi.ensureAuth();
                      const hasImages = Array.isArray(art.meta.screenshots) && art.meta.screenshots.length > 0;
                      if (hasImages) { setShareModeTarget(art); } else { setSharePrompt(art); }
                    }} disabled={!!busyAction}
                      className="text-xs px-3 py-1.5 rounded-lg border border-border-default text-fg-secondary hover:text-green-600 hover:border-green-500/30 transition-colors disabled:opacity-50">
                      {busyAction === 'share' ? t('common:sharing') : t('common:share')}
                    </button>
                  )}
                  <button onClick={() => setDeleteTarget(art)} disabled={!!busyAction}
                    className="text-xs px-2 py-1.5 rounded-lg text-fg-tertiary hover:text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50" title={t('common:delete')}>
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                  </button>
                </div>
              );

              return (
                <div key={key} onClick={() => navigateToDetail(art)}
                  className="group rounded-lg border border-border-default bg-surface-secondary/60 p-4 hover:border-gray-600 transition-all overflow-hidden cursor-pointer">
                  <div className="flex items-start gap-3 min-w-0">
                    {(() => {
                      const artIcon = art.meta.icon as string | undefined;
                      const isImgIcon = artIcon && (artIcon.startsWith('http') || artIcon.startsWith('/') || /\.(png|jpe?g|gif|webp|svg)$/i.test(artIcon));
                      const imgSrc = isImgIcon
                        ? (artIcon.startsWith('http') || artIcon.startsWith('/'))
                          ? artIcon
                          : `/api/builder/artifacts/${art.type}s/${encodeURIComponent(art.name)}/images/${encodeURIComponent(artIcon.split('/').pop() ?? '')}`
                        : null;
                      return (
                        <div className={`w-9 h-9 rounded-lg ${style.bg} flex items-center justify-center text-lg shrink-0 overflow-hidden`}>
                          {imgSrc ? <img src={imgSrc} alt="" className="w-full h-full object-cover" />
                            : artIcon ? <span>{artIcon}</span>
                            : style.icon}
                        </div>
                      );
                    })()}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-sm font-medium text-fg-primary truncate">{displayName}</span>
                        <span className={`text-[10px] font-medium uppercase tracking-wider ${style.color}`}>{art.type}</span>
                      </div>
                      {description && <p className="text-xs text-fg-tertiary line-clamp-2">{description}</p>}
                      <div className="flex items-center gap-3 mt-2 text-[10px] text-fg-tertiary min-w-0">
                        <button
                          onClick={(e) => { e.stopPropagation(); api.system.openPath(art.path).catch(() => {}); }}
                          className="hover:text-fg-secondary transition-colors truncate min-w-0"
                          title={art.path}
                        >{shortenPath(art.path)}</button>
                        <span className="shrink-0">{new Date(art.updatedAt).toLocaleDateString()}</span>
                      </div>
                    </div>
                    {!isMobile && actionButtons}
                  </div>
                  {isMobile && <div className="mt-3 pt-3 border-t border-border-default/50">{actionButtons}</div>}
                </div>
              );
            })}
          </div>
        )}

        {deleteTarget && (
          <ConfirmDialog
            title={t('confirmDelete')}
            message={t('deleteCannotUndo', { name: (deleteTarget.meta.displayName as string) || (deleteTarget.meta.name as string) || deleteTarget.name })}
            cancelLabel={t('common:cancel')}
            confirmLabel={t('common:delete')}
            onConfirm={confirmDelete}
            onCancel={() => setDeleteTarget(null)}
          />
        )}
        {hubDeleteTarget && (
          <ConfirmDialog
            title={t('confirmDelete')}
            message={t('removeFromHub', { name: hubDeleteTarget.name })}
            cancelLabel={t('common:cancel')}
            confirmLabel={t('common:delete')}
            onConfirm={() => void confirmHubDelete()}
            onCancel={() => setHubDeleteTarget(null)}
          />
        )}
        {sharePrompt && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setSharePrompt(null)}>
            <div className="bg-gray-900 border border-gray-700 rounded-xl max-w-sm w-full mx-4 p-6" onClick={e => e.stopPropagation()}>
              <h3 className="text-base font-semibold text-fg-primary mb-2">{t('common:share')}</h3>
              <p className="text-sm text-fg-secondary mb-5">{t('share.imagePrompt')}</p>
              <div className="flex gap-3">
                <button
                  onClick={() => { const art = sharePrompt; setSharePrompt(null); setShareModeTarget(art); }}
                  className="flex-1 text-sm px-4 py-2 rounded-lg border border-border-default text-fg-secondary hover:text-fg-primary hover:border-gray-600 transition-colors">
                  {t('share.directly')}
                </button>
                <button
                  onClick={() => { const art = sharePrompt; setSharePrompt(null); navigateToDetail(art); }}
                  className="flex-1 text-sm px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors">
                  {t('share.addImagesFirst')}
                </button>
              </div>
            </div>
          </div>
        )}
        {shareModeTarget && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShareModeTarget(null)}>
            <div className="bg-gray-900 border border-gray-700 rounded-xl max-w-sm w-full mx-4 p-6" onClick={e => e.stopPropagation()}>
              <ShareModeSelect
                isUpdate={sharedMap.has(`${shareModeTarget.type}/${shareModeTarget.name}`)}
                onCancel={() => setShareModeTarget(null)}
                onConfirm={(mode, price) => {
                  const art = shareModeTarget;
                  setShareModeTarget(null);
                  void handleShare(art, {
                    donationsEnabled: mode === 'donation',
                    priceCents: mode === 'paid' ? price : undefined,
                  });
                }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ShareModeSelect({ isUpdate, onCancel, onConfirm }: {
  isUpdate: boolean;
  onCancel: () => void;
  onConfirm: (mode: 'free' | 'donation' | 'paid', priceCents: number) => void;
}) {
  const { t } = useTranslation(['builder', 'common']);
  const [mode, setMode] = useState<'free' | 'donation' | 'paid'>('free');
  const [price, setPrice] = useState('');

  return (
    <>
      <h3 className="text-base font-semibold text-fg-primary mb-4">
        {isUpdate ? t('shareMode.titleUpdate') : t('shareMode.title')}
      </h3>
      <div className="space-y-2 mb-5">
        <label className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${mode === 'free' ? 'border-brand-500 bg-brand-500/10' : 'border-border-default hover:border-gray-600'}`}>
          <input type="radio" name="shareMode" checked={mode === 'free'} onChange={() => setMode('free')} className="accent-brand-500" />
          <div>
            <div className="text-sm font-medium text-fg-primary">{t('shareMode.free')}</div>
            <div className="text-[11px] text-fg-tertiary">{t('shareMode.freeDesc')}</div>
          </div>
        </label>
        <label className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${mode === 'donation' ? 'border-brand-500 bg-brand-500/10' : 'border-border-default hover:border-gray-600'}`}>
          <input type="radio" name="shareMode" checked={mode === 'donation'} onChange={() => setMode('donation')} className="accent-brand-500" />
          <div>
            <div className="text-sm font-medium text-fg-primary">{t('shareMode.donation')}</div>
            <div className="text-[11px] text-fg-tertiary">{t('shareMode.donationDesc')}</div>
          </div>
        </label>
        <label className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${mode === 'paid' ? 'border-brand-500 bg-brand-500/10' : 'border-border-default hover:border-gray-600'}`}>
          <input type="radio" name="shareMode" checked={mode === 'paid'} onChange={() => setMode('paid')} className="accent-brand-500" />
          <div>
            <div className="text-sm font-medium text-fg-primary">{t('shareMode.paid')}</div>
            <div className="text-[11px] text-fg-tertiary">{t('shareMode.paidDesc')}</div>
          </div>
        </label>
      </div>
      {mode === 'paid' && (
        <div className="mb-5">
          <label className="text-xs text-fg-secondary block mb-1.5">{t('shareMode.priceLabel')}</label>
          <div className="flex items-center gap-2">
            <span className="text-sm text-fg-tertiary">$</span>
            <input type="number" min="0.5" step="0.5" value={price} onChange={e => setPrice(e.target.value)} placeholder={t('shareMode.pricePlaceholder')}
              className="flex-1 text-sm px-3 py-2 rounded-lg bg-surface-elevated border border-border-default text-fg-primary placeholder:text-fg-muted" />
          </div>
        </div>
      )}
      <div className="flex gap-3">
        <button onClick={onCancel} className="flex-1 text-sm px-4 py-2 rounded-lg border border-border-default text-fg-secondary hover:text-fg-primary hover:border-gray-600 transition-colors">
          {t('common:cancel')}
        </button>
        <button onClick={() => onConfirm(mode, mode === 'paid' ? Math.round(Number(price) * 100) : 0)}
          disabled={mode === 'paid' && (!price || Number(price) <= 0)}
          className="flex-1 text-sm px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
          {isUpdate ? t('shareMode.update') : t('shareMode.share')}
        </button>
      </div>
    </>
  );
}
