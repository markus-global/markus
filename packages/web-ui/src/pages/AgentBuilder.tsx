import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api, hubApi, toPackageSlug, type AgentInfo, type AuthUser, type HubVisibility, type HubModerationStatus, type HubOrg, type HubItem } from '../api.ts';
import { navBus } from '../navBus.ts';
import { PAGE, resolvePageId, hashPath } from '../routes.ts';
import { consume, PREFETCH_KEYS } from '../prefetchCache.ts';
import { useIsMobile } from '../hooks/useIsMobile.ts';
import { isElectron, openExternal } from '../hooks/useElectron.ts';
import { ArtifactDetail } from './ArtifactDetail.tsx';
import { AssetCard } from '../components/AssetCard.tsx';
import { Masonry } from '../components/Masonry.tsx';
import { ConfirmModal } from '../components/ConfirmModal.tsx';

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

interface InstalledInfo {
  agentId?: string;
  teamId?: string;
  agentIds?: string[];
}

function useBuilderSubRoute(): { type: string; name: string } | null {
  const [sub, setSub] = useState<{ type: string; name: string } | null>(() => {
    const hash = window.location.hash.slice(1);
    const parts = hash.split('/');
    if (resolvePageId(parts[0]) === PAGE.BUILDER && parts[1] && parts[2]) return { type: parts[1], name: decodeURIComponent(parts[2]) };
    return null;
  });
  useEffect(() => {
    const onHash = () => {
      const hash = window.location.hash.slice(1);
      const parts = hash.split('/');
      if (resolvePageId(parts[0]) === PAGE.BUILDER && parts[1] && parts[2]) setSub({ type: parts[1], name: decodeURIComponent(parts[2]) });
      else setSub(null);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return sub;
}

const SHARED_MAP_STORAGE_KEY = 'markus_builder_shared_map';
type SharedEntry = { id: string; name: string; slug: string; version: string; visibility?: HubVisibility; moderationStatus?: HubModerationStatus; pendingReview?: boolean };

function loadSharedMapFromStorage(): Map<string, SharedEntry> {
  try {
    const raw = localStorage.getItem(SHARED_MAP_STORAGE_KEY);
    if (!raw) return new Map();
    const obj = JSON.parse(raw) as Record<string, SharedEntry>;
    return new Map(Object.entries(obj));
  } catch { return new Map(); }
}

function saveSharedMapToStorage(m: Map<string, SharedEntry>): void {
  try {
    localStorage.setItem(SHARED_MAP_STORAGE_KEY, JSON.stringify(Object.fromEntries(m)));
  } catch { /* quota exceeded etc */ }
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
  const [installTarget, setInstallTarget] = useState<BuilderArtifact | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<BuilderArtifact | null>(null);
  const [sharedMap, setSharedMap] = useState<Map<string, SharedEntry>>(loadSharedMapFromStorage);
  const [hubDeleteTarget, setHubDeleteTarget] = useState<{ key: string; name: string } | null>(null);
  const [notice, setNotice] = useState<{ title: string; message: string; variant?: 'primary' | 'danger' } | null>(null);
  const [sharePrompt, setSharePrompt] = useState<BuilderArtifact | null>(null);
  const [shareModeTarget, setShareModeTarget] = useState<BuilderArtifact | null>(null);
  const [visibilityTarget, setVisibilityTarget] = useState<BuilderArtifact | null>(null);
  const [activeTab, setActiveTab] = useState<'creations' | 'orgAssets'>('creations');
  const [orgs, setOrgs] = useState<HubOrg[]>([]);
  const [selectedOrgId, setSelectedOrgId] = useState<string>('');
  const [orgItems, setOrgItems] = useState<HubItem[]>([]);
  const [orgItemsLoading, setOrgItemsLoading] = useState(false);
  const [orgFilterType, setOrgFilterType] = useState<string>('all');

  const loadAll = useCallback(() => {
    setLoading(true);
    Promise.all([
      (consume<{ artifacts: BuilderArtifact[] }>(PREFETCH_KEYS.builderArtifacts) ?? api.builder.artifacts.list()).then(d => d?.artifacts ?? []).catch(() => [] as BuilderArtifact[]),
      (consume<{ agents: AgentInfo[] }>(PREFETCH_KEYS.builderAgents) ?? api.agents.list()).then(d => d?.agents ?? []).catch(() => [] as AgentInfo[]),
      (consume<{ items: Array<{ id: string; itemType: string; name: string; slug: string; version: string; visibility?: HubVisibility; moderationStatus?: HubModerationStatus; pendingReview?: boolean }> }>(PREFETCH_KEYS.builderHubMyItems) ?? hubApi.myItems()).then(d => d?.items ?? []).catch(() => [] as Array<{ id: string; itemType: string; name: string; slug: string; version: string; visibility?: HubVisibility; moderationStatus?: HubModerationStatus; pendingReview?: boolean }>),
      (consume<{ installed: Record<string, { agentId?: string; agentIds?: string[]; teamId?: string }> }>(PREFETCH_KEYS.builderInstalled) ?? api.builder.artifacts.installed()).then(d => d?.installed ?? {}).catch(() => ({} as Record<string, { agentId?: string; agentIds?: string[]; teamId?: string }>)),
    ]).then(([arts, agentList, hubItems, installedData]) => {
      setArtifacts(arts);
      setAgents(agentList);

      // Populate shared status from Hub published items, merged with local cache
      if (hubItems.length > 0) {
        const shared = new Map<string, SharedEntry>();
        for (const hi of hubItems) {
          const typeDir = hi.itemType === 'agent' ? 'agent' : hi.itemType === 'team' ? 'team' : 'skill';
          for (const art of arts) {
            if (art.type === typeDir && (hi.slug === art.name || hi.name === ((art.meta.displayName as string) || (art.meta.name as string) || art.name))) {
              shared.set(`${art.type}/${art.name}`, { id: hi.id, name: hi.name, slug: hi.slug || art.name, version: hi.version || '1.0.0', visibility: hi.visibility ?? 'public', moderationStatus: hi.moderationStatus, pendingReview: hi.pendingReview });
            }
          }
        }
        if (shared.size > 0) {
          setSharedMap(prev => { const m = new Map(prev); for (const [k, v] of shared) m.set(k, v); saveSharedMapToStorage(m); return m; });
        }
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
      setNotice({ title: t('common:install'), message: t('installFailed', { error: String(err) }), variant: 'danger' });
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
      setNotice({ title: t('common:uninstall'), message: t('uninstallFailed', { error: String(err) }), variant: 'danger' });
    } finally {
      setActionInProgress(null);
    }
  };

  const handleShare = async (art: BuilderArtifact, opts?: { priceCents?: number; donationsEnabled?: boolean; visibility?: HubVisibility; orgId?: string }) => {
    const key = `${art.type}/${art.name}`;
    setActionInProgress({ key, action: 'share' });
    try {
      // Legacy Chinese / invalid folder names → auto-convert to a valid Hub slug.
      // Skip the server call when the folder name is already a valid slug.
      const ensured = await api.builder.artifacts.ensureSlugSafe(
        art.type,
        art.name,
        (art.meta.displayName as string) || (art.meta.name as string) || art.name,
      );
      const artName = ensured.name;
      const slug = ensured.slug || toPackageSlug(artName);
      if (!slug) {
        throw new Error('Invalid package slug: use English kebab-case for the artifact name (e.g. qwen-multimodal). Chinese-only names cannot be shared — rename the package slug and put the Chinese title in displayName.');
      }
      const newKey = `${art.type}/${artName}`;
      if (ensured.converted) {
        setArtifacts(prev => prev.map(a => a.type === art.type && a.name === art.name
          ? {
              ...a,
              name: artName,
              path: ensured.path,
              meta: {
                ...a.meta,
                name: artName,
                displayName: ensured.displayName ?? (a.meta.displayName as string) ?? art.name,
              },
            }
          : a));
        setSharedMap(prev => {
          const m = new Map(prev);
          const prevEntry = m.get(key);
          if (prevEntry) { m.delete(key); m.set(newKey, { ...prevEntry, slug, name: ensured.displayName ?? prevEntry.name }); }
          saveSharedMapToStorage(m);
          return m;
        });
        setInstalledMap(prev => {
          const m = new Map(prev);
          const prevEntry = m.get(key);
          if (prevEntry) { m.delete(key); m.set(newKey, prevEntry); }
          return m;
        });
      }

      const detail = await api.builder.artifacts.get(art.type, artName);
      let meta: Record<string, unknown> = {
        ...art.meta,
        name: artName,
        displayName: ensured.displayName ?? art.meta.displayName ?? art.name,
      };
      try {
        const mf = detail.files?.[`${art.type}.json`] ?? detail.files?.['agent.json'] ?? detail.files?.['team.json'] ?? detail.files?.['skill.json'];
        if (mf) meta = { ...JSON.parse(mf), ...meta, name: artName, displayName: meta.displayName };
      } catch { /* keep meta from list */ }
      const name = (meta.displayName as string) || (meta.name as string) || artName;
      const description = (meta.description as string) || '';
      const category = (meta.category as string) || 'general';
      const tags = Array.isArray(meta.tags) ? (meta.tags as string[]) : [];
      let icon: string | undefined = (meta.icon as string) || undefined;
      const version = (meta.version as string) || '1.0.0';

      // If icon is a local image path, upload it to Hub
      if (icon && !icon.startsWith('http') && /\.(png|jpe?g|gif|webp|svg)$/i.test(icon)) {
        const iconFilename = icon.split('/').pop() ?? icon;
        try {
          const iconResp = await fetch(`/api/builder/artifacts/${art.type}s/${encodeURIComponent(artName)}/images/${encodeURIComponent(iconFilename)}`);
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
      const screenshots = Array.isArray(meta.screenshots) ? (meta.screenshots as string[]) : [];
      for (let i = 0; i < screenshots.length; i++) {
        const imgPath = screenshots[i]!;
        const filename = imgPath.split('/').pop() ?? imgPath;
        try {
          const imgResp = await fetch(`/api/builder/artifacts/${art.type}s/${encodeURIComponent(artName)}/images/${encodeURIComponent(filename)}`);
          if (imgResp.ok) {
            const blob = await imgResp.blob();
            const file = new File([blob], filename, { type: blob.type });
            const uploaded = await hubApi.uploadImage(file);
            if (uploaded?.url) {
              hubImages.push({ url: uploaded.url, alt: filename, order: i });
              if (i === 0 || (meta.thumbnail as string) === imgPath) thumbnailUrl = uploaded.url;
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
        config: { ...meta, name: artName, displayName: name },
        files: detail.files && Object.keys(detail.files).length > 0 ? detail.files : undefined,
        thumbnailUrl,
        images: hubImages.length > 0 ? hubImages : undefined,
        priceCents: opts?.priceCents,
        donationsEnabled: opts?.donationsEnabled,
        visibility: opts?.visibility,
        orgId: opts?.orgId,
      });
      if (result.id) {
        setSharedMap(prev => { const m = new Map(prev); m.set(newKey, { id: result.id!, name, slug: result.slug ?? slug, version, visibility: result.visibility ?? opts?.visibility ?? 'public', moderationStatus: result.moderationStatus, pendingReview: result.pendingReview }); saveSharedMapToStorage(m); return m; });
        const vis = result.visibility ?? opts?.visibility ?? 'public';
        if (vis !== 'org' && (result.moderationStatus === 'pending' || result.pendingReview)) {
          setNotice({
            title: t('common:share'),
            message: ensured.converted
              ? t('share.convertedAndSubmitted', { previous: art.name, slug })
              : (result.updated ? t('share.updateSubmitted') : t('share.submittedForReview')),
            variant: 'primary',
          });
        } else if (ensured.converted) {
          setNotice({
            title: t('common:share'),
            message: t('share.convertedSlug', { previous: art.name, slug }),
            variant: 'primary',
          });
        }
      }
    } catch (err) {
      console.error('Share failed:', err);
      setNotice({
        title: t('common:share'),
        message: t('shareFailed', { error: err instanceof Error ? err.message : String(err) }),
        variant: 'danger',
      });
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
      setSharedMap(prev => { const m = new Map(prev); m.delete(key); saveSharedMapToStorage(m); return m; });
    } catch (err) {
      console.error('Hub delete failed:', err);
      setNotice({ title: t('unshare'), message: t('hubDeleteFailed', { error: String(err) }), variant: 'danger' });
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

  // Load orgs when switching to org assets tab
  useEffect(() => {
    if (activeTab !== 'orgAssets' || orgs.length > 0) return;
    hubApi.myOrgs().then(d => {
      setOrgs(d.memberships);
      if (d.memberships.length > 0 && !selectedOrgId) setSelectedOrgId(d.memberships[0]!.id);
    }).catch(() => {});
  }, [activeTab, orgs.length, selectedOrgId]);

  // Load items for selected org
  useEffect(() => {
    if (activeTab !== 'orgAssets' || !selectedOrgId) return;
    setOrgItemsLoading(true);
    hubApi.browseItems({ orgId: selectedOrgId, limit: 100 })
      .then(d => setOrgItems(d.items ?? []))
      .catch(() => setOrgItems([]))
      .finally(() => setOrgItemsLoading(false));
  }, [activeTab, selectedOrgId]);

  const filteredOrgItems = orgFilterType === 'all' ? orgItems : orgItems.filter(i => i.itemType === orgFilterType);

  const navigateToDetail = (art: BuilderArtifact) => {
    history.pushState(null, '', hashPath(PAGE.BUILDER, `${art.type}/${encodeURIComponent(art.name)}`));
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  };

  if (subRoute) {
    return (
      <ArtifactDetail
        type={subRoute.type}
        name={subRoute.name}
        authUser={authUser}
        onBack={() => {
          history.pushState(null, '', hashPath(PAGE.BUILDER));
          window.dispatchEvent(new HashChangeEvent('hashchange'));
        }}
      />
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className={`max-w-5xl mx-auto w-full ${isMobile ? 'px-4 py-5' : 'px-6 py-6'}`}>
        {/* Header + quick-create prompts */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-xl font-bold text-fg-primary">{t('title')}</h1>
              <p className="text-xs text-fg-tertiary mt-1">{t('subtitle')}</p>
            </div>
            <button
              onClick={loadAll}
              className="text-xs text-fg-tertiary hover:text-fg-secondary transition-colors px-3 py-1.5 rounded-lg border border-border-default hover:border-gray-600"
            >
              {t('common:refresh')}
            </button>
          </div>

          <div className={`grid ${isMobile ? 'grid-cols-1 gap-2' : 'grid-cols-3 gap-3'}`}>
            {BUILDER_PROMPTS.map(b => {
              const promptPrefix = t(`prompts.${b.id}Prompt`);
              const examplesRaw = t(`prompts.${b.id}Examples`, { returnObjects: true });
              const examples = Array.isArray(examplesRaw) ? examplesRaw : [];
              return (
              <button
                key={b.id}
                onClick={() => navigateToSecretary(promptPrefix)}
                className={`group text-left w-full rounded-xl border ${b.borderColor} bg-surface-secondary/60 p-4 transition-all hover:bg-surface-secondary/80 hover:shadow-lg`}
              >
                <div className="flex items-start gap-3">
                  <div className={`w-10 h-10 text-xl rounded-lg ${b.bgColor} flex items-center justify-center shrink-0`}>
                    {b.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className={`text-sm font-semibold bg-gradient-to-r ${b.color} bg-clip-text text-transparent`}>
                      {t(`prompts.${b.id}`)}
                    </h3>
                    <p className="text-[11px] text-fg-tertiary mt-1 leading-relaxed">{t(`prompts.${b.id}Desc`)}</p>
                    {examples.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {examples.slice(0, 2).map((ex, i) => (
                          <span key={i} className="text-[10px] text-fg-muted bg-surface-elevated/60 rounded-full px-2 py-0.5 border border-border-default"
                            onClick={(e) => { e.stopPropagation(); navigateToSecretary(promptPrefix + ex); }}>
                            &ldquo;{ex}&rdquo;
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </button>
              );
            })}
          </div>
        </div>

        {/* Artifact management section */}
        <div className="mb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button onClick={() => setActiveTab('creations')}
                className={`text-sm font-semibold transition-colors ${activeTab === 'creations' ? 'text-fg-primary' : 'text-fg-tertiary hover:text-fg-secondary'}`}>
                {t('myCreations.title')}
              </button>
              <button onClick={() => setActiveTab('orgAssets')}
                className={`text-sm font-semibold transition-colors ${activeTab === 'orgAssets' ? 'text-fg-primary' : 'text-fg-tertiary hover:text-fg-secondary'}`}>
                {t('orgAssets.title')}
              </button>
            </div>
            {activeTab === 'creations' && (
              <div className="flex gap-1.5">
                {(['all', 'agent', 'team', 'skill'] as const).map(ft => (
                  <button
                    key={ft}
                    onClick={() => setFilterType(ft)}
                    className={`text-xs px-2.5 py-1 rounded-lg transition-colors ${
                      filterType === ft
                        ? 'bg-brand-600 text-white'
                        : 'text-fg-tertiary hover:text-fg-secondary hover:bg-surface-elevated'
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
            )}
            {activeTab === 'orgAssets' && (
              <div className="flex gap-1.5">
                {(['all', 'agent', 'team', 'skill'] as const).map(ft => (
                  <button
                    key={ft}
                    onClick={() => setOrgFilterType(ft)}
                    className={`text-xs px-2.5 py-1 rounded-lg transition-colors ${
                      orgFilterType === ft
                        ? 'bg-brand-600 text-white'
                        : 'text-fg-tertiary hover:text-fg-secondary hover:bg-surface-elevated'
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
            )}
          </div>
        </div>

        {/* Org filter bar */}
        {activeTab === 'orgAssets' && orgs.length > 0 && (
          <div className="flex gap-2 mb-3 overflow-x-auto pb-1">
            {orgs.map(org => (
              <button key={org.id} onClick={() => setSelectedOrgId(org.id)}
                className={`text-xs px-3 py-1.5 rounded-full whitespace-nowrap border transition-colors ${
                  selectedOrgId === org.id
                    ? 'bg-blue-500/15 border-blue-500/40 text-blue-400'
                    : 'border-border-default text-fg-tertiary hover:text-fg-secondary hover:border-gray-600'
                }`}>
                {org.name}
              </button>
            ))}
          </div>
        )}

        {/* Org assets content */}
        {activeTab === 'orgAssets' && (
          orgs.length === 0 && !orgItemsLoading ? (
            <div className="text-center py-12">
              <div className="text-fg-tertiary text-sm">{t('orgAssets.noOrgs')}</div>
            </div>
          ) : orgItemsLoading ? (
            <div className="text-center text-fg-tertiary py-12 text-sm">{t('orgAssets.loading')}</div>
          ) : filteredOrgItems.length === 0 ? (
            <div className="text-center py-12">
              <div className="text-fg-tertiary text-sm">{t('orgAssets.noItems')}</div>
            </div>
          ) : (
            <Masonry>
              {filteredOrgItems.map(item => {
                const hubLink = item.author?.username && item.slug
                  ? `${hubApi.getUrl()}/@${encodeURIComponent(item.author.username)}/${encodeURIComponent(item.slug)}`
                  : null;
                return (
                  <AssetCard
                    key={item.id}
                    type={item.itemType}
                    name={item.name}
                    description={item.description}
                    seed={item.slug || item.id || item.name}
                    icon={item.icon}
                    cover={item.thumbnailUrl}
                    hubBase={hubApi.getUrl()}
                    author={item.author}
                    version={item.version}
                    rating={parseFloat(item.avgRating) || 0}
                    ratingCount={item.ratingCount}
                    downloadCount={item.downloadCount}
                    actions={hubLink ? (
                      <a href={hubLink} target="_blank" rel="noopener noreferrer"
                        onClick={e => { e.stopPropagation(); if (isElectron()) { e.preventDefault(); openExternal(hubLink); } }}
                        className="text-xs px-3 py-1.5 rounded-lg border border-border-default text-fg-secondary hover:text-fg-primary hover:border-gray-600 transition-colors inline-flex items-center gap-1">
                        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                        Hub
                      </a>
                    ) : undefined}
                  />
                );
              })}
            </Masonry>
          )
        )}

        {/* My creations content */}
        {activeTab === 'creations' && (loading && artifacts.length === 0 ? (
          <div className="text-center text-fg-tertiary py-12 text-sm">{t('myCreations.loadingArtifacts')}</div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-fg-tertiary text-sm">{t('myCreations.noArtifacts')}</div>
            <div className="text-fg-muted text-xs mt-1">{t('myCreations.noArtifactsHint')}</div>
          </div>
        ) : (
          <Masonry>
            {filtered.map(art => {
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
                return `${hubApi.getUrl()}/@${encodeURIComponent(hubUser.username)}/${encodeURIComponent(hubItem.slug)}`;
              };

              // While moderation is pending/rejected (or an update is in review), only
              // show the status chip — hide Hub link + Unshare to keep the footer tidy.
              const hubNotApproved = isShared && (
                hubItem?.moderationStatus === 'pending'
                || hubItem?.moderationStatus === 'rejected'
                || !!hubItem?.pendingReview
              );

              const actionButtons = (
                <div className="flex items-center gap-1.5 justify-end" onClick={e => e.stopPropagation()}>
                  {installedMap.has(key) ? (
                    <button onClick={() => setUninstallTarget(art)} disabled={!!busyAction}
                      className="text-xs px-3 py-1.5 rounded-lg border border-green-600/30 text-green-600 hover:bg-red-500/10 hover:text-red-500 hover:border-red-500/30 transition-colors disabled:opacity-50 inline-flex items-center gap-1">
                      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                      {busyAction === 'uninstall' ? t('common:uninstalling') : t('common:uninstall')}
                    </button>
                  ) : (
                    <button onClick={() => setInstallTarget(art)} disabled={!!busyAction}
                      className="text-xs px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors disabled:opacity-50 inline-flex items-center gap-1">
                      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                      {busyAction === 'install' ? t('common:installing') : t('common:install')}
                    </button>
                  )}
                  {isShared && hubNotApproved ? (
                    hubItem?.moderationStatus === 'pending' ? (
                      <span className="text-xs px-2 py-1.5 rounded-lg border border-amber-500/30 text-amber-400 inline-flex items-center gap-1" title={t('share.underReviewTip')}>
                        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                        {t('share.underReview')}
                      </span>
                    ) : hubItem?.moderationStatus === 'rejected' ? (
                      <span className="text-xs px-2 py-1.5 rounded-lg border border-red-500/30 text-red-400 inline-flex items-center gap-1" title={t('share.rejectedTip')}>
                        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                        {t('share.rejected')}
                      </span>
                    ) : (
                      <span className="text-xs px-2 py-1.5 rounded-lg border border-amber-500/30 text-amber-400 inline-flex items-center gap-1" title={t('share.updateUnderReviewTip')}>
                        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                        {t('share.updateUnderReview')}
                      </span>
                    )
                  ) : isShared ? (
                    <>
                      {hasNewVersion && (
                        <button onClick={() => {
                          const existingVis = hubItem?.visibility ?? 'public';
                          void handleShare(art, { visibility: existingVis });
                        }} disabled={!!busyAction}
                          className="text-xs px-3 py-1.5 rounded-lg border border-amber-500/30 text-amber-400 hover:bg-amber-500/10 hover:border-amber-500/50 transition-colors disabled:opacity-50 inline-flex items-center gap-1">
                          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                          {busyAction === 'share' ? t('common:sharing') : t('share.updateVersion', { version: localVersion })}
                        </button>
                      )}
                      <a href={getHubLink() ?? '#'} target="_blank" rel="noopener noreferrer"
                        onClick={e => { const l = getHubLink(); if (isElectron() && l) { e.preventDefault(); openExternal(l); } }}
                        className={`text-xs px-3 py-1.5 rounded-lg border transition-colors inline-flex items-center gap-1 ${
                          hubItem?.visibility === 'org' ? 'border-blue-500/30 text-blue-500 hover:text-blue-400 hover:border-blue-400/40'
                          : hubItem?.visibility === 'unlisted' ? 'border-gray-500/30 text-fg-tertiary hover:text-fg-secondary hover:border-gray-400/40'
                          : 'border-green-600/30 text-green-600 hover:text-green-500 hover:border-green-500/40'
                        }`}>
                        {hubItem?.visibility === 'org' ? (
                          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 21h18"/><path d="M9 8h1"/><path d="M9 12h1"/><path d="M9 16h1"/><path d="M14 8h1"/><path d="M14 12h1"/><path d="M14 16h1"/><path d="M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16"/></svg>
                        ) : hubItem?.visibility === 'unlisted' ? (
                          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                        ) : (
                          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                        )}
                        {hubItem?.visibility === 'org' ? t('visibility.sharedOrg') : hubItem?.visibility === 'unlisted' ? t('visibility.sharedUnlisted') : t('visibility.shared')}
                      </a>
                      <button onClick={() => setHubDeleteTarget({ key, name: displayName })} disabled={!!busyAction}
                        className="text-xs px-2.5 py-1.5 rounded-lg border border-border-default text-fg-secondary hover:text-amber-500 hover:border-amber-500/40 hover:bg-amber-500/10 transition-colors disabled:opacity-50 inline-flex items-center gap-1"
                        title={t('removeFromHubTooltip')}>
                        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M18.84 12.25l1.72-1.71a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M5.17 11.75l-1.71 1.71a5 5 0 0 0 7.07 7.07l1.71-1.71"/><line x1="2" y1="2" x2="22" y2="22"/></svg>
                        {t('unshare')}
                      </button>
                    </>
                  ) : (
                    <button onClick={async () => {
                      await hubApi.ensureAuth();
                      const hasImages = Array.isArray(art.meta.screenshots) && art.meta.screenshots.length > 0;
                      if (!hasImages) { setSharePrompt(art); }
                      else { setVisibilityTarget(art); }
                    }} disabled={!!busyAction}
                      className="text-xs px-3 py-1.5 rounded-lg border border-border-default text-fg-secondary hover:text-green-600 hover:border-green-500/30 transition-colors disabled:opacity-50 inline-flex items-center gap-1">
                      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                      {busyAction === 'share' ? t('common:sharing') : t('common:share')}
                    </button>
                  )}
                </div>
              );

              const deleteButton = (
                <button
                  onClick={() => setDeleteTarget(art)}
                  disabled={!!busyAction}
                  className="w-7 h-7 rounded-lg text-fg-muted hover:text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50 inline-flex items-center justify-center"
                  title={t('deleteLocalTooltip')}
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                </button>
              );

              const artIcon = art.meta.icon as string | undefined;
              const isImgIcon = !!artIcon && /\.(png|jpe?g|gif|webp|svg)$/i.test(artIcon);
              const iconSrc = isImgIcon
                ? (artIcon!.startsWith('http') || artIcon!.startsWith('/'))
                  ? artIcon!
                  : `/api/builder/artifacts/${art.type}s/${encodeURIComponent(art.name)}/images/${encodeURIComponent(artIcon!.split('/').pop() ?? '')}`
                : artIcon;

              return (
                <AssetCard
                  key={key}
                  type={art.type}
                  name={displayName}
                  description={description}
                  seed={key}
                  icon={iconSrc}
                  version={localVersion}
                  footerLeft={
                    <span className="flex items-center gap-2 text-[10px] text-fg-tertiary min-w-0">
                      <button
                        onClick={(e) => { e.stopPropagation(); api.system.openPath(art.path).catch(() => {}); }}
                        className="hover:text-fg-secondary transition-colors truncate min-w-0"
                        title={art.path}
                      >{shortenPath(art.path)}</button>
                      <span className="shrink-0">·</span>
                      <span className="shrink-0">{new Date(art.updatedAt).toLocaleDateString()}</span>
                    </span>
                  }
                  headerAction={deleteButton}
                  actions={actionButtons}
                  onClick={() => navigateToDetail(art)}
                />
              );
            })}
          </Masonry>
        ))}

        {installTarget && (
          <ConfirmModal
            variant="primary"
            title={t('confirmInstall')}
            message={t('confirmInstallMsg', { name: (installTarget.meta.displayName as string) || (installTarget.meta.name as string) || installTarget.name })}
            confirmLabel={t('common:install')}
            onConfirm={() => {
              const art = installTarget;
              setInstallTarget(null);
              void handleInstall(art);
            }}
            onCancel={() => setInstallTarget(null)}
          />
        )}
        {uninstallTarget && (
          <ConfirmModal
            variant="primary"
            title={t('confirmUninstall')}
            message={t('confirmUninstallMsg', { name: (uninstallTarget.meta.displayName as string) || (uninstallTarget.meta.name as string) || uninstallTarget.name })}
            confirmLabel={t('common:uninstall')}
            onConfirm={() => {
              const art = uninstallTarget;
              setUninstallTarget(null);
              void handleUninstall(art);
            }}
            onCancel={() => setUninstallTarget(null)}
          />
        )}
        {deleteTarget && (
          <ConfirmModal
            title={t('confirmDeleteLocal')}
            message={t('deleteCannotUndo', { name: (deleteTarget.meta.displayName as string) || (deleteTarget.meta.name as string) || deleteTarget.name })}
            confirmLabel={t('common:delete')}
            onConfirm={confirmDelete}
            onCancel={() => setDeleteTarget(null)}
          />
        )}
        {hubDeleteTarget && (
          <ConfirmModal
            title={t('confirmUnshare')}
            message={t('removeFromHub', { name: hubDeleteTarget.name })}
            confirmLabel={t('unshare')}
            onConfirm={() => void confirmHubDelete()}
            onCancel={() => setHubDeleteTarget(null)}
          />
        )}
        {notice && (
          <ConfirmModal
            alertOnly
            variant={notice.variant ?? 'primary'}
            title={notice.title}
            message={notice.message}
            onConfirm={() => setNotice(null)}
            onCancel={() => setNotice(null)}
          />
        )}
        {sharePrompt && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setSharePrompt(null)}>
            <div className="bg-surface-secondary border border-border-default rounded-xl max-w-sm w-full mx-4 p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
              <h3 className="text-base font-semibold text-fg-primary mb-2">{t('common:share')}</h3>
              <p className="text-sm text-fg-secondary mb-5">{t('share.imagePrompt')}</p>
              <div className="flex gap-3">
                <button
                  onClick={() => { const art = sharePrompt; setSharePrompt(null); setVisibilityTarget(art); }}
                  className="flex-1 text-sm px-4 py-2 rounded-lg border border-border-default text-fg-secondary hover:text-fg-primary hover:border-fg-tertiary transition-colors">
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
            <div className="bg-surface-secondary border border-border-default rounded-xl max-w-sm w-full mx-4 p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
              <ShareModeSelect
                isUpdate={sharedMap.has(`${shareModeTarget.type}/${shareModeTarget.name}`)}
                onCancel={() => setShareModeTarget(null)}
                onConfirm={(_mode, priceCents) => {
                  const art = shareModeTarget;
                  setShareModeTarget(null);
                  void handleShare(art, {
                    priceCents: priceCents > 0 ? priceCents : undefined,
                  });
                }}
              />
            </div>
          </div>
        )}
        {visibilityTarget && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setVisibilityTarget(null)}>
            <div className="bg-surface-secondary border border-border-default rounded-xl max-w-sm w-full mx-4 p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
              <VisibilitySelect
                onCancel={() => setVisibilityTarget(null)}
                onConfirm={(visibility, orgId, priceCents, donationsEnabled) => {
                  const art = visibilityTarget;
                  setVisibilityTarget(null);
                  void handleShare(art, { visibility, orgId, priceCents, donationsEnabled });
                }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function VisibilitySelect({ onCancel, onConfirm }: {
  onCancel: () => void;
  onConfirm: (visibility: HubVisibility, orgId?: string, priceCents?: number, donationsEnabled?: boolean) => void;
}) {
  const { t } = useTranslation(['builder', 'common']);
  const [selected, setSelected] = useState<HubVisibility>('public');
  const [orgs, setOrgs] = useState<HubOrg[]>([]);
  const [selectedOrgId, setSelectedOrgId] = useState<string>('');
  const [loadingOrgs, setLoadingOrgs] = useState(false);
  const [priceCents, setPriceCents] = useState(0);
  const [donationsEnabled, setDonationsEnabled] = useState(false);

  useEffect(() => {
    if (selected === 'org' && orgs.length === 0) {
      setLoadingOrgs(true);
      hubApi.myOrgs().then(d => {
        setOrgs(d.memberships);
        if (d.memberships.length > 0) setSelectedOrgId(d.memberships[0]!.id);
      }).catch(() => {}).finally(() => setLoadingOrgs(false));
    }
  }, [selected, orgs.length]);

  // Public / unlisted items go through moderation before others can see them.
  const isPublicLike = selected === 'public' || selected === 'unlisted';

  const options: Array<{ value: HubVisibility; icon: ReactNode; label: string; desc: string }> = [
    {
      value: 'public',
      icon: <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>,
      label: t('visibility.public'),
      desc: t('visibility.publicDesc'),
    },
    {
      value: 'org',
      icon: <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 21h18"/><path d="M9 8h1"/><path d="M9 12h1"/><path d="M9 16h1"/><path d="M14 8h1"/><path d="M14 12h1"/><path d="M14 16h1"/><path d="M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16"/></svg>,
      label: t('visibility.org'),
      desc: t('visibility.orgDesc'),
    },
    {
      value: 'unlisted',
      icon: <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>,
      label: t('visibility.unlisted'),
      desc: t('visibility.unlistedDesc'),
    },
  ];

  return (
    <>
      <h3 className="text-base font-semibold text-fg-primary mb-4">{t('visibility.label')}</h3>
      <div className="space-y-2 mb-5">
        {options.map(opt => (
          <label key={opt.value} className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${selected === opt.value ? 'border-brand-500 bg-brand-500/10' : 'border-border-default hover:border-gray-600'}`}>
            <input type="radio" name="visibility" checked={selected === opt.value} onChange={() => setSelected(opt.value)} className="accent-brand-500" />
            <div className="flex items-center gap-2 text-fg-secondary">{opt.icon}</div>
            <div>
              <div className="text-sm font-medium text-fg-primary">{opt.label}</div>
              <div className="text-[11px] text-fg-tertiary">{opt.desc}</div>
            </div>
          </label>
        ))}
      </div>
      {selected === 'org' && (
        <div className="mb-5">
          <label className="text-xs text-fg-secondary block mb-1.5">{t('visibility.orgSelect')}</label>
          {loadingOrgs ? (
            <div className="text-xs text-fg-tertiary py-2">Loading...</div>
          ) : orgs.length === 0 ? (
            <div className="text-xs text-fg-tertiary py-2">{t('visibility.orgNone')}</div>
          ) : (
            <select value={selectedOrgId} onChange={e => setSelectedOrgId(e.target.value)}
              className="w-full text-sm px-3 py-2 rounded-lg bg-surface-elevated border border-border-default text-fg-primary">
              {orgs.map(org => <option key={org.id} value={org.id}>{org.name}</option>)}
            </select>
          )}
        </div>
      )}
      {isPublicLike && (
        <div className="mb-5">
          <label className="text-xs text-fg-secondary block mb-1.5">{t('pricing.label')}</label>
          <div className="grid grid-cols-4 gap-2 mb-3">
            {PRICE_OPTIONS.map(opt => (
              <button key={opt.cents} type="button"
                onClick={() => setPriceCents(opt.cents)}
                className={`text-sm px-2 py-2 rounded-lg border transition-colors ${priceCents === opt.cents ? 'border-brand-500 bg-brand-500/10 text-fg-primary' : 'border-border-default text-fg-secondary hover:border-gray-600'}`}>
                {opt.label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={donationsEnabled} onChange={e => setDonationsEnabled(e.target.checked)} className="accent-brand-500" />
            <span className="text-xs text-fg-secondary">{t('pricing.enableTips')}</span>
          </label>
        </div>
      )}
      {isPublicLike && (
        <div className="mb-4 text-[11px] text-fg-tertiary rounded-lg border border-border-default px-3 py-2">
          {t('pricing.reviewNote')}
        </div>
      )}
      <div className="flex gap-3">
        <button onClick={onCancel} className="flex-1 text-sm px-4 py-2 rounded-lg border border-border-default text-fg-secondary hover:text-fg-primary hover:border-gray-600 transition-colors">
          {t('common:cancel')}
        </button>
        <button onClick={() => onConfirm(selected, selected === 'org' ? selectedOrgId : undefined, isPublicLike && priceCents > 0 ? priceCents : undefined, isPublicLike ? donationsEnabled : undefined)}
          disabled={selected === 'org' && !selectedOrgId}
          className="flex-1 text-sm px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
          {t('shareMode.share')}
        </button>
      </div>
    </>
  );
}

const PRICE_OPTIONS = [
  { cents: 0, label: 'Free' },
  { cents: 100, label: '$1' },
  { cents: 500, label: '$5' },
  { cents: 1000, label: '$10' },
] as const;

function ShareModeSelect({ isUpdate, onCancel, onConfirm }: {
  isUpdate: boolean;
  onCancel: () => void;
  onConfirm: (mode: 'free' | 'paid', priceCents: number) => void;
}) {
  const { t } = useTranslation(['builder', 'common']);
  const [selectedPrice, setSelectedPrice] = useState(0);

  return (
    <>
      <h3 className="text-base font-semibold text-fg-primary mb-4">
        {isUpdate ? t('shareMode.titleUpdate') : t('shareMode.title')}
      </h3>
      <div className="space-y-2 mb-5">
        {PRICE_OPTIONS.map(opt => (
          <label key={opt.cents} className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${selectedPrice === opt.cents ? 'border-brand-500 bg-brand-500/10' : 'border-border-default hover:border-gray-600'}`}>
            <input type="radio" name="sharePrice" checked={selectedPrice === opt.cents} onChange={() => setSelectedPrice(opt.cents)} className="accent-brand-500" />
            <div>
              <div className="text-sm font-medium text-fg-primary">{opt.label}</div>
              <div className="text-[11px] text-fg-tertiary">
                {opt.cents === 0 ? t('shareMode.freeDesc') : t('shareMode.paidDesc')}
              </div>
            </div>
          </label>
        ))}
      </div>
      <div className="flex gap-3">
        <button onClick={onCancel} className="flex-1 text-sm px-4 py-2 rounded-lg border border-border-default text-fg-secondary hover:text-fg-primary hover:border-gray-600 transition-colors">
          {t('common:cancel')}
        </button>
        <button onClick={() => onConfirm(selectedPrice > 0 ? 'paid' : 'free', selectedPrice)}
          className="flex-1 text-sm px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors">
          {isUpdate ? t('shareMode.update') : t('shareMode.share')}
        </button>
      </div>
    </>
  );
}
