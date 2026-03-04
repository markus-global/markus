import { useState, useEffect, useCallback } from 'react';
import { api, type KnowledgeEntryInfo } from '../api.ts';

const CATEGORIES = ['guideline', 'decision', 'pattern', 'lesson_learned', 'faq', 'reference', 'convention', 'other'] as const;
const SCOPES = ['org', 'project', 'personal'] as const;

export function KnowledgePage() {
  const [entries, setEntries] = useState<KnowledgeEntryInfo[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterScope, setFilterScope] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [flash, setFlash] = useState('');
  const [selected, setSelected] = useState<KnowledgeEntryInfo | null>(null);

  // Contribute form
  const [showContribute, setShowContribute] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [newScope, setNewScope] = useState<string>('org');
  const [newCategory, setNewCategory] = useState<string>('guideline');
  const [newTags, setNewTags] = useState('');

  const msg = (m: string) => { setFlash(m); setTimeout(() => setFlash(''), 3000); };

  const refresh = useCallback(async () => {
    try {
      if (searchQuery.trim()) {
        const { results } = await api.knowledge.search(searchQuery, filterScope || undefined);
        setEntries(results);
      } else {
        const { results } = await api.knowledge.search('', filterScope || undefined);
        setEntries(results);
      }
    } catch { setEntries([]); }
    setLoading(false);
  }, [searchQuery, filterScope]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleContribute = async () => {
    if (!newTitle.trim() || !newContent.trim()) return;
    try {
      await api.knowledge.contribute({
        title: newTitle,
        content: newContent,
        scope: newScope,
        category: newCategory,
        tags: newTags.split(',').map(t => t.trim()).filter(Boolean),
      } as Partial<KnowledgeEntryInfo>);
      setShowContribute(false);
      setNewTitle(''); setNewContent(''); setNewTags('');
      msg('Knowledge entry added');
      refresh();
    } catch (e) { msg(`Error: ${e}`); }
  };

  return (
    <div className="flex-1 overflow-hidden flex">
      {/* Left: list */}
      <div className="w-96 border-r border-gray-800 flex flex-col bg-gray-950">
        <div className="p-4 border-b border-gray-800 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-300">Knowledge Base</h2>
            <button onClick={() => setShowContribute(true)} className="text-xs px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white">+ Contribute</button>
          </div>
          <input
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search knowledge…"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200"
          />
          <div className="flex gap-1.5">
            <ScopeFilter label="All" value="" current={filterScope} onClick={setFilterScope} />
            {SCOPES.map(s => <ScopeFilter key={s} label={s} value={s} current={filterScope} onClick={setFilterScope} />)}
          </div>
        </div>

        {flash && <div className="mx-4 mt-2 px-3 py-1.5 bg-emerald-900/50 text-emerald-300 text-xs rounded-lg">{flash}</div>}

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {loading ? (
            <p className="text-xs text-gray-600 p-3 animate-pulse">Loading…</p>
          ) : entries.length === 0 ? (
            <p className="text-xs text-gray-600 p-3">No entries found.</p>
          ) : entries.map(entry => (
            <button
              key={entry.id}
              onClick={() => setSelected(entry)}
              className={`w-full text-left p-3 rounded-lg transition-colors ${
                selected?.id === entry.id ? 'bg-indigo-600/20 border border-indigo-500/30' : 'hover:bg-gray-800/60'
              }`}
            >
              <div className="text-sm font-medium text-gray-200 truncate">{entry.title}</div>
              <div className="flex items-center gap-2 mt-1">
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${scopeColor(entry.scope)}`}>{entry.scope}</span>
                <span className="text-[10px] text-gray-600">{entry.category}</span>
                <span className={`text-[10px] ${entry.status === 'verified' ? 'text-emerald-500' : entry.status === 'outdated' ? 'text-red-400' : 'text-gray-500'}`}>{entry.status}</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Right: detail */}
      <div className="flex-1 overflow-y-auto">
        {!selected ? (
          <div className="flex-1 flex items-center justify-center h-full text-gray-600 text-sm">
            Select a knowledge entry to view details
          </div>
        ) : (
          <div className="p-6 max-w-3xl space-y-5">
            <div>
              <h2 className="text-xl font-semibold text-white">{selected.title}</h2>
              <div className="flex items-center gap-3 mt-2">
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${scopeColor(selected.scope)}`}>{selected.scope}</span>
                <span className="px-2 py-0.5 rounded text-xs bg-gray-700 text-gray-400">{selected.category}</span>
                <span className={`text-xs ${selected.status === 'verified' ? 'text-emerald-400' : 'text-gray-500'}`}>{selected.status}</span>
                <span className="text-xs text-gray-600">accessed {selected.accessCount}x</span>
              </div>
            </div>

            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <div className="prose prose-sm prose-invert max-w-none text-gray-300 whitespace-pre-wrap">
                {selected.content}
              </div>
            </div>

            {selected.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {selected.tags.map(tag => (
                  <span key={tag} className="px-2 py-0.5 text-xs bg-gray-800 text-gray-400 rounded">{tag}</span>
                ))}
              </div>
            )}

            <div className="text-xs text-gray-600 space-y-1">
              <div>Source: {selected.source}</div>
              <div>Created: {new Date(selected.createdAt).toLocaleString()}</div>
              <div>Updated: {new Date(selected.updatedAt).toLocaleString()}</div>
              <div>ID: {selected.id}</div>
            </div>
          </div>
        )}
      </div>

      {/* Contribute Modal */}
      {showContribute && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-[32rem] space-y-4">
            <h3 className="text-base font-semibold text-white">Contribute Knowledge</h3>
            <input value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder="Title" className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200" />
            <textarea value={newContent} onChange={e => setNewContent(e.target.value)} placeholder="Content" className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 h-32 resize-none" />
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="text-xs text-gray-500 block mb-1">Scope</label>
                <select value={newScope} onChange={e => setNewScope(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200">
                  {SCOPES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div className="flex-1">
                <label className="text-xs text-gray-500 block mb-1">Category</label>
                <select value={newCategory} onChange={e => setNewCategory(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200">
                  {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>
            <input value={newTags} onChange={e => setNewTags(e.target.value)} placeholder="Tags (comma separated)" className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200" />
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowContribute(false)} className="text-sm text-gray-500 hover:text-gray-300">Cancel</button>
              <button onClick={handleContribute} className="btn-primary text-sm px-4 py-2 rounded-lg">Contribute</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ScopeFilter({ label, value, current, onClick }: { label: string; value: string; current: string; onClick: (v: string) => void }) {
  return (
    <button
      onClick={() => onClick(value)}
      className={`px-2 py-1 rounded text-xs transition-colors ${
        current === value ? 'bg-indigo-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
      }`}
    >
      {label}
    </button>
  );
}

function scopeColor(scope: string): string {
  return scope === 'org' ? 'bg-purple-900/40 text-purple-300' : scope === 'project' ? 'bg-blue-900/40 text-blue-300' : 'bg-gray-700 text-gray-400';
}
