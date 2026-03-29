import { useEffect, useState, useCallback } from 'react';
import { api, hubApi, type AuthUser, type HubItem } from '../api.ts';
import { consume, PREFETCH_KEYS } from '../prefetchCache.ts';

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

export function TemplateMarketplace({ authUser: _authUser }: { authUser?: AuthUser } = {}) {
  const [filter, setFilter] = useState<FilterId>('all');
  const [search, setSearch] = useState('');
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [hubItems, setHubItems] = useState<HubItem[]>([]);
  const [selected, setSelected] = useState<TemplateInfo | null>(null);
  const [showHireModal, setShowHireModal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [localArtifacts, setLocalArtifacts] = useState<Map<string, LocalArtifactInfo>>(new Map());

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

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      <div className="px-6 h-14 flex items-center border-b border-border-default bg-surface-secondary shrink-0">
        <h2 className="text-lg font-semibold">Agent Store</h2>
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
              onClick={() => { setFilter(f.id); setSelected(null); }}
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
            {templates.length} agent{templates.length !== 1 ? 's' : ''} available
          </div>
        )}
        <div className="flex-1 min-w-[120px]">
          <input
            type="text"
            placeholder="Search agents..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="px-3 py-1.5 bg-surface-elevated border border-border-default rounded-lg text-sm w-full focus:border-brand-500 focus:outline-none"
          />
        </div>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto p-7">
        {loading ? (
          <div className="text-center text-fg-tertiary py-20 animate-pulse">Loading agents...</div>
        ) : filter === 'hub' ? (
          hubItems.length === 0 ? (
            <div className="text-center py-16">
              <div className="text-fg-tertiary text-3xl mb-3">🏪</div>
              <p className="text-sm text-fg-tertiary">No agents found on Markus Hub</p>
              <p className="text-xs text-fg-tertiary mt-1">Hub may be offline or empty. Start the hub server at port 8059.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {hubItems.map(item => (
                <HubAgentCard key={item.id} item={item} localInfo={localArtifacts.get(toSlug(item.name))} onStatusChange={loadLocalStatus} />
              ))}
            </div>
          )
        ) : templates.length === 0 ? (
          <div className="text-center py-20">
            <div className="text-4xl mb-4 opacity-30">&#x29C9;</div>
            <div className="text-fg-secondary font-medium mb-1">
              {search ? `No agents match "${search}"` : 'No agents found'}
            </div>
            <div className="text-fg-tertiary text-sm">
              {search ? 'Try different search terms.' : 'Agents come from the built-in registry.'}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {templates.map(tpl => (
              <TemplateCard
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
        <div className="border-t border-border-default bg-surface-secondary shrink-0 max-h-72 overflow-y-auto">
          <div className="p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-lg ${CATEGORY_COLORS[selected.category] ?? 'bg-surface-overlay text-fg-secondary'}`}>
                  {CATEGORY_ICONS[selected.category] ?? '?'}
                </div>
                <div>
                  <h3 className="font-semibold text-fg-primary">{selected.name}</h3>
                  <p className="text-xs text-fg-tertiary mt-0.5">{selected.description}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowHireModal(true)}
                  className="px-5 py-2 bg-brand-600 text-white text-sm rounded-lg hover:bg-brand-500 transition-colors font-medium"
                >
                  Hire Agent
                </button>
                <button onClick={() => setSelected(null)} className="text-fg-tertiary hover:text-fg-secondary text-lg px-2">&times;</button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              <div>
                <div className="text-xs text-fg-tertiary uppercase tracking-wider mb-2">Skills</div>
                <div className="flex flex-wrap gap-1.5">
                  {selected.skills.map(s => (
                    <span key={s} className="px-2.5 py-1 text-xs bg-brand-500/10 text-brand-500 rounded-lg border border-brand-500/20">{s}</span>
                  ))}
                  {selected.skills.length === 0 && <span className="text-xs text-fg-tertiary italic">No required skills</span>}
                </div>
              </div>
              <div>
                <div className="text-xs text-fg-tertiary uppercase tracking-wider mb-2">Role Configuration</div>
                <div className="space-y-1.5 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="text-fg-tertiary w-16">Role:</span>
                    <span className="text-fg-secondary font-mono text-xs bg-surface-elevated px-2 py-0.5 rounded">{selected.roleId}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-fg-tertiary w-16">Position:</span>
                    <span className={`px-2 py-0.5 rounded text-xs capitalize ${ROLE_COLORS[selected.agentRole] ?? ''}`}>{selected.agentRole}</span>
                  </div>
                </div>
              </div>
              {selected.starterTasks && selected.starterTasks.length > 0 && (
                <div>
                  <div className="text-xs text-fg-tertiary uppercase tracking-wider mb-2">Starter Tasks</div>
                  <div className="space-y-1.5">
                    {selected.starterTasks.map((task, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs text-fg-secondary">
                        <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
                          task.priority === 'high' ? 'bg-red-400' : task.priority === 'medium' ? 'bg-amber-400' : 'bg-green-400'
                        }`} />
                        {task.title}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {showHireModal && selected && (
        <HireFromTemplateModal
          template={selected}
          onClose={() => setShowHireModal(false)}
          onHire={handleInstantiate}
        />
      )}
    </div>
  );
}

function HubAgentCard({ item, localInfo, onStatusChange }: { item: HubItem; localInfo?: LocalArtifactInfo; onStatusChange: () => void }) {
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
      const mode = (data.itemType === 'team' ? 'team' : data.itemType === 'skill' ? 'skill' : 'agent') as 'agent' | 'team' | 'skill';
      const hubSource = { type: 'hub', hubItemId: item.id };
      if (data.files && Object.keys(data.files).length > 0) {
        await api.builder.artifacts.import(mode, slug, data.files, hubSource);
      } else {
        const artifact = { ...(data.config as Record<string, unknown>), name, description: item.description, source: hubSource };
        await api.builder.artifacts.save(mode, artifact);
      }
      await api.builder.artifacts.install(mode, slug);
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
        <span className="text-lg">{'\uD83E\uDD16'}</span>
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

function TemplateCard({ template: tpl, isSelected, onSelect }: { template: TemplateInfo; isSelected: boolean; onSelect: () => void }) {
  return (
    <div
      onClick={onSelect}
      className={`bg-surface-secondary border rounded-xl p-5 cursor-pointer transition-all hover:shadow-lg hover:shadow-black/20 ${
        isSelected ? 'border-brand-500 ring-1 ring-brand-500/30' : 'border-border-default hover:border-gray-600'
      }`}
    >
      <div className="flex items-start gap-3">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-sm shrink-0 border ${CATEGORY_COLORS[tpl.category] ?? 'bg-surface-overlay text-fg-secondary'}`}>
          {CATEGORY_ICONS[tpl.category] ?? '?'}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="font-semibold text-fg-primary truncate">{tpl.name}</div>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-medium shrink-0 bg-brand-500/20 text-brand-500">
              v{tpl.version}
            </span>
          </div>
          <div className="text-xs text-fg-tertiary mt-0.5">by {tpl.author}</div>
        </div>
      </div>

      <p className="text-sm text-fg-secondary mt-3 line-clamp-2 leading-relaxed">{tpl.description}</p>

      <div className="flex flex-wrap gap-1.5 mt-3">
        {tpl.skills.slice(0, 4).map(s => (
          <span key={s} className="px-2 py-0.5 text-[10px] bg-brand-500/10 text-brand-500/80 rounded-full border border-brand-500/10">{s}</span>
        ))}
        {tpl.skills.length > 4 && (
          <span className="px-2 py-0.5 text-[10px] text-fg-tertiary">+{tpl.skills.length - 4} more</span>
        )}
      </div>

      <div className="mt-3 pt-3 border-t border-border-default flex items-center gap-2 text-xs text-fg-tertiary">
        <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium capitalize ${
          ROLE_COLORS[tpl.agentRole] ?? 'bg-surface-overlay text-fg-secondary'
        }`}>
          {tpl.agentRole}
        </span>
        {tpl.tags.length > 0 && (
          <span className="text-fg-tertiary">{tpl.tags.slice(0, 2).join(', ')}</span>
        )}
      </div>
    </div>
  );
}

function HireFromTemplateModal({
  template,
  onClose,
  onHire,
}: {
  template: TemplateInfo;
  onClose: () => void;
  onHire: (templateId: string, name: string, teamId?: string) => Promise<void>;
}) {
  const [name, setName] = useState(`${template.name} Agent`);
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
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-sm ${CATEGORY_COLORS[template.category] ?? 'bg-surface-overlay text-fg-secondary'}`}>
            {CATEGORY_ICONS[template.category] ?? '?'}
          </div>
          <div>
            <h3 className="text-base font-semibold">Hire Agent</h3>
            <p className="text-xs text-fg-tertiary">Creating agent from "{template.name}"</p>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-xs text-fg-tertiary mb-1.5">Agent Name</label>
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
              <label className="block text-xs text-fg-tertiary mb-1.5">Assign to Team (optional)</label>
              <select value={teamId} onChange={e => setTeamId(e.target.value)} className="input-field">
                <option value="">No team</option>
                {teams.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
          )}

          <div className="bg-surface-elevated/50 rounded-lg p-3">
            <div className="text-xs text-fg-tertiary mb-2 font-medium">Agent Configuration</div>
            <div className="grid grid-cols-2 gap-y-1.5 gap-x-4 text-xs">
              <div className="text-fg-tertiary">Role:</div>
              <div className="text-fg-secondary font-mono">{template.roleId}</div>
              <div className="text-fg-tertiary">Position:</div>
              <div className="text-fg-secondary capitalize">{template.agentRole}</div>
              <div className="text-fg-tertiary">Skills:</div>
              <div className="text-fg-secondary">{template.skills.join(', ') || 'None'}</div>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button
            onClick={handleSubmit}
            disabled={!name.trim() || submitting}
            className="btn-primary"
          >
            {submitting ? 'Creating...' : 'Create Agent'}
          </button>
        </div>
      </div>
    </div>
  );
}
