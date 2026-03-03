import { useEffect, useState, useCallback } from 'react';
import { api, type TeamTemplateInfo } from '../api.ts';

type TabId = 'agent' | 'team';

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
  downloadCount?: number;
  avgRating?: number;
  ratingCount?: number;
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
  development: 'bg-blue-500/15 text-blue-400 border-blue-500/20',
  devops: 'bg-orange-500/15 text-orange-400 border-orange-500/20',
  management: 'bg-purple-500/15 text-purple-400 border-purple-500/20',
  productivity: 'bg-green-500/15 text-green-400 border-green-500/20',
  general: 'bg-gray-500/15 text-gray-400 border-gray-500/20',
};

const SOURCE_LABELS: Record<string, { label: string; color: string }> = {
  official: { label: 'Official', color: 'bg-indigo-500/20 text-indigo-400' },
  community: { label: 'Community', color: 'bg-emerald-500/20 text-emerald-400' },
  custom: { label: 'Custom', color: 'bg-amber-500/20 text-amber-400' },
};

const ROLE_COLORS: Record<string, string> = {
  manager: 'bg-purple-500/15 text-purple-400',
  worker: 'bg-cyan-500/15 text-cyan-400',
};

function StarRating({ rating, count }: { rating: number; count: number }) {
  const stars = Math.round(rating);
  return (
    <span className="inline-flex items-center gap-1 text-xs text-gray-500">
      {[1, 2, 3, 4, 5].map(i => (
        <span key={i} className={i <= stars ? 'text-amber-400' : 'text-gray-700'}>&#9733;</span>
      ))}
      {count > 0 && <span className="ml-1">({count})</span>}
    </span>
  );
}

