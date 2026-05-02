import { useEffect, useState, useCallback, useRef } from 'react';
import { api, hubApi, type TeamTemplateInfo, type HubItem } from '../api.ts';
import { consume, PREFETCH_KEYS } from '../prefetchCache.ts';
import { installHubItem } from './TemplateMarketplace.tsx';

type FilterId = 'all' | 'hub';

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
  const [filter, setFilter] = useState<FilterId>(highlightItemId ? 'hub' : 'all');
  const [search, setSearch] = useState('');
  const [templates, setTemplates] = useState<TeamTemplateInfo[]>([]);
  const [hubItems, setHubItems] = useState<HubItem[]>([]);
  const [selected, setSelected] = useState<TeamTemplateInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [localArtifacts, setLocalArtifacts] = useState<Map<string, LocalArtifactInfo>>(new Map());

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
      if (filter === 'hub') {
        const hubPromise = !search
          ? (consume<{ items: HubItem[]; total: number }>(PREFETCH_KEYS.hubTeams) ?? hubApi.search({ type: 'team', limit: 50 }))
          : hubApi.search({ type: 'team', q: search, limit: 50 });
        const [res] = await Promise.all([
          hubPromise.catch(() => ({ items: [] as HubItem[], total: 0 })),
          loadLocalStatus(),
        ]);
        setHubItems(res?.items ?? []);
        setTemplates([]);
      } else {
        setHubItems([]);
        const res = await api.teamTemplates.list(search || undefined);
        setTemplates(res?.templates ?? []);
      }
    } catch {
      setTemplates([]);
      setHubItems([]);
    } finally {
      setLoading(false);
    }
  }, [filter, search, loadLocalStatus]);

  useEffect(() => { load(); }, [load]);

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
      setDeployResult({ ok: deployed > 0, message: `Team "${tpl.name}" deployed with ${deployed} agent(s)${errMsg}` });
    } catch (err) {
      setDeployResult({ ok: false, message: `Failed: ${err}` });
    } finally {
      setDeploying(false);
    }
  };

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      <div className="px-6 h-14 flex items-center border-b border-border-default bg-surface-secondary shrink-0">
        <h2 className="text-lg font-semibold">Team Store</h2>
      </div>

      {/* Filter Bar */}
      <div className="flex flex-wrap items-center gap-2 px-6 py-2 border-b border-border-default/50 bg-surface-secondary/50 shrink-0">
        <div className="flex gap-1">
          {([
            { id: 'all' as const, label: 'Built-in' },
            { id: 'hub' as const, label: 'Markus Hub' },
          ]).map(f => (
            <button
              key={f.id}
              onClick={() => { setFilter(f.id); setSelected(null); setDeployResult(null); }}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                filter === f.id ? 'bg-brand-600 text-white' : 'text-fg-secondary hover:text-fg-primary hover:bg-surface-elevated'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        {filter === 'all' && (
          <div className="text-xs text-fg-tertiary">
            {templates.length} team{templates.length !== 1 ? 's' : ''} available
          </div>
        )}
        <div className="flex-1 min-w-[120px]">
          <input
            type="text"
            placeholder="Search teams..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="px-3 py-1.5 bg-surface-elevated border border-border-default rounded-lg text-sm w-full focus:border-brand-500 focus:outline-none"
          />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-7">
        {loading ? (
          <div className="text-center text-fg-tertiary py-20 animate-pulse">Loading teams...</div>
        ) : filter === 'hub' ? (
          hubItems.length === 0 ? (
            <div className="text-center py-16">
              <div className="text-fg-tertiary text-3xl mb-3">🏪</div>
              <p className="text-sm text-fg-tertiary">No teams found on Markus Hub</p>
              <p className="text-xs text-fg-tertiary mt-1">Hub may be offline or empty. Check your network connection or hub URL configuration.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {hubItems.map(item => (
                <HubTeamCard key={item.id} item={item} localInfo={localArtifacts.get(toSlug(item.name))} onStatusChange={loadLocalStatus} highlight={item.id === highlightItemId} onHighlightDone={onHighlightDone} />
              ))}
            </div>
          )
        ) : templates.length === 0 ? (
          <div className="text-center py-20">
            <div className="text-4xl mb-4 opacity-30">&#9673;</div>
            <div className="text-fg-secondary font-medium mb-1">
              {search ? `No teams match "${search}"` : 'No teams available'}
            </div>
            <div className="text-fg-tertiary text-sm">
              {search ? 'Try different search terms.' : 'Go to the Builder page to create a team.'}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {templates.map(tpl => (
              <TeamTemplateCard
                key={tpl.id}
                template={tpl}
                isSelected={selected?.id === tpl.id}
                onSelect={() => setSelected(selected?.id === tpl.id ? null : tpl)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Detail Panel */}
      {selected && filter === 'all' && (
        <div className="border-t border-border-default bg-surface-secondary shrink-0 max-h-80 overflow-y-auto">
          <div className="p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div>
                  <h3 className="font-semibold text-fg-primary">{selected.name}</h3>
                  <p className="text-xs text-fg-tertiary mt-0.5">{selected.description}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleDeploy(selected)}
                  disabled={deploying}
                  className="px-5 py-2 bg-brand-600 text-white text-sm rounded-lg hover:bg-brand-500 transition-colors font-medium disabled:opacity-50"
                >
                  {deploying ? 'Deploying...' : 'Deploy Team'}
                </button>
                <button onClick={() => { setSelected(null); setDeployResult(null); }} className="text-fg-tertiary hover:text-fg-secondary text-lg px-2">&times;</button>
              </div>
            </div>

            {deployResult && (
              <div className={`mb-4 px-4 py-2.5 rounded-lg text-sm ${
                deployResult.ok ? 'bg-green-500/10 text-green-600 border border-green-500/20' : 'bg-red-500/10 text-red-500 border border-red-500/20'
              }`}>
                {deployResult.message}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div>
                <div className="text-xs text-fg-tertiary uppercase tracking-wider mb-3">Team Composition</div>
                <div className="space-y-2">
                  {selected.members.map((m, i) => (
                    <div key={i} className="flex items-center gap-3 bg-surface-elevated/50 rounded-lg p-3">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold shrink-0 ${
                        m.role === 'manager' ? 'bg-brand-500/20 text-brand-500' : 'bg-blue-500/20 text-blue-600'
                      }`}>
                        {m.role === 'manager' ? '★' : (i + 1)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-fg-primary">{m.name ?? m.roleName ?? m.templateId ?? 'Agent'}</div>
                        <div className="flex items-center gap-2 mt-0.5">
                          {(m.roleName || m.templateId) && <span className="text-[10px] text-fg-tertiary font-mono">{m.roleName ?? m.templateId}</span>}
                          <span className={`px-1.5 py-0.5 rounded text-[10px] capitalize ${
                            m.role === 'manager' ? 'bg-brand-500/15 text-brand-500' : 'bg-blue-500/15 text-blue-600'
                          }`}>
                            {m.role ?? 'worker'}
                          </span>
                          {(m.count ?? 1) > 1 && (
                            <span className="text-[10px] text-fg-tertiary">x{m.count}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-xs text-fg-tertiary uppercase tracking-wider mb-3">Details</div>
                <div className="space-y-2 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="text-fg-tertiary w-20">Version:</span>
                    <span className="text-fg-secondary font-mono text-xs">{selected.version}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-fg-tertiary w-20">Author:</span>
                    <span className="text-fg-secondary">{selected.author}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-fg-tertiary w-20">Members:</span>
                    <span className="text-fg-secondary">{selected.members.reduce((s, m) => s + (m.count ?? 1), 0)} agents</span>
                  </div>
                  {selected.tags && selected.tags.length > 0 && (
                    <div className="flex items-start gap-2">
                      <span className="text-fg-tertiary w-20 pt-0.5">Tags:</span>
                      <div className="flex flex-wrap gap-1.5">
                        {selected.tags.map(t => (
                          <span key={t} className="px-2 py-0.5 text-[10px] bg-surface-elevated text-fg-secondary rounded-full border border-border-default">{t}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function HubTeamCard({ item, localInfo, onStatusChange, highlight, onHighlightDone }: { item: HubItem; localInfo?: LocalArtifactInfo; onStatusChange: () => void; highlight?: boolean; onHighlightDone?: () => void }) {
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
      setStatus(canUpgrade ? 'Upgraded!' : 'Installed!');
      onStatusChange();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('402') || msg.includes('Purchase required')) {
        setStatus('Purchase required');
      } else {
        setStatus('Failed');
      }
    } finally {
      setInstalling(false);
    }
  };

  const iconIsEmoji = item.icon && !item.icon.startsWith('/') && !item.icon.startsWith('http');
  const iconSrc = item.icon && (item.icon.startsWith('http') ? item.icon : item.icon.startsWith('/') ? `${hubApi.getUrl()}${item.icon}` : null);
  const rating = Math.round(parseFloat(item.avgRating));

  const hubDetailUrl = item.slug && item.author?.username
    ? `${hubApi.getUrl()}/${encodeURIComponent(item.author.username)}/${encodeURIComponent(item.slug)}`
    : null;

  const handleCardClick = () => {
    if (hubDetailUrl) window.open(hubDetailUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <div ref={cardRef} onClick={handleCardClick} className={`group relative bg-surface-secondary rounded-xl overflow-hidden cursor-pointer transition-all duration-300 hover:shadow-xl hover:shadow-brand-500/5 hover:-translate-y-0.5 ${glowing ? 'ring-2 ring-brand-500 shadow-lg shadow-brand-500/20 animate-pulse' : ''}`}>
      <div className={`absolute inset-0 rounded-xl border transition-colors duration-300 ${glowing ? 'border-brand-500/60' : 'border-border-default group-hover:border-brand-500/30'}`} />
      <div className="relative p-5">
        <div className="flex items-start gap-3 mb-3">
          <div className="w-10 h-10 rounded-lg bg-surface-elevated/80 border border-border-default/50 flex items-center justify-center shrink-0 text-lg">
            {iconSrc ? <img src={iconSrc} alt="" className="w-8 h-8 rounded object-cover" /> : iconIsEmoji ? item.icon : '\u{1F465}'}
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

        {item.tags?.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-3">
            {item.tags.slice(0, 3).map(tag => (
              <span key={tag} className="px-2 py-0.5 text-[10px] bg-surface-elevated/80 text-fg-secondary rounded-md border border-border-default/50">{tag}</span>
            ))}
            {item.tags.length > 3 && <span className="px-1 text-[10px] text-fg-muted">+{item.tags.length - 3}</span>}
          </div>
        )}

        <div className="flex items-center gap-3 text-xs text-fg-tertiary mb-3">
          <span className="text-amber-500 tracking-tight">{'\u2605'.repeat(rating)}{'\u2606'.repeat(5 - rating)}</span>
          <span className="text-fg-muted">({item.ratingCount})</span>
          <span>{'\u2193'} {item.downloadCount}</span>
        </div>

        <div className="flex items-center justify-end gap-2 pt-3 border-t border-border-default/50" onClick={e => e.stopPropagation()}>
          {canUpgrade ? (
            <button onClick={e => void handleInstall(e)} disabled={installing}
              className="px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-500 text-white rounded-lg transition-colors disabled:opacity-50">
              {installing ? 'Upgrading...' : `Upgrade → v${item.version}`}
            </button>
          ) : isInstalled ? (
            <span className="px-3 py-1.5 text-xs bg-green-500/10 text-green-500 rounded-lg border border-green-500/20 inline-flex items-center gap-1">
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              Installed{localInfo?.localVersion ? ` v${localInfo.localVersion}` : ''}
            </span>
          ) : isPaid ? (
            <a href={`${hubApi.getUrl()}/${encodeURIComponent(item.author?.username ?? '')}/${encodeURIComponent(item.slug ?? item.id)}`}
              target="_blank" rel="noopener noreferrer"
              className="px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-500 text-white rounded-lg transition-colors inline-flex items-center gap-1">
              Buy {priceLabel}
            </a>
          ) : (
            <button onClick={e => void handleInstall(e)} disabled={installing}
              className="px-3 py-1.5 text-xs bg-brand-600 hover:bg-brand-500 text-white rounded-lg transition-colors disabled:opacity-50">
              {installing ? 'Installing...' : 'Install'}
            </button>
          )}
          {status && <span className={`text-[10px] ${status === 'Failed' || status === 'Purchase required' ? 'text-red-500' : 'text-green-600'}`}>{status}</span>}
        </div>
      </div>
    </div>
  );
}

function TeamTemplateCard({ template: tpl, isSelected, onSelect }: {
  template: TeamTemplateInfo;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const totalAgents = tpl.members.reduce((s, m) => s + (m.count ?? 1), 0);
  const hasManager = tpl.members.some(m => m.role === 'manager');
  const cat = tpl.category ?? 'general';

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
          <div className="font-semibold text-fg-primary truncate group-hover:text-brand-400 transition-colors">{tpl.name}</div>
          <span className="px-2 py-0.5 rounded-md text-[10px] font-medium shrink-0 bg-brand-500/15 text-brand-400 border border-brand-500/10">
            v{tpl.version}
          </span>
        </div>
        <div className="text-[11px] text-fg-tertiary mt-0.5">by {tpl.author}</div>

        <p className="text-sm text-fg-secondary mt-3 line-clamp-2 leading-relaxed">{tpl.description}</p>

        <div className="flex flex-wrap gap-1.5 mt-3">
          {tpl.members.map((m, i) => (
            <span key={i} className={`px-2 py-0.5 text-[10px] rounded-md border ${
              m.role === 'manager' ? 'bg-brand-500/10 text-brand-400 border-brand-500/15' : 'bg-blue-500/10 text-blue-400 border-blue-500/15'
            }`}>
              {m.name ?? m.roleName ?? m.templateId ?? 'Agent'}
              {(m.count ?? 1) > 1 ? ` x${m.count}` : ''}
            </span>
          ))}
        </div>

        <div className="mt-3 pt-3 border-t border-border-default/50 flex items-center gap-3 text-xs">
          <span className="text-fg-muted">{totalAgents} agent{totalAgents !== 1 ? 's' : ''}</span>
          {hasManager && <span className="text-brand-400/60">has manager</span>}
          {tpl.tags && tpl.tags.length > 0 && (
            <span className="text-fg-muted text-[10px]">{tpl.tags.slice(0, 3).join(' · ')}</span>
          )}
        </div>
      </div>
    </div>
  );
}
