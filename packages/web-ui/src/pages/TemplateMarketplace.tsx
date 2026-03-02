import { useEffect, useState, useCallback } from 'react';

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

const CATEGORY_COLORS: Record<string, string> = {
  development: 'bg-blue-500/15 text-blue-400',
  devops: 'bg-orange-500/15 text-orange-400',
  management: 'bg-purple-500/15 text-purple-400',
  productivity: 'bg-green-500/15 text-green-400',
  general: 'bg-gray-500/15 text-gray-400',
};

const SOURCE_LABELS: Record<string, { label: string; color: string }> = {
  official: { label: 'Official', color: 'bg-indigo-500/20 text-indigo-400' },
  community: { label: 'Community', color: 'bg-emerald-500/20 text-emerald-400' },
  custom: { label: 'Custom', color: 'bg-amber-500/20 text-amber-400' },
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
      if (categoryFilter) params.set('category', categoryFilter);
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
  }, [filter, categoryFilter, search]);

  useEffect(() => { loadTemplates(); }, [loadTemplates]);

  const categories = [...new Set(templates.map(t => t.category))];

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
      {/* Header */}
      <div className="flex items-center gap-4 px-7 h-15 border-b border-gray-800 bg-gray-900 shrink-0">
        <h2 className="text-lg font-semibold">Template Marketplace</h2>

        {/* Source filters */}
        <div className="flex gap-1 ml-4">
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

        {/* Category filters */}
        {categories.length > 0 && (
          <div className="flex gap-1 ml-2 border-l border-gray-700 pl-3">
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

        {/* Search */}
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
        ) : templates.length === 0 ? (
          <div className="text-center text-gray-500 py-20">
            <div className="text-4xl mb-3 opacity-30">&#x29C9;</div>
            <div>No templates found. Templates come from the built-in registry and the marketplace.</div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {templates.map(tpl => (
              <div
                key={tpl.id}
                onClick={() => setSelected(selected?.id === tpl.id ? null : tpl)}
                className={`bg-gray-900 border rounded-xl p-5 cursor-pointer transition-colors ${
                  selected?.id === tpl.id ? 'border-indigo-500' : 'border-gray-800 hover:border-gray-700'
                }`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <div>
                      <div className="font-semibold">{tpl.name}</div>
                      <div className="text-xs text-gray-500 mt-0.5">v{tpl.version} by {tpl.author}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
                      SOURCE_LABELS[tpl.source]?.color ?? 'bg-gray-500/15 text-gray-400'
                    }`}>
                      {SOURCE_LABELS[tpl.source]?.label ?? tpl.source}
                    </span>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium capitalize ${
                      CATEGORY_COLORS[tpl.category] ?? 'bg-gray-500/15 text-gray-400'
                    }`}>
                      {tpl.category}
                    </span>
                  </div>
                </div>

                <p className="text-sm text-gray-400 mt-3 line-clamp-2">{tpl.description}</p>

                <div className="flex flex-wrap gap-1.5 mt-3">
                  {tpl.tags.slice(0, 5).map(t => (
                    <span key={t} className="px-2 py-0.5 text-[10px] bg-gray-800 text-gray-500 rounded-full">{t}</span>
                  ))}
                </div>

                <div className="mt-3 pt-3 border-t border-gray-800 flex items-center justify-between">
                  <div className="text-xs text-gray-500">
                    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] ${
                      tpl.agentRole === 'manager' ? 'bg-purple-500/15 text-purple-400' : 'bg-gray-700 text-gray-400'
                    }`}>
                      {tpl.agentRole}
                    </span>
                    <span className="ml-2">{tpl.skills.length} skill{tpl.skills.length !== 1 ? 's' : ''}</span>
                    {(tpl.downloadCount ?? 0) > 0 && (
                      <span className="ml-2">{tpl.downloadCount} installs</span>
                    )}
                  </div>
                  {(tpl.ratingCount ?? 0) > 0 && (
                    <StarRating rating={tpl.avgRating ?? 0} count={tpl.ratingCount ?? 0} />
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Detail Panel */}
      {selected && (
        <div className="border-t border-gray-800 bg-gray-900 p-5 shrink-0 max-h-72 overflow-y-auto">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="font-semibold">{selected.name}</h3>
              <p className="text-xs text-gray-500 mt-0.5">{selected.description}</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowHireModal(true)}
                className="px-4 py-2 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-500 transition-colors"
              >
                Hire Agent
              </button>
              <button onClick={() => setSelected(null)} className="text-gray-500 hover:text-gray-300 text-lg">&times;</button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <div className="text-xs text-gray-500 uppercase mb-2">Skills</div>
              <div className="flex flex-wrap gap-1.5">
                {selected.skills.map(s => (
                  <span key={s} className="px-2 py-1 text-xs bg-gray-800 text-indigo-400 rounded-lg">{s}</span>
                ))}
                {selected.skills.length === 0 && <span className="text-xs text-gray-600">No required skills</span>}
              </div>
            </div>
            <div>
              <div className="text-xs text-gray-500 uppercase mb-2">Role Configuration</div>
              <div className="text-sm text-gray-400">
                <div>Role: <span className="text-gray-300">{selected.roleId}</span></div>
                <div>Position: <span className="text-gray-300 capitalize">{selected.agentRole}</span></div>
              </div>
            </div>
            {selected.starterTasks && selected.starterTasks.length > 0 && (
              <div>
                <div className="text-xs text-gray-500 uppercase mb-2">Starter Tasks</div>
                <div className="space-y-1">
                  {selected.starterTasks.map((task, i) => (
                    <div key={i} className="text-xs text-gray-400">
                      <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1.5 ${
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
      )}

      {/* Hire from Template Modal */}
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
        <h3 className="text-base font-semibold mb-1">Hire from Template</h3>
        <p className="text-xs text-gray-500 mb-5">Creating agent from "{template.name}" template</p>

        <div className="space-y-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1.5">Agent Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:border-indigo-500 focus:outline-none"
              autoFocus
            />
          </div>

          {teams.length > 0 && (
            <div>
              <label className="block text-xs text-gray-500 mb-1.5">Assign to Team (optional)</label>
              <select
                value={teamId}
                onChange={e => setTeamId(e.target.value)}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:border-indigo-500 focus:outline-none"
              >
                <option value="">No team</option>
                {teams.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
          )}

          <div className="bg-gray-800/50 rounded-lg p-3">
            <div className="text-xs text-gray-500 mb-2">Template Configuration</div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="text-gray-500">Role:</div>
              <div className="text-gray-300">{template.roleId}</div>
              <div className="text-gray-500">Position:</div>
              <div className="text-gray-300 capitalize">{template.agentRole}</div>
              <div className="text-gray-500">Skills:</div>
              <div className="text-gray-300">{template.skills.join(', ') || 'None'}</div>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors">Cancel</button>
          <button
            onClick={handleSubmit}
            disabled={!name.trim() || submitting}
            className="px-4 py-2 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {submitting ? 'Creating...' : 'Create Agent'}
          </button>
        </div>
      </div>
    </div>
  );
}