export function TemplateMarketplace() {
  const [activeTab, setActiveTab] = useState<TabId>('agent');

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      {/* Header with Tabs */}
      <div className="flex items-center gap-4 px-7 h-15 border-b border-gray-800 bg-gray-900 shrink-0">
        <h2 className="text-lg font-semibold">Template Marketplace</h2>
        <div className="flex gap-1 ml-4 bg-gray-800 rounded-lg p-0.5">
          {([
            { id: 'agent' as const, label: 'Agent Templates', icon: '⊕' },
            { id: 'team' as const, label: 'Team Templates', icon: '◎' },
          ]).map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-3.5 py-1.5 text-xs rounded-md transition-colors flex items-center gap-1.5 ${
                activeTab === tab.id ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              <span>{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'agent' ? <AgentTemplatesTab /> : <TeamTemplatesTab />}
    </div>
  );
}

function AgentTemplatesTab() {
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [selected, setSelected] = useState<TemplateInfo | null>(null);
  const [filter, setFilter] = useState<'all' | 'official' | 'community'>('all');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [search, setSearch] = useState('');
  const [showHireModal, setShowHireModal] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadTemplates = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filter !== 'all') params.set('source', filter);
      if (search) params.set('q', search);

      const [registryRes, marketplaceRes] = await Promise.all([
        fetch('/api/templates?' + params.toString()).then(r => r.json()).catch(() => ({ templates: [] })),
        fetch('/api/marketplace/templates?' + params.toString()).then(r => r.json()).catch(() => ({ templates: [] })),
      ]);

      const registry: TemplateInfo[] = Array.isArray(registryRes.templates) ? registryRes.templates : [];
      const marketplace: TemplateInfo[] = Array.isArray(marketplaceRes.templates) ? marketplaceRes.templates : [];

      const seen = new Set<string>();
      const merged: TemplateInfo[] = [];
      for (const t of [...registry, ...marketplace]) {
        if (!seen.has(t.id)) {
          seen.add(t.id);
          merged.push(t);
        }
      }
      setTemplates(merged);
    } catch {
      setTemplates([]);
    } finally {
      setLoading(false);
    }
  }, [filter, search]);

  useEffect(() => { loadTemplates(); }, [loadTemplates]);

  const categories = [...new Set(templates.map(t => t.category))].sort();
  const filtered = categoryFilter ? templates.filter(t => t.category === categoryFilter) : templates;

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
    <>
      {/* Filter Bar */}
      <div className="flex items-center gap-3 px-7 py-2.5 border-b border-gray-800/50 bg-gray-900/50 shrink-0">
        <div className="flex gap-1">
          {(['all', 'official', 'community'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1 text-xs rounded-md transition-colors capitalize ${
                filter === f ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
              }`}
            >
              {f}
            </button>
          ))}
        </div>

        {categories.length > 1 && (
          <div className="flex gap-1 border-l border-gray-700 pl-3">
            {categories.map(c => (
              <button
                key={c}
                onClick={() => setCategoryFilter(prev => prev === c ? '' : c)}
                className={`px-3 py-1 text-xs rounded-md transition-colors capitalize ${
                  categoryFilter === c ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        )}

        <div className="ml-auto">
          <input
            type="text"
            placeholder="Search templates..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm w-52 focus:border-indigo-500 focus:outline-none"
          />
        </div>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto p-7">
        {loading ? (
          <div className="text-center text-gray-500 py-20 animate-pulse">Loading templates...</div>
        ) : filtered.length === 0 ? (
          <EmptyState filter={filter} search={search} />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map(tpl => (
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
      {selected && (
        <div className="border-t border-gray-800 bg-gray-900 shrink-0 max-h-72 overflow-y-auto">
          <div className="p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-lg ${CATEGORY_COLORS[selected.category] ?? 'bg-gray-700 text-gray-400'}`}>
                  {CATEGORY_ICONS[selected.category] ?? '?'}
                </div>
                <div>
                  <h3 className="font-semibold text-white">{selected.name}</h3>
                  <p className="text-xs text-gray-500 mt-0.5">{selected.description}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowHireModal(true)}
                  className="px-5 py-2 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-500 transition-colors font-medium"
                >
                  Hire Agent
                </button>
                <button onClick={() => setSelected(null)} className="text-gray-500 hover:text-gray-300 text-lg px-2">&times;</button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              <div>
                <div className="text-xs text-gray-500 uppercase tracking-wider mb-2">Skills</div>
                <div className="flex flex-wrap gap-1.5">
                  {selected.skills.map(s => (
                    <span key={s} className="px-2.5 py-1 text-xs bg-indigo-500/10 text-indigo-400 rounded-lg border border-indigo-500/20">{s}</span>
                  ))}
                  {selected.skills.length === 0 && <span className="text-xs text-gray-600 italic">No required skills</span>}
                </div>
              </div>
              <div>
                <div className="text-xs text-gray-500 uppercase tracking-wider mb-2">Role Configuration</div>
                <div className="space-y-1.5 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="text-gray-500 w-16">Role:</span>
                    <span className="text-gray-300 font-mono text-xs bg-gray-800 px-2 py-0.5 rounded">{selected.roleId}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-gray-500 w-16">Position:</span>
                    <span className={`px-2 py-0.5 rounded text-xs capitalize ${ROLE_COLORS[selected.agentRole] ?? ''}`}>{selected.agentRole}</span>
                  </div>
                </div>
              </div>
              {selected.starterTasks && selected.starterTasks.length > 0 && (
                <div>
                  <div className="text-xs text-gray-500 uppercase tracking-wider mb-2">Starter Tasks</div>
                  <div className="space-y-1.5">
                    {selected.starterTasks.map((task, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs text-gray-400">
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
    </>
  );
}

// ── Team Templates Tab ──────────────────────────────────────────────────────

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

function TeamTemplatesTab() {
  const [templates, setTemplates] = useState<TeamTemplateInfo[]>([]);
  const [selected, setSelected] = useState<TeamTemplateInfo | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<{ ok: boolean; message: string } | null>(null);

  const loadTemplates = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.teamTemplates.list(search || undefined);
      setTemplates(res.templates ?? []);
    } catch {
      setTemplates([]);
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => { loadTemplates(); }, [loadTemplates]);

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
          try {
            const res = await fetch('/api/templates/instantiate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({
                templateId: member.templateId,
                name: count > 1 ? `${name} ${i + 1}` : name,
                orgId: 'default',
                teamId,
                agentRole: member.role,
              }),
            });
            if (res.ok) {
              deployed++;
              const data = await res.json();
              if (member.role === 'manager' && !managerId) {
                managerId = data.agent?.id;
              }
            } else {
              const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
              errors.push(`${member.templateId}: ${data.error ?? res.statusText}`);
            }
          } catch (err) {
            errors.push(`${member.templateId}: ${String(err)}`);
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
    <>
      {/* Filter Bar */}
      <div className="flex items-center gap-3 px-7 py-2.5 border-b border-gray-800/50 bg-gray-900/50 shrink-0">
        <div className="text-xs text-gray-500">
          {templates.length} team template{templates.length !== 1 ? 's' : ''} available
        </div>
        <div className="ml-auto">
          <input
            type="text"
            placeholder="Search team templates..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm w-52 focus:border-indigo-500 focus:outline-none"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-7">
        {loading ? (
          <div className="text-center text-gray-500 py-20 animate-pulse">Loading team templates...</div>
        ) : templates.length === 0 ? (
          <div className="text-center py-20">
            <div className="text-4xl mb-4 opacity-30">&#9673;</div>
            <div className="text-gray-400 font-medium mb-1">
              {search ? `No team templates match "${search}"` : 'No team templates available'}
            </div>
            <div className="text-gray-600 text-sm">
              {search ? 'Try different search terms.' : 'Go to the Builder page to create a team template.'}
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
      {selected && (
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
                        <div className="text-sm text-gray-200">{m.name ?? m.templateId}</div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-[10px] text-gray-500 font-mono">{m.templateId}</span>
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
    </>
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
            {m.name ?? m.templateId}
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

function TemplateCard({ template: tpl, isSelected, onSelect }: { template: TemplateInfo; isSelected: boolean; onSelect: () => void }) {
  return (
    <div
      onClick={onSelect}
      className={`bg-gray-900 border rounded-xl p-5 cursor-pointer transition-all hover:shadow-lg hover:shadow-black/20 ${
        isSelected ? 'border-indigo-500 ring-1 ring-indigo-500/30' : 'border-gray-800 hover:border-gray-700'
      }`}
    >
      <div className="flex items-start gap-3">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-sm shrink-0 border ${CATEGORY_COLORS[tpl.category] ?? 'bg-gray-700 text-gray-400'}`}>
          {CATEGORY_ICONS[tpl.category] ?? '?'}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="font-semibold text-white truncate">{tpl.name}</div>
            <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium shrink-0 ${
              SOURCE_LABELS[tpl.source]?.color ?? 'bg-gray-500/15 text-gray-400'
            }`}>
              {SOURCE_LABELS[tpl.source]?.label ?? tpl.source}
            </span>
          </div>
          <div className="text-xs text-gray-500 mt-0.5">v{tpl.version} by {tpl.author}</div>
        </div>
      </div>

      <p className="text-sm text-gray-400 mt-3 line-clamp-2 leading-relaxed">{tpl.description}</p>

      <div className="flex flex-wrap gap-1.5 mt-3">
        {tpl.skills.slice(0, 4).map(s => (
          <span key={s} className="px-2 py-0.5 text-[10px] bg-indigo-500/10 text-indigo-400/80 rounded-full border border-indigo-500/10">{s}</span>
        ))}
        {tpl.skills.length > 4 && (
          <span className="px-2 py-0.5 text-[10px] text-gray-500">+{tpl.skills.length - 4} more</span>
        )}
      </div>

      <div className="mt-3 pt-3 border-t border-gray-800 flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium capitalize ${
            ROLE_COLORS[tpl.agentRole] ?? 'bg-gray-700 text-gray-400'
          }`}>
            {tpl.agentRole}
          </span>
          {tpl.tags.length > 0 && (
            <span className="text-gray-600">{tpl.tags.slice(0, 2).join(', ')}</span>
          )}
          {(tpl.downloadCount ?? 0) > 0 && (
            <span>{tpl.downloadCount} installs</span>
          )}
        </div>
        {(tpl.ratingCount ?? 0) > 0 && (
          <StarRating rating={tpl.avgRating ?? 0} count={tpl.ratingCount ?? 0} />
        )}
      </div>
    </div>
  );
}

function EmptyState({ filter, search }: { filter: string; search: string }) {
  if (search) {
    return (
      <div className="text-center py-20">
        <div className="text-4xl mb-4 opacity-30">&#128269;</div>
        <div className="text-gray-400 font-medium mb-1">No templates match "{search}"</div>
        <div className="text-gray-600 text-sm">Try adjusting your search terms or filters.</div>
      </div>
    );
  }
  if (filter === 'community') {
    return (
      <div className="text-center py-20">
        <div className="text-4xl mb-4 opacity-30">&#127760;</div>
        <div className="text-gray-400 font-medium mb-1">No community templates yet</div>
        <div className="text-gray-600 text-sm max-w-md mx-auto">
          Community templates are created by users. Go to the Builder page to create and publish your own templates.
        </div>
      </div>
    );
  }
  return (
    <div className="text-center py-20">
      <div className="text-4xl mb-4 opacity-30">&#x29C9;</div>
      <div className="text-gray-400 font-medium mb-1">No templates found</div>
      <div className="text-gray-600 text-sm">Templates come from the built-in registry and the marketplace.</div>
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
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 w-[440px] shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 mb-5">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-sm ${CATEGORY_COLORS[template.category] ?? 'bg-gray-700 text-gray-400'}`}>
            {CATEGORY_ICONS[template.category] ?? '?'}
          </div>
          <div>
            <h3 className="text-base font-semibold">Hire from Template</h3>
            <p className="text-xs text-gray-500">Creating agent from "{template.name}"</p>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1.5">Agent Name</label>
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
              <label className="block text-xs text-gray-500 mb-1.5">Assign to Team (optional)</label>
              <select value={teamId} onChange={e => setTeamId(e.target.value)} className="input-field">
                <option value="">No team</option>
                {teams.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
          )}

          <div className="bg-gray-800/50 rounded-lg p-3">
            <div className="text-xs text-gray-500 mb-2 font-medium">Template Configuration</div>
            <div className="grid grid-cols-2 gap-y-1.5 gap-x-4 text-xs">
              <div className="text-gray-500">Role:</div>
              <div className="text-gray-300 font-mono">{template.roleId}</div>
              <div className="text-gray-500">Position:</div>
              <div className="text-gray-300 capitalize">{template.agentRole}</div>
              <div className="text-gray-500">Skills:</div>
              <div className="text-gray-300">{template.skills.join(', ') || 'None'}</div>
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
