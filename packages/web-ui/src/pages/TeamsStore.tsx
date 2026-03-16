import { useEffect, useState, useCallback } from 'react';
import { api, hubApi, type TeamTemplateInfo, type HubItem } from '../api.ts';

type FilterId = 'all' | 'hub';

const TEAM_CATEGORY_ICONS: Record<string, string> = {
  development: '{ }',
  review: '⊘',
  operations: '⚙',
  general: '◎',
};

const TEAM_CATEGORY_COLORS: Record<string, string> = {
  development: 'bg-blue-500/15 text-blue-400 border-blue-500/20',
  review: 'bg-purple-500/15 text-purple-400 border-purple-500/20',
  operations: 'bg-orange-500/15 text-orange-400 border-orange-500/20',
  general: 'bg-gray-500/15 text-gray-400 border-gray-500/20',
};

export function TeamsStore() {
  const [filter, setFilter] = useState<FilterId>('all');
  const [search, setSearch] = useState('');
  const [templates, setTemplates] = useState<TeamTemplateInfo[]>([]);
  const [hubItems, setHubItems] = useState<HubItem[]>([]);
  const [selected, setSelected] = useState<TeamTemplateInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<{ ok: boolean; message: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (filter === 'hub') {
        const res = await hubApi.search({ type: 'team', q: search || undefined, limit: 50 }).catch(() => ({ items: [] as HubItem[], total: 0 }));
        setHubItems(res.items);
        setTemplates([]);
      } else {
        setHubItems([]);
        const res = await api.teamTemplates.list(search || undefined);
        setTemplates(res.templates ?? []);
      }
    } catch {
      setTemplates([]);
      setHubItems([]);
    } finally {
      setLoading(false);
    }
  }, [filter, search]);

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
          const roleName = member.roleName ?? member.templateId ?? 'developer';
          try {
            const res = await fetch('/api/agents', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({
                name: displayName,
                roleName,
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
      <div className="flex items-center gap-4 px-7 h-15 border-b border-gray-800 bg-gray-900 shrink-0">
        <h2 className="text-lg font-semibold">Team Store</h2>
      </div>

      {/* Filter Bar */}
      <div className="flex items-center gap-3 px-7 py-2.5 border-b border-gray-800/50 bg-gray-900/50 shrink-0">
        <div className="flex gap-1">
          {([
            { id: 'all' as const, label: 'Built-in' },
            { id: 'hub' as const, label: 'Markus Hub' },
          ]).map(f => (
            <button
              key={f.id}
              onClick={() => { setFilter(f.id); setSelected(null); setDeployResult(null); }}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                filter === f.id ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        {filter === 'all' && (
          <div className="text-xs text-gray-500">
            {templates.length} team{templates.length !== 1 ? 's' : ''} available
          </div>
        )}
        <div className="ml-auto">
          <input
            type="text"
            placeholder="Search teams..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm w-52 focus:border-indigo-500 focus:outline-none"
          />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-7">
        {loading ? (
          <div className="text-center text-gray-500 py-20 animate-pulse">Loading teams...</div>
        ) : filter === 'hub' ? (
          hubItems.length === 0 ? (
            <div className="text-center py-16">
              <div className="text-gray-600 text-3xl mb-3">🏪</div>
              <p className="text-sm text-gray-500">No teams found on Markus Hub</p>
              <p className="text-xs text-gray-600 mt-1">Hub may be offline or empty. Start the hub server at port 3003.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {hubItems.map(item => (
                <HubTeamCard key={item.id} item={item} />
              ))}
            </div>
          )
        ) : templates.length === 0 ? (
          <div className="text-center py-20">
            <div className="text-4xl mb-4 opacity-30">&#9673;</div>
            <div className="text-gray-400 font-medium mb-1">
              {search ? `No teams match "${search}"` : 'No teams available'}
            </div>
            <div className="text-gray-600 text-sm">
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
        <div className="border-t border-gray-800 bg-gray-900 shrink-0 max-h-80 overflow-y-auto">
          <div className="p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-lg border ${
                  TEAM_CATEGORY_COLORS[selected.category ?? 'general'] ?? TEAM_CATEGORY_COLORS['general']
                }`}>
                  {TEAM_CATEGORY_ICONS[selected.category ?? 'general'] ?? '◎'}
                </div>
                <div>
                  <h3 className="font-semibold text-white">{selected.name}</h3>
                  <p className="text-xs text-gray-500 mt-0.5">{selected.description}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleDeploy(selected)}
                  disabled={deploying}
                  className="px-5 py-2 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-500 transition-colors font-medium disabled:opacity-50"
                >
                  {deploying ? 'Deploying...' : 'Deploy Team'}
                </button>
                <button onClick={() => { setSelected(null); setDeployResult(null); }} className="text-gray-500 hover:text-gray-300 text-lg px-2">&times;</button>
              </div>
            </div>

            {deployResult && (
              <div className={`mb-4 px-4 py-2.5 rounded-lg text-sm ${
                deployResult.ok ? 'bg-green-500/10 text-green-400 border border-green-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'
              }`}>
                {deployResult.message}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div>
                <div className="text-xs text-gray-500 uppercase tracking-wider mb-3">Team Composition</div>
                <div className="space-y-2">
                  {selected.members.map((m, i) => (
                    <div key={i} className="flex items-center gap-3 bg-gray-800/50 rounded-lg p-3">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold shrink-0 ${
                        m.role === 'manager' ? 'bg-purple-500/20 text-purple-400' : 'bg-cyan-500/20 text-cyan-400'
                      }`}>
                        {m.role === 'manager' ? '★' : (i + 1)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-gray-200">{m.name ?? m.roleName ?? m.templateId}</div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-[10px] text-gray-500 font-mono">{m.roleName ?? m.templateId}</span>
                          <span className={`px-1.5 py-0.5 rounded text-[10px] capitalize ${
                            m.role === 'manager' ? 'bg-purple-500/15 text-purple-400' : 'bg-cyan-500/15 text-cyan-400'
                          }`}>
                            {m.role ?? 'worker'}
                          </span>
                          {(m.count ?? 1) > 1 && (
                            <span className="text-[10px] text-gray-500">x{m.count}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-xs text-gray-500 uppercase tracking-wider mb-3">Details</div>
                <div className="space-y-2 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="text-gray-500 w-20">Version:</span>
                    <span className="text-gray-300 font-mono text-xs">{selected.version}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-gray-500 w-20">Author:</span>
                    <span className="text-gray-300">{selected.author}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-gray-500 w-20">Members:</span>
                    <span className="text-gray-300">{selected.members.reduce((s, m) => s + (m.count ?? 1), 0)} agents</span>
                  </div>
                  {selected.tags && selected.tags.length > 0 && (
                    <div className="flex items-start gap-2">
                      <span className="text-gray-500 w-20 pt-0.5">Tags:</span>
                      <div className="flex flex-wrap gap-1.5">
                        {selected.tags.map(t => (
                          <span key={t} className="px-2 py-0.5 text-[10px] bg-gray-800 text-gray-400 rounded-full border border-gray-700">{t}</span>
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

function HubTeamCard({ item }: { item: HubItem }) {
  const [installing, setInstalling] = useState(false);
  const [status, setStatus] = useState('');

  const handleInstall = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (installing) return;
    setInstalling(true);
    setStatus('');
    try {
      const data = await hubApi.download(item.id);
      const artifact = { ...(data.config as Record<string, unknown>), name: data.name || item.name, description: item.description };
      if (data.files) (artifact as Record<string, unknown>).files = data.files;
      const saved = await api.builder.artifacts.save('team', artifact);
      await api.builder.artifacts.install('team', saved.name);
      setStatus('Installed!');
    } catch {
      setStatus('Failed');
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="p-4 bg-gray-900 rounded-xl border border-gray-800 hover:border-indigo-600/50 cursor-pointer transition-all">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-lg">{'\uD83D\uDC65'}</span>
        <h3 className="text-sm font-semibold truncate flex-1">{item.name}</h3>
        <span className="text-[10px] px-1.5 py-0.5 bg-teal-500/15 text-teal-400 rounded">Hub</span>
      </div>
      <p className="text-xs text-gray-500 line-clamp-2 mb-2">{item.description}</p>
      <div className="flex items-center gap-3 text-xs text-gray-500">
        <span className="text-amber-400">{'\u2605'.repeat(Math.round(parseFloat(item.avgRating)))}{'\u2606'.repeat(5 - Math.round(parseFloat(item.avgRating)))}</span>
        <span>{'\u2193'} {item.downloadCount}</span>
        <span>{item.author?.displayName ?? item.author?.username}</span>
      </div>
      <div className="flex items-center gap-2 mt-3">
        <button
          onClick={e => void handleInstall(e)}
          disabled={installing}
          className="px-3 py-1 text-xs bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors disabled:opacity-50"
        >
          {installing ? 'Installing...' : 'Install'}
        </button>
        {status && <span className={`text-[10px] ${status === 'Installed!' ? 'text-emerald-400' : 'text-red-400'}`}>{status}</span>}
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
      className={`bg-gray-900 border rounded-xl p-5 cursor-pointer transition-all hover:shadow-lg hover:shadow-black/20 ${
        isSelected ? 'border-indigo-500 ring-1 ring-indigo-500/30' : 'border-gray-800 hover:border-gray-700'
      }`}
    >
      <div className="flex items-start gap-3">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-sm shrink-0 border ${
          TEAM_CATEGORY_COLORS[cat] ?? TEAM_CATEGORY_COLORS['general']
        }`}>
          {TEAM_CATEGORY_ICONS[cat] ?? '◎'}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="font-semibold text-white truncate">{tpl.name}</div>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-medium shrink-0 bg-indigo-500/20 text-indigo-400">
              v{tpl.version}
            </span>
          </div>
          <div className="text-xs text-gray-500 mt-0.5">by {tpl.author}</div>
        </div>
      </div>

      <p className="text-sm text-gray-400 mt-3 line-clamp-2 leading-relaxed">{tpl.description}</p>

      <div className="flex flex-wrap gap-1.5 mt-3">
        {tpl.members.map((m, i) => (
          <span key={i} className={`px-2 py-0.5 text-[10px] rounded-full border ${
            m.role === 'manager' ? 'bg-purple-500/10 text-purple-400 border-purple-500/15' : 'bg-cyan-500/10 text-cyan-400 border-cyan-500/15'
          }`}>
            {m.name ?? m.roleName ?? m.templateId}
            {(m.count ?? 1) > 1 ? ` x${m.count}` : ''}
          </span>
        ))}
      </div>

      <div className="mt-3 pt-3 border-t border-gray-800 flex items-center gap-3 text-xs text-gray-500">
        <span>{totalAgents} agent{totalAgents !== 1 ? 's' : ''}</span>
        {hasManager && <span className="text-purple-400/60">has manager</span>}
        {tpl.tags && tpl.tags.length > 0 && (
          <span className="text-gray-600">{tpl.tags.slice(0, 3).join(', ')}</span>
        )}
      </div>
    </div>
  );
}
