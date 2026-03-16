import { useEffect, useState, useCallback } from 'react';
import { hubApi, type AuthUser, type HubItem } from '../api.ts';

type FilterId = 'all' | 'hub';

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
  development: 'bg-blue-500/15 text-blue-400 border-blue-500/20',
  devops: 'bg-orange-500/15 text-orange-400 border-orange-500/20',
  management: 'bg-purple-500/15 text-purple-400 border-purple-500/20',
  productivity: 'bg-green-500/15 text-green-400 border-green-500/20',
  general: 'bg-gray-500/15 text-gray-400 border-gray-500/20',
};

const ROLE_COLORS: Record<string, string> = {
  manager: 'bg-purple-500/15 text-purple-400',
  worker: 'bg-cyan-500/15 text-cyan-400',
};

export function TemplateMarketplace({ authUser: _authUser }: { authUser?: AuthUser } = {}) {
  const [filter, setFilter] = useState<FilterId>('all');
  const [search, setSearch] = useState('');
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [hubItems, setHubItems] = useState<HubItem[]>([]);
  const [selected, setSelected] = useState<TemplateInfo | null>(null);
  const [showHireModal, setShowHireModal] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (filter === 'hub') {
        const res = await hubApi.search({ type: 'agent', q: search || undefined, limit: 50 }).catch(() => ({ items: [] as HubItem[], total: 0 }));
        setHubItems(res.items);
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
  }, [filter, search]);

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
      <div className="flex items-center gap-4 px-7 h-15 border-b border-gray-800 bg-gray-900 shrink-0">
        <h2 className="text-lg font-semibold">Agent Store</h2>
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
              onClick={() => { setFilter(f.id); setSelected(null); }}
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
            {templates.length} agent{templates.length !== 1 ? 's' : ''} available
          </div>
        )}
        <div className="ml-auto">
          <input
            type="text"
            placeholder="Search agents..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm w-52 focus:border-indigo-500 focus:outline-none"
          />
        </div>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto p-7">
        {loading ? (
          <div className="text-center text-gray-500 py-20 animate-pulse">Loading agents...</div>
        ) : filter === 'hub' ? (
          hubItems.length === 0 ? (
            <div className="text-center py-16">
              <div className="text-gray-600 text-3xl mb-3">🏪</div>
              <p className="text-sm text-gray-500">No agents found on Markus Hub</p>
              <p className="text-xs text-gray-600 mt-1">Hub may be offline or empty. Start the hub server at port 3003.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {hubItems.map(item => (
                <HubAgentCard key={item.id} item={item} />
              ))}
            </div>
          )
        ) : templates.length === 0 ? (
          <div className="text-center py-20">
            <div className="text-4xl mb-4 opacity-30">&#x29C9;</div>
            <div className="text-gray-400 font-medium mb-1">
              {search ? `No agents match "${search}"` : 'No agents found'}
            </div>
            <div className="text-gray-600 text-sm">
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
    </div>
  );
}

function HubAgentCard({ item }: { item: HubItem }) {
  return (
    <div className="p-4 bg-gray-900 rounded-xl border border-gray-800 hover:border-indigo-600/50 cursor-pointer transition-all">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-lg">🤖</span>
        <h3 className="text-sm font-semibold truncate flex-1">{item.name}</h3>
        <span className="text-[10px] px-1.5 py-0.5 bg-teal-500/15 text-teal-400 rounded">Hub</span>
      </div>
      <p className="text-xs text-gray-500 line-clamp-2 mb-2">{item.description}</p>
      <div className="flex items-center gap-3 text-xs text-gray-500">
        <span className="text-amber-400">{'★'.repeat(Math.round(parseFloat(item.avgRating)))}{'☆'.repeat(5 - Math.round(parseFloat(item.avgRating)))}</span>
        <span>↓ {item.downloadCount}</span>
        <span>{item.author?.displayName ?? item.author?.username}</span>
      </div>
      <button
        onClick={async (e) => {
          e.stopPropagation();
          try {
            const data = await hubApi.download(item.id);
            const blob = new Blob([JSON.stringify(data.config, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `${item.name}.json`;
            a.click();
          } catch { /* ignore */ }
        }}
        className="mt-3 px-3 py-1 text-xs bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors"
      >
        Install
      </button>
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
            <span className="px-2 py-0.5 rounded-full text-[10px] font-medium shrink-0 bg-indigo-500/20 text-indigo-400">
              v{tpl.version}
            </span>
          </div>
          <div className="text-xs text-gray-500 mt-0.5">by {tpl.author}</div>
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

      <div className="mt-3 pt-3 border-t border-gray-800 flex items-center gap-2 text-xs text-gray-500">
        <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium capitalize ${
          ROLE_COLORS[tpl.agentRole] ?? 'bg-gray-700 text-gray-400'
        }`}>
          {tpl.agentRole}
        </span>
        {tpl.tags.length > 0 && (
          <span className="text-gray-600">{tpl.tags.slice(0, 2).join(', ')}</span>
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
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 w-[440px] shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 mb-5">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-sm ${CATEGORY_COLORS[template.category] ?? 'bg-gray-700 text-gray-400'}`}>
            {CATEGORY_ICONS[template.category] ?? '?'}
          </div>
          <div>
            <h3 className="text-base font-semibold">Hire Agent</h3>
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
            <div className="text-xs text-gray-500 mb-2 font-medium">Agent Configuration</div>
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
