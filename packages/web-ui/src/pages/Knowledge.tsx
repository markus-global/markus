import { useState, useEffect, useCallback, useRef } from 'react';
import { api, type KnowledgeEntryInfo, type ProjectInfo } from '../api.ts';
import { MarkdownMessage } from '../components/MarkdownMessage.tsx';

const CATEGORIES = ['architecture', 'convention', 'api', 'decision', 'gotcha', 'troubleshooting', 'dependency', 'process', 'reference'] as const;

const CATEGORY_META: Record<string, { icon: string; hint: string }> = {
  architecture:    { icon: '\u{1F3D7}', hint: 'System structure, module boundaries, data flow patterns' },
  convention:      { icon: '\u{1F4CF}', hint: 'Coding style, naming rules, file organization standards' },
  api:             { icon: '\u{1F50C}', hint: 'Endpoint contracts, request/response formats, auth' },
  decision:        { icon: '\u{2696}',  hint: 'Why a choice was made, trade-offs considered' },
  gotcha:          { icon: '\u{26A0}',  hint: 'Non-obvious pitfalls, things that break silently' },
  troubleshooting: { icon: '\u{1F527}', hint: 'How to diagnose and fix recurring issues' },
  dependency:      { icon: '\u{1F4E6}', hint: 'Library quirks, version constraints, upgrade notes' },
  process:         { icon: '\u{1F504}', hint: 'Workflow, deployment steps, review procedures' },
  reference:       { icon: '\u{1F4DA}', hint: 'General reference material, useful links' },
};

const SCOPE_META: Record<string, { label: string; description: string }> = {
  org:     { label: 'Organization', description: 'Applies across all projects' },
  project: { label: 'Project',      description: 'Specific to one project' },
};

