import { useState, useEffect, useCallback } from 'react';
import { api, hubApi, type AgentInfo } from '../api.ts';
import { navBus } from '../navBus.ts';
import { PAGE } from '../routes.ts';
import { consume, PREFETCH_KEYS } from '../prefetchCache.ts';
import { useIsMobile } from '../hooks/useIsMobile.ts';

function shortenPath(p: string): string {
  const home = '~/.markus/builder-artifacts/';
  const idx = p.indexOf('.markus/builder-artifacts/');
  return idx >= 0 ? '~/' + p.slice(idx) : p;
}

const BUILDER_PROMPTS = [
  {
    icon: '✦',
    color: 'from-brand-500 to-purple-600',
    borderColor: 'border-brand-500/30 hover:border-brand-400/50',
    bgColor: 'bg-brand-500/10',
    title: 'Hire an Agent',
    desc: 'Hire from templates, create custom agents, or find specialists on Markus Hub',
    examples: [
      'Hire a senior React developer',
      'Create a custom code reviewer',
      'Find a DevOps specialist on Hub',
    ],
    prompt: 'I need to hire an agent: ',
  },
  {
    icon: '◈',
    color: 'from-blue-500 to-blue-600',
    borderColor: 'border-blue-500/30 hover:border-blue-400/50',
    bgColor: 'bg-blue-500/10',
    title: 'Build a Team',
    desc: 'Compose an optimal team for your project or deploy a team template',
    examples: [
      'A web dev team with PM, devs, and QA',
      'A data engineering squad',
      'A content creation team',
    ],
    prompt: 'I need to build a team for: ',
  },
  {
    icon: '⬡',
    color: 'from-green-500 to-green-600',
    borderColor: 'border-green-500/30 hover:border-green-400/50',
    bgColor: 'bg-green-500/10',
    title: 'Create a Skill',
    desc: 'Design new capabilities that agents can learn and use',
    examples: [
      'A Git changelog generator',
      'A web scraping skill',
      'A database migration tool',
    ],
    prompt: 'I need a skill that: ',
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

function ConfirmDialog({ message, onConfirm, onCancel }: { message: string; onConfirm: () => void; onCancel: () => void }) {
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
            <div className="text-sm font-medium text-fg-primary">Confirm Delete</div>
            <div className="text-xs text-fg-secondary mt-0.5">{message}</div>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-4 py-1.5 text-xs text-fg-secondary hover:text-fg-primary border border-border-default hover:border-gray-600 rounded-lg transition-colors">Cancel</button>
          <button onClick={onConfirm} className="px-4 py-1.5 text-xs bg-red-600 hover:bg-red-500 text-white rounded-lg transition-colors">Delete</button>
        </div>
      </div>
    </div>
  );
}

export function AgentBuilder() {
  const isMobile = useIsMobile();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [artifacts, setArtifacts] = useState<BuilderArtifact[]>([]);
  const [loading, setLoading] = useState(false);
  const [filterType, setFilterType] = useState<string>('all');
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [installedMap, setInstalledMap] = useState<Map<string, InstalledInfo>>(new Map());
  const [deleteTarget, setDeleteTarget] = useState<BuilderArtifact | null>(null);
  const [sharedMap, setSharedMap] = useState<Map<string, { id: string; name: string; slug: string }>>(new Map());
  const [hubDeleteTarget, setHubDeleteTarget] = useState<{ key: string; name: string } | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const loadAll = useCallback(() => {
    setLoading(true);
    Promise.all([
      (consume<{ artifacts: BuilderArtifact[] }>(PREFETCH_KEYS.builderArtifacts) ?? api.builder.artifacts.list()).then(d => d?.artifacts ?? []).catch(() => [] as BuilderArtifact[]),
      (consume<{ agents: AgentInfo[] }>(PREFETCH_KEYS.builderAgents) ?? api.agents.list()).then(d => d?.agents ?? []).catch(() => [] as AgentInfo[]),
      (consume<{ items: Array<{ id: string; itemType: string; name: string; slug: string }> }>(PREFETCH_KEYS.builderHubMyItems) ?? hubApi.myItems()).then(d => d?.items ?? []).catch(() => [] as Array<{ id: string; itemType: string; name: string; slug: string }>),
      (consume<{ installed: Record<string, { agentId?: string; agentIds?: string[]; teamId?: string }> }>(PREFETCH_KEYS.builderInstalled) ?? api.builder.artifacts.installed()).then(d => d?.installed ?? {}).catch(() => ({} as Record<string, { agentId?: string; agentIds?: string[]; teamId?: string }>)),
    ]).then(([arts, agentList, hubItems, installedData]) => {
      setArtifacts(arts);
      setAgents(agentList);

      // Populate shared status from Hub published items (key → { id, name, slug })
      if (hubItems.length > 0) {
        const shared = new Map<string, { id: string; name: string; slug: string }>();
        for (const hi of hubItems) {
          const typeDir = hi.itemType === 'agent' ? 'agent' : hi.itemType === 'team' ? 'team' : 'skill';
          for (const art of arts) {
            if (art.type === typeDir && (hi.slug === art.name || hi.name === ((art.meta.displayName as string) || (art.meta.name as string) || art.name))) {
              shared.set(`${art.type}/${art.name}`, { id: hi.id, name: hi.name, slug: hi.slug || art.name });
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
    setActionInProgress(key);
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
      alert(`Install failed: ${err}`);
    } finally {
      setActionInProgress(null);
    }
  };

  const handleUninstall = async (art: BuilderArtifact) => {
    const key = `${art.type}/${art.name}`;
    if (!installedMap.has(key)) return;
    setActionInProgress(key);
    try {
      await api.builder.artifacts.uninstall(art.type, art.name);
      setInstalledMap(prev => { const m = new Map(prev); m.delete(key); return m; });
      window.dispatchEvent(new CustomEvent('markus:data-changed'));
    } catch (err) {
      console.error('Uninstall failed:', err);
      alert(`Uninstall failed: ${err}`);
    } finally {
      setActionInProgress(null);
    }
  };

  const handleShare = async (art: BuilderArtifact) => {
    const key = `${art.type}/${art.name}`;
    if (sharedMap.has(key)) return;
    setActionInProgress(key);
    try {
      const detail = await api.builder.artifacts.get(art.type, art.name);
      const name = (art.meta.displayName as string) || (art.meta.name as string) || art.name;
      const description = (art.meta.description as string) || '';
      const category = (art.meta.category as string) || 'general';
      const tags = Array.isArray(art.meta.tags) ? (art.meta.tags as string[]) : [];
      const slug = art.name;
      const result = await hubApi.publishViaProxy({
        itemType: art.type === 'team' ? 'team' : art.type === 'skill' ? 'skill' : 'agent',
        name,
        slug,
        description,
        category,
        tags,
        config: art.meta,
        files: detail.files && Object.keys(detail.files).length > 0 ? detail.files : undefined,
      });
      if (result.id) setSharedMap(prev => { const m = new Map(prev); m.set(key, { id: result.id!, name, slug: result.slug ?? slug }); return m; });
    } catch (err) {
      console.error('Share failed:', err);
      alert(`Share failed: ${err}`);
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
    setActionInProgress(key);
    try {
      await hubApi.deleteItem(hubItemId);
      setSharedMap(prev => { const m = new Map(prev); m.delete(key); return m; });
    } catch (err) {
      console.error('Hub delete failed:', err);
      alert(`Failed to remove from Hub: ${err}`);
    } finally {
      setActionInProgress(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const art = deleteTarget;
    const key = `${art.type}/${art.name}`;
    setDeleteTarget(null);
    setActionInProgress(key);
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

  return (
    <div className="flex-1 overflow-y-auto">
      <div className={`max-w-4xl ${isMobile ? 'px-4 py-5' : 'px-6 py-10'}`}>
        {/* Builder prompts → navigate to Secretary */}
        <div className="mb-10">
          <h1 className="text-2xl font-bold text-fg-primary">Builder</h1>
          <p className="text-sm text-fg-tertiary mt-2">
            Hire agents, build teams, and create skills. Your Secretary handles the entire process
            — from sourcing to onboarding.
          </p>
        </div>

        <div className="grid gap-5">
          {BUILDER_PROMPTS.map(b => (
            <button
              key={b.title}
              onClick={() => navigateToSecretary(b.prompt)}
              className={`group text-left w-full rounded-xl border ${b.borderColor} bg-surface-secondary/60 ${isMobile ? 'p-4' : 'p-6'} transition-all hover:bg-surface-secondary/80 hover:shadow-lg`}
            >
              <div className={`flex items-start ${isMobile ? 'gap-3' : 'gap-5'}`}>
                <div className={`${isMobile ? 'w-10 h-10 text-xl' : 'w-14 h-14 text-2xl'} rounded-xl ${b.bgColor} flex items-center justify-center shrink-0`}>
                  {b.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className={`${isMobile ? 'text-base' : 'text-lg'} font-semibold bg-gradient-to-r ${b.color} bg-clip-text text-transparent`}>
                      {b.title}
                    </h3>
                  </div>
                  <p className="text-sm text-fg-secondary leading-relaxed">{b.desc}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {b.examples.map((ex, i) => (
                      <span key={i} className="text-[11px] text-fg-tertiary bg-surface-elevated/60 rounded-full px-3 py-1 border border-border-default cursor-pointer hover:bg-surface-elevated/80 hover:text-fg-secondary transition-colors"
                        onClick={(e) => { e.stopPropagation(); navigateToSecretary(b.prompt + ex); }}>
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
          ))}
        </div>

        {/* Artifact management section */}
        <div className="mt-14 mb-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-fg-primary">My Creations</h2>
              <p className="text-xs text-fg-tertiary mt-1">Saved builder artifacts — install to deploy, or share to Markus Hub.</p>
            </div>
            <button
              onClick={loadAll}
              className="text-xs text-fg-tertiary hover:text-fg-secondary transition-colors px-3 py-1.5 rounded-lg border border-border-default hover:border-gray-600"
            >
              Refresh
            </button>
          </div>

          <div className="flex gap-2 mt-4">
            {['all', 'agent', 'team', 'skill'].map(t => (
              <button
                key={t}
                onClick={() => setFilterType(t)}
                className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                  filterType === t
                    ? 'border-gray-600 bg-surface-elevated text-fg-primary'
                    : 'border-border-default text-fg-tertiary hover:text-fg-secondary hover:border-gray-600'
                }`}
              >
                {t === 'all' ? 'All' : t.charAt(0).toUpperCase() + t.slice(1) + 's'}
              </button>
            ))}
          </div>
        </div>

        {loading && artifacts.length === 0 ? (
          <div className="text-center text-fg-tertiary py-12 text-sm">Loading artifacts...</div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-fg-tertiary text-sm">No artifacts found.</div>
            <div className="text-fg-muted text-xs mt-1">Use a builder above to create agents, teams, or skills.</div>
          </div>
        ) : (
          <div className="grid gap-3">
            {filtered.map(art => {
              const style = TYPE_STYLES[art.type] ?? TYPE_STYLES.agent!;
              const displayName = (art.meta.displayName as string) || (art.meta.name as string) || art.name;
              const description = (art.meta.description as string) || '';
              const key = `${art.type}/${art.name}`;
              const busy = actionInProgress === key;

              const actionButtons = (
                <div className={`flex items-center gap-1.5 ${isMobile ? 'flex-wrap' : 'shrink-0'}`}>
                  {installedMap.has(key) ? (
                    <button onClick={() => handleUninstall(art)} disabled={busy}
                      className="text-xs px-3 py-1.5 rounded-lg border border-green-600/30 text-green-600 hover:bg-red-500/10 hover:text-red-500 hover:border-red-500/30 transition-colors disabled:opacity-50">
                      {busy ? 'Uninstalling...' : 'Uninstall'}
                    </button>
                  ) : (
                    <button onClick={() => handleInstall(art)} disabled={busy}
                      className="text-xs px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors disabled:opacity-50">
                      {busy ? 'Installing...' : 'Install'}
                    </button>
                  )}
                  {sharedMap.has(key) ? (
                    <div className="flex items-center gap-1">
                      <button onClick={() => setHubDeleteTarget({ key, name: (art.meta.displayName as string) || (art.meta.name as string) || art.name })} disabled={busy}
                        className="text-xs px-3 py-1.5 rounded-lg border border-green-600/30 text-green-600 hover:text-red-500 hover:border-red-500/30 hover:bg-red-500/10 transition-colors disabled:opacity-50" title="Remove from Markus Hub">
                        Shared
                      </button>
                      <button onClick={() => {
                        const hubItem = sharedMap.get(key); const hubUser = hubApi.getUser();
                        if (!hubItem || !hubUser) return;
                        const link = `${hubApi.getUrl()}/${encodeURIComponent(hubUser.username)}/${encodeURIComponent(hubItem.slug)}`;
                        navigator.clipboard.writeText(link).then(() => { setCopiedKey(key); setTimeout(() => setCopiedKey(prev => prev === key ? null : prev), 2000); }).catch(() => {});
                      }} className="text-xs px-2 py-1.5 rounded-lg border border-green-600/20 text-green-500 hover:text-green-600 hover:border-green-500/40 transition-colors" title="Copy Hub link">
                        {copiedKey === key ? (
                          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                        ) : (
                          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>
                        )}
                      </button>
                    </div>
                  ) : (
                    <button onClick={() => handleShare(art)} disabled={busy}
                      className="text-xs px-3 py-1.5 rounded-lg border border-border-default text-fg-secondary hover:text-green-600 hover:border-green-500/30 transition-colors disabled:opacity-50">
                      {busy ? 'Sharing...' : 'Share'}
                    </button>
                  )}
                  <button onClick={() => setDeleteTarget(art)} disabled={busy}
                    className="text-xs px-2 py-1.5 rounded-lg text-fg-tertiary hover:text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50" title="Delete">
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                  </button>
                </div>
              );

              return (
                <div key={key}
                  className="group rounded-lg border border-border-default bg-surface-secondary/60 p-4 hover:border-gray-600 transition-all overflow-hidden">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className={`w-9 h-9 rounded-lg ${style.bg} flex items-center justify-center text-lg shrink-0`}>
                      {style.icon}
                    </div>
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
            message={`Delete "${(deleteTarget.meta.displayName as string) || (deleteTarget.meta.name as string) || deleteTarget.name}"? This cannot be undone.`}
            onConfirm={confirmDelete}
            onCancel={() => setDeleteTarget(null)}
          />
        )}
        {hubDeleteTarget && (
          <ConfirmDialog
            message={`Remove "${hubDeleteTarget.name}" from Markus Hub? It will no longer be available for others to download.`}
            onConfirm={() => void confirmHubDelete()}
            onCancel={() => setHubDeleteTarget(null)}
          />
        )}
      </div>
    </div>
  );
}
