import { useEffect, useState, useCallback } from 'react';
import { api, hubApi, type TeamTemplateInfo, type HubItem } from '../api.ts';
import { consume, PREFETCH_KEYS } from '../prefetchCache.ts';

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

export function TeamsStore() {
  const [filter, setFilter] = useState<FilterId>('all');
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
              <p className="text-xs text-fg-tertiary mt-1">Hub may be offline or empty. Start the hub server at port 8059.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {hubItems.map(item => (
                <HubTeamCard key={item.id} item={item} localInfo={localArtifacts.get(toSlug(item.name))} onStatusChange={loadLocalStatus} />
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

function HubTeamCard({ item, localInfo, onStatusChange }: { item: HubItem; localInfo?: LocalArtifactInfo; onStatusChange: () => void }) {
  const [installing, setInstalling] = useState(false);
  const [status, setStatus] = useState('');

  const isInstalled = localInfo?.installed ?? false;
  const canUpgrade = isInstalled && item.version && localInfo?.localVersion && isNewerVersion(item.version, localInfo.localVersion);

  const handleInstall = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (installing) return;
    setInstalling(true);
    setStatus('');
    try {
      const data = await hubApi.download(item.id);
      const name = data.name || item.name;
      const slug = toSlug(name);
      const hubSource = { type: 'hub', hubItemId: item.id };
      if (data.files && Object.keys(data.files).length > 0) {
        await api.builder.artifacts.import('team', slug, data.files, hubSource);
      } else {
        const artifact = { ...(data.config as Record<string, unknown>), name, description: item.description, source: hubSource };
        await api.builder.artifacts.save('team', artifact);
      }
      await api.builder.artifacts.install('team', slug);
      setStatus(canUpgrade ? 'Upgraded!' : 'Installed!');
      onStatusChange();
      window.dispatchEvent(new CustomEvent('markus:data-changed'));
    } catch {
      setStatus('Failed');
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="p-4 bg-surface-secondary rounded-xl border border-border-default hover:border-brand-600/50 cursor-pointer transition-all">
      <div className="flex items-center gap-2 mb-2">
        <h3 className="text-sm font-semibold truncate flex-1">{item.name}</h3>
        {item.version && <span className="text-[10px] px-1.5 py-0.5 bg-brand-500/15 text-brand-500 rounded">v{item.version}</span>}
        <span className="text-[10px] px-1.5 py-0.5 bg-green-500/15 text-green-600 rounded">Hub</span>
      </div>
      <p className="text-xs text-fg-tertiary line-clamp-2 mb-2">{item.description}</p>
      <div className="flex items-center gap-3 text-xs text-fg-tertiary">
        <span className="text-amber-600">{'\u2605'.repeat(Math.round(parseFloat(item.avgRating)))}{'\u2606'.repeat(5 - Math.round(parseFloat(item.avgRating)))}</span>
        <span>{'\u2193'} {item.downloadCount}</span>
        <span>{item.author?.displayName ?? item.author?.username}</span>
      </div>
      <div className="flex items-center gap-2 mt-3">
        {item.slug && item.author?.username && (
          <a href={`${hubApi.getUrl()}/${encodeURIComponent(item.author.username)}/${encodeURIComponent(item.slug)}`}
            target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
            className="text-[10px] text-brand-500 hover:text-brand-400 mr-auto">View on Hub →</a>
        )}
        {canUpgrade ? (
          <button
            onClick={e => void handleInstall(e)}
            disabled={installing}
            className="px-3 py-1 text-xs bg-amber-600 hover:bg-amber-500 text-white rounded-lg transition-colors disabled:opacity-50"
          >
            {installing ? 'Upgrading...' : `Upgrade → v${item.version}`}
          </button>
        ) : isInstalled ? (
          <span className="px-3 py-1 text-xs bg-surface-overlay text-fg-secondary rounded-lg">Installed{localInfo?.localVersion ? ` (v${localInfo.localVersion})` : ''}</span>
        ) : (
          <button
            onClick={e => void handleInstall(e)}
            disabled={installing}
            className="px-3 py-1 text-xs bg-brand-600 hover:bg-brand-500 text-white rounded-lg transition-colors disabled:opacity-50"
          >
            {installing ? 'Installing...' : 'Install'}
          </button>
        )}
        {status && <span className={`text-[10px] ${status === 'Failed' ? 'text-red-500' : 'text-green-600'}`}>{status}</span>}
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