export function KnowledgePage() {
  const [entries, setEntries] = useState<KnowledgeEntryInfo[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [filterScope, setFilterScope] = useState<string>('');
  const [filterCategory, setFilterCategory] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [flash, setFlash] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [selected, setSelected] = useState<KnowledgeEntryInfo | null>(null);
  const [actionLoading, setActionLoading] = useState('');

  // Contribute form
  const [showContribute, setShowContribute] = useState(false);
  const [contributing, setContributing] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [newScope, setNewScope] = useState<string>('org');
  const [newProjectId, setNewProjectId] = useState<string>('');
  const [newCategory, setNewCategory] = useState<string>('convention');
  const [newImportance, setNewImportance] = useState(5);
  const [newTags, setNewTags] = useState('');

  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const flash_msg = (type: 'success' | 'error', text: string) => {
    setFlash({ type, text });
    setTimeout(() => setFlash(null), 3000);
  };

  // Load projects once
  useEffect(() => {
    api.projects.list().then(r => {
      setProjects(r.projects);
      if (r.projects.length > 0) setNewProjectId(r.projects[0]!.id);
    }).catch(() => {});
  }, []);

  // Debounce search input
  useEffect(() => {
    debounceRef.current = setTimeout(() => setDebouncedQuery(searchQuery), 300);
    return () => clearTimeout(debounceRef.current);
  }, [searchQuery]);

  const refresh = useCallback(async () => {
    try {
      const { results } = await api.knowledge.search(
        debouncedQuery,
        filterScope || undefined,
        filterCategory || undefined,
      );
      setEntries(results);
    } catch { setEntries([]); }
    setLoading(false);
  }, [debouncedQuery, filterScope, filterCategory]);

  useEffect(() => { refresh(); }, [refresh]);

  const openContributeForm = () => {
    setNewTitle(''); setNewContent(''); setNewTags('');
    setNewScope('org'); setNewCategory('convention'); setNewImportance(5);
    if (projects.length > 0) setNewProjectId(projects[0]!.id);
    setShowContribute(true);
  };

  const handleContribute = async () => {
    if (!newTitle.trim() || !newContent.trim()) return;
    if (newScope === 'project' && !newProjectId) return;
    setContributing(true);
    try {
      const scopeId = newScope === 'project' ? newProjectId : 'default';
      await api.knowledge.contribute({
        title: newTitle,
        content: newContent,
        scope: newScope,
        scopeId,
        category: newCategory,
        importance: newImportance,
        tags: newTags.split(',').map(t => t.trim()).filter(Boolean),
      });
      setShowContribute(false);
      flash_msg('success', 'Knowledge entry added');
      refresh();
    } catch (e) { flash_msg('error', `Error: ${e}`); }
    setContributing(false);
  };

  const handleFlagOutdated = async (entry: KnowledgeEntryInfo) => {
    setActionLoading('flag');
    try {
      await api.knowledge.flagOutdated(entry.id, 'Marked outdated by user');
      flash_msg('success', 'Marked as outdated');
      setSelected({ ...entry, status: 'outdated' });
      refresh();
    } catch (e) { flash_msg('error', `Error: ${e}`); }
    setActionLoading('');
  };

  const handleVerify = async (entry: KnowledgeEntryInfo) => {
    setActionLoading('verify');
    try {
      await api.knowledge.verify(entry.id);
      flash_msg('success', 'Verified successfully');
      setSelected({ ...entry, status: 'verified' });
      refresh();
    } catch (e) { flash_msg('error', `Error: ${e}`); }
    setActionLoading('');
  };

  const handleDelete = async (entry: KnowledgeEntryInfo) => {
    setActionLoading('delete');
    try {
      await api.knowledge.remove(entry.id);
      flash_msg('success', 'Entry removed');
      setSelected(null);
      refresh();
    } catch (e) { flash_msg('error', `Error: ${e}`); }
    setActionLoading('');
  };

  const projectName = (scopeId: string) => projects.find(p => p.id === scopeId)?.name ?? scopeId;

  const scopeLabel = (entry: KnowledgeEntryInfo) =>
    entry.scope === 'project' ? `project: ${projectName(entry.scopeId)}` : entry.scope;

  return (
    <div className="flex-1 overflow-hidden flex">
      {/* Left: list */}
      <div className="w-96 border-r border-gray-800 flex flex-col bg-gray-950 shrink-0">
        <div className="p-4 border-b border-gray-800 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-300">Knowledge Base</h2>
            <button onClick={openContributeForm} className="text-xs px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors">+ Contribute</button>
          </div>
          <input
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search knowledge..."
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:border-indigo-500 focus:outline-none transition-colors"
          />
          <div className="flex gap-1.5 flex-wrap">
            <FilterPill label="All scopes" value="" current={filterScope} onClick={setFilterScope} />
            <FilterPill label="org" value="org" current={filterScope} onClick={setFilterScope} />
            <FilterPill label="project" value="project" current={filterScope} onClick={setFilterScope} />
          </div>
          <div className="flex gap-1.5 flex-wrap">
            <FilterPill label="All categories" value="" current={filterCategory} onClick={setFilterCategory} />
            {CATEGORIES.map(c => (
              <FilterPill key={c} label={`${CATEGORY_META[c]?.icon ?? ''} ${c}`} value={c} current={filterCategory} onClick={setFilterCategory} />
            ))}
          </div>
        </div>

        {flash && (
          <div className={`mx-4 mt-2 px-3 py-1.5 text-xs rounded-lg ${
            flash.type === 'success' ? 'bg-emerald-900/50 text-emerald-300' : 'bg-red-900/50 text-red-300'
          }`}>{flash.text}</div>
        )}

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {loading ? (
            <div className="p-4 space-y-3">
              {[1, 2, 3].map(i => (
                <div key={i} className="animate-pulse space-y-2">
                  <div className="h-4 bg-gray-800 rounded w-3/4" />
                  <div className="h-3 bg-gray-800 rounded w-1/2" />
                </div>
              ))}
            </div>
          ) : entries.length === 0 ? (
            <EmptyState hasFilters={!!(debouncedQuery || filterScope || filterCategory)} onContribute={openContributeForm} />
          ) : entries.map(entry => (
            <button
              key={entry.id}
              onClick={() => setSelected(entry)}
              className={`w-full text-left p-3 rounded-lg transition-colors ${
                selected?.id === entry.id ? 'bg-indigo-600/20 border border-indigo-500/30' : 'hover:bg-gray-800/60 border border-transparent'
              }`}
            >
              <div className="text-sm font-medium text-gray-200 truncate">{entry.title}</div>
              <div className="flex items-center gap-2 mt-1.5">
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${scopeColor(entry.scope)}`}>{scopeLabel(entry)}</span>
                <span className="text-[10px] text-gray-500">{CATEGORY_META[entry.category]?.icon ?? ''} {entry.category}</span>
                <StatusBadge status={entry.status} />
                {entry.importance >= 8 && <span className="text-[10px] text-amber-400" title={`Importance: ${entry.importance}`}>&#9733;</span>}
              </div>
            </button>
          ))}
          {!loading && entries.length > 0 && (
            <div className="text-center text-[10px] text-gray-600 py-2">{entries.length} entries</div>
          )}
        </div>
      </div>

      {/* Right: detail */}
      <div className="flex-1 overflow-y-auto">
        {!selected ? (
          <div className="flex-1 flex items-center justify-center h-full">
            <div className="text-center text-gray-600 space-y-2">
              <svg className="w-12 h-12 mx-auto text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
              </svg>
              <p className="text-sm">Select an entry to view details</p>
            </div>
          </div>
        ) : (
          <div className="p-6 max-w-3xl space-y-5">
            <div>
              <div className="flex items-start justify-between gap-4">
                <h2 className="text-xl font-semibold text-white">{selected.title}</h2>
                <div className="flex items-center gap-2 shrink-0">
                  {selected.status !== 'verified' && (
                    <button
                      onClick={() => handleVerify(selected)}
                      disabled={!!actionLoading}
                      className="px-3 py-1.5 text-xs rounded-lg bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/30 disabled:opacity-50 transition-colors"
                    >{actionLoading === 'verify' ? 'Verifying...' : 'Verify'}</button>
                  )}
                  {selected.status !== 'outdated' && (
                    <button
                      onClick={() => handleFlagOutdated(selected)}
                      disabled={!!actionLoading}
                      className="px-3 py-1.5 text-xs rounded-lg bg-amber-600/20 text-amber-400 hover:bg-amber-600/30 disabled:opacity-50 transition-colors"
                    >{actionLoading === 'flag' ? 'Flagging...' : 'Flag Outdated'}</button>
                  )}
                  <button
                    onClick={() => handleDelete(selected)}
                    disabled={!!actionLoading}
                    className="px-3 py-1.5 text-xs rounded-lg bg-red-600/20 text-red-400 hover:bg-red-600/30 disabled:opacity-50 transition-colors"
                  >{actionLoading === 'delete' ? 'Removing...' : 'Remove'}</button>
                </div>
              </div>
              <div className="flex items-center gap-3 mt-2 flex-wrap">
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${scopeColor(selected.scope)}`}>{scopeLabel(selected)}</span>
                <span className="px-2 py-0.5 rounded text-xs bg-gray-700 text-gray-400">{CATEGORY_META[selected.category]?.icon ?? ''} {selected.category}</span>
                <StatusBadge status={selected.status} />
                <span className="text-xs text-gray-600">importance: {selected.importance}/10</span>
                <span className="text-xs text-gray-600">accessed {selected.accessCount}x</span>
              </div>
            </div>

            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <MarkdownMessage content={selected.content} className="text-gray-300 text-sm" />
            </div>

            {selected.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {selected.tags.map(tag => (
                  <span key={tag} className="px-2 py-0.5 text-xs bg-gray-800 text-gray-400 rounded">{tag}</span>
                ))}
              </div>
            )}

            <div className="text-xs text-gray-600 space-y-1 border-t border-gray-800 pt-4">
              <div className="flex gap-6 flex-wrap">
                <span>Source: <span className="text-gray-400">{selected.source}</span></span>
                <span>Created: <span className="text-gray-400">{new Date(selected.createdAt).toLocaleString()}</span></span>
                <span>Updated: <span className="text-gray-400">{new Date(selected.updatedAt).toLocaleString()}</span></span>
              </div>
              <div className="text-gray-700 select-all">ID: {selected.id}</div>
            </div>
          </div>
        )}
      </div>

      {/* Contribute Modal */}
      {showContribute && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => !contributing && setShowContribute(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-[36rem] space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-white">Contribute Knowledge</h3>

            {/* Scope — radio buttons with descriptions */}
            <fieldset>
              <legend className="text-xs text-gray-500 mb-2">Visibility</legend>
              <div className="flex gap-3">
                {(['org', 'project'] as const).map(s => (
                  <label key={s}
                    className={`flex-1 flex items-start gap-2.5 p-3 rounded-lg border cursor-pointer transition-colors ${
                      newScope === s
                        ? 'border-indigo-500 bg-indigo-600/10'
                        : 'border-gray-700 bg-gray-800/50 hover:border-gray-600'
                    }`}
                  >
                    <input type="radio" name="scope" value={s} checked={newScope === s}
                      onChange={() => setNewScope(s)}
                      className="mt-0.5 accent-indigo-500" />
                    <div>
                      <div className="text-sm text-gray-200">{SCOPE_META[s]!.label}</div>
                      <div className="text-[11px] text-gray-500 mt-0.5">{SCOPE_META[s]!.description}</div>
                    </div>
                  </label>
                ))}
              </div>

              {/* Project picker — only when scope = project */}
              {newScope === 'project' && (
                <div className="mt-3">
                  {projects.length === 0 ? (
                    <p className="text-xs text-amber-400">No projects found. Create a project first.</p>
                  ) : (
                    <select value={newProjectId} onChange={e => setNewProjectId(e.target.value)}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200">
                      {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  )}
                </div>
              )}
            </fieldset>

            {/* Category */}
            <div>
              <label className="text-xs text-gray-500 block mb-1">Category</label>
              <select value={newCategory} onChange={e => setNewCategory(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200">
                {CATEGORIES.map(c => <option key={c} value={c}>{CATEGORY_META[c]!.icon} {c}</option>)}
              </select>
              <p className="text-[11px] text-gray-600 mt-1">{CATEGORY_META[newCategory]?.hint}</p>
            </div>

            {/* Title */}
            <div>
              <label className="text-xs text-gray-500 block mb-1">Title <span className="text-red-400">*</span></label>
              <input value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder="e.g. Use pnpm workspace protocol for local packages"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:border-indigo-500 focus:outline-none transition-colors" />
            </div>

            {/* Content */}
            <div>
              <label className="text-xs text-gray-500 block mb-1">Content <span className="text-red-400">*</span> <span className="text-gray-600">(Markdown)</span></label>
              <textarea value={newContent} onChange={e => setNewContent(e.target.value)}
                placeholder={"Describe the knowledge in detail.\n\nYou can use **markdown** formatting, `code`, lists, etc."}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 h-36 resize-none focus:border-indigo-500 focus:outline-none transition-colors font-mono" />
            </div>

            {/* Importance + Tags row */}
            <div className="flex gap-4">
              <div className="flex-1">
                <label className="text-xs text-gray-500 block mb-1">Tags <span className="text-gray-600">(comma separated)</span></label>
                <input value={newTags} onChange={e => setNewTags(e.target.value)} placeholder="react, performance, caching"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:border-indigo-500 focus:outline-none transition-colors" />
              </div>
              <div className="w-40 shrink-0">
                <label className="text-xs text-gray-500 block mb-1">Importance</label>
                <div className="flex items-center gap-2">
                  <input type="range" min={1} max={10} value={newImportance} onChange={e => setNewImportance(Number(e.target.value))}
                    className="flex-1 accent-indigo-500" />
                  <span className="text-sm font-medium text-indigo-400 bg-indigo-600/20 rounded px-2 py-0.5 min-w-[2rem] text-center">{newImportance}</span>
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-3 pt-1 border-t border-gray-800">
              <button onClick={() => setShowContribute(false)} disabled={contributing}
                className="text-sm text-gray-500 hover:text-gray-300 disabled:opacity-50 transition-colors py-2">Cancel</button>
              <button onClick={handleContribute}
                disabled={contributing || !newTitle.trim() || !newContent.trim() || (newScope === 'project' && !newProjectId)}
                className="btn-primary text-sm px-4 py-2 rounded-lg disabled:opacity-50 flex items-center gap-2 transition-colors">
                {contributing && <Spinner />}
                {contributing ? 'Saving...' : 'Contribute'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FilterPill({ label, value, current, onClick }: { label: string; value: string; current: string; onClick: (v: string) => void }) {
  return (
    <button
      onClick={() => onClick(current === value ? '' : value)}
      className={`px-2 py-1 rounded text-xs transition-colors ${
        current === value ? 'bg-indigo-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
      }`}
    >
      {label}
    </button>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls = status === 'verified'
    ? 'text-emerald-400 bg-emerald-900/30'
    : status === 'outdated'
    ? 'text-red-400 bg-red-900/30'
    : status === 'disputed'
    ? 'text-amber-400 bg-amber-900/30'
    : 'text-gray-500 bg-gray-800';
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${cls}`}>{status}</span>;
}

function EmptyState({ hasFilters, onContribute }: { hasFilters: boolean; onContribute: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
      <svg className="w-16 h-16 text-gray-700 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={0.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
      </svg>
      {hasFilters ? (
        <>
          <p className="text-sm text-gray-400 mb-1">No matching entries</p>
          <p className="text-xs text-gray-600">Try adjusting your search or filters</p>
        </>
      ) : (
        <>
          <p className="text-sm text-gray-400 mb-1">Knowledge Base is empty</p>
          <p className="text-xs text-gray-600 max-w-[240px] mb-4">
            Knowledge entries capture shared insights, conventions, and decisions that help agents and humans work more effectively.
          </p>
          <button onClick={onContribute} className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors">
            + Add first entry
          </button>
        </>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function scopeColor(scope: string): string {
  return scope === 'org' ? 'bg-purple-900/40 text-purple-300' : scope === 'project' ? 'bg-blue-900/40 text-blue-300' : 'bg-gray-700 text-gray-400';
}
