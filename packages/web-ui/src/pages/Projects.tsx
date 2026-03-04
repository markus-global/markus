import { useState, useEffect, useCallback } from 'react';
import { api, type ProjectInfo, type IterationInfo } from '../api.ts';

export function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [selected, setSelected] = useState<ProjectInfo | null>(null);
  const [iterations, setIterations] = useState<IterationInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [flash, setFlash] = useState('');

  // Create project form
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newRepo, setNewRepo] = useState('');

  // Create iteration form
  const [showCreateIter, setShowCreateIter] = useState(false);
  const [iterName, setIterName] = useState('');
  const [iterGoal, setIterGoal] = useState('');
  const [iterStart, setIterStart] = useState('');
  const [iterEnd, setIterEnd] = useState('');

  const msg = (m: string) => { setFlash(m); setTimeout(() => setFlash(''), 3000); };

  const refresh = useCallback(async () => {
    try {
      const { projects: p } = await api.projects.list();
      setProjects(p);
      if (selected) {
        const updated = p.find(x => x.id === selected.id);
        if (updated) setSelected(updated);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [selected]);

  const loadIterations = useCallback(async (projectId: string) => {
    try {
      const { iterations: it } = await api.projects.listIterations(projectId);
      setIterations(it);
    } catch { setIterations([]); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { if (selected) loadIterations(selected.id); }, [selected, loadIterations]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    try {
      const repos = newRepo.trim() ? [{ url: newRepo, defaultBranch: 'main' }] : [];
      const { project } = await api.projects.create({ name: newName, description: newDesc, orgId: 'default', repositories: repos } as Partial<ProjectInfo>);
      setShowCreate(false);
      setNewName(''); setNewDesc(''); setNewRepo('');
      msg('Project created');
      await refresh();
      setSelected(project);
    } catch (e) { msg(`Error: ${e}`); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this project?')) return;
    try {
      await api.projects.delete(id);
      if (selected?.id === id) { setSelected(null); setIterations([]); }
      msg('Project deleted');
      refresh();
    } catch (e) { msg(`Error: ${e}`); }
  };

  const handleCreateIteration = async () => {
    if (!selected || !iterName.trim()) return;
    try {
      await api.projects.createIteration(selected.id, { name: iterName, goal: iterGoal, startDate: iterStart || undefined, endDate: iterEnd || undefined } as Partial<IterationInfo>);
      setShowCreateIter(false);
      setIterName(''); setIterGoal(''); setIterStart(''); setIterEnd('');
      msg('Iteration created');
      loadIterations(selected.id);
    } catch (e) { msg(`Error: ${e}`); }
  };

  const handleIterStatus = async (iterId: string, status: string) => {
    try {
      await api.projects.updateIterationStatus(iterId, status);
      msg(`Iteration ${status}`);
      if (selected) loadIterations(selected.id);
    } catch (e) { msg(`Error: ${e}`); }
  };

  if (loading) return <div className="flex-1 flex items-center justify-center text-gray-500">Loading…</div>;

  return (
    <div className="flex-1 overflow-hidden flex">
      {/* Project List (left) */}
      <div className="w-80 border-r border-gray-800 flex flex-col bg-gray-950">
        <div className="p-4 border-b border-gray-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-300">Projects</h2>
          <button onClick={() => setShowCreate(true)} className="text-xs px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white">+ New</button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {projects.length === 0 ? (
            <p className="text-xs text-gray-600 p-3">No projects yet.</p>
          ) : projects.map(p => (
            <button
              key={p.id}
              onClick={() => setSelected(p)}
              className={`w-full text-left p-3 rounded-lg transition-colors ${
                selected?.id === p.id ? 'bg-indigo-600/20 border border-indigo-500/30' : 'hover:bg-gray-800/60'
              }`}
            >
              <div className="text-sm font-medium text-gray-200 truncate">{p.name}</div>
              <div className="text-[10px] text-gray-500 mt-0.5 flex items-center gap-2">
                <IterModelBadge model={p.iterationModel} />
                <span>{p.teamIds.length} team{p.teamIds.length !== 1 ? 's' : ''}</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Detail (right) */}
      <div className="flex-1 overflow-y-auto">
        {flash && <div className="mx-6 mt-3 px-3 py-1.5 bg-emerald-900/50 text-emerald-300 text-xs rounded-lg">{flash}</div>}

        {!selected ? (
          <div className="flex-1 flex items-center justify-center h-full text-gray-600 text-sm">
            Select a project or create a new one
          </div>
        ) : (
          <div className="p-6 space-y-6 max-w-4xl">
            {/* Project Header */}
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-xl font-semibold text-white">{selected.name}</h2>
                {selected.description && <p className="text-sm text-gray-400 mt-1">{selected.description}</p>}
                <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
                  <span>ID: {selected.id}</span>
                  <IterModelBadge model={selected.iterationModel} />
                  <StatusPill status={selected.status} />
                </div>
              </div>
              <button onClick={() => handleDelete(selected.id)} className="text-xs text-red-400 hover:text-red-300">Delete</button>
            </div>

            {/* Repositories */}
            {selected.repositories && selected.repositories.length > 0 && (
              <section className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <h3 className="text-xs font-semibold text-gray-400 mb-2">Repositories</h3>
                {selected.repositories.map((r, i) => (
                  <div key={i} className="text-sm text-gray-300 flex items-center gap-2">
                    <span className="text-gray-600">⎇</span>
                    <span>{r.url || r.localPath}</span>
                    <span className="text-xs text-gray-600">({r.defaultBranch})</span>
                  </div>
                ))}
              </section>
            )}

            {/* Iterations */}
            <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-gray-300">Iterations</h3>
                <button onClick={() => setShowCreateIter(true)} className="text-xs px-2.5 py-1 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300">+ Add Iteration</button>
              </div>

              {showCreateIter && (
                <div className="mb-4 p-4 bg-gray-800 rounded-lg space-y-3">
                  <input value={iterName} onChange={e => setIterName(e.target.value)} placeholder="Iteration name (e.g. Sprint 1)" className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-200" />
                  <input value={iterGoal} onChange={e => setIterGoal(e.target.value)} placeholder="Goal" className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-200" />
                  <div className="flex gap-3">
                    <input type="date" value={iterStart} onChange={e => setIterStart(e.target.value)} className="bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-200" />
                    <input type="date" value={iterEnd} onChange={e => setIterEnd(e.target.value)} className="bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-200" />
                  </div>
                  <div className="flex gap-3">
                    <button onClick={handleCreateIteration} className="btn-primary text-sm px-4 py-2 rounded-lg">Create</button>
                    <button onClick={() => setShowCreateIter(false)} className="text-sm text-gray-500">Cancel</button>
                  </div>
                </div>
              )}

              {iterations.length === 0 ? (
                <p className="text-sm text-gray-500">No iterations yet.</p>
              ) : (
                <div className="space-y-2">
                  {iterations.map(it => (
                    <div key={it.id} className="p-3 bg-gray-800/50 rounded-lg flex items-center justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-gray-200">{it.name}</div>
                        {it.goal && <div className="text-xs text-gray-400 mt-0.5">{it.goal}</div>}
                        <div className="text-[10px] text-gray-600 mt-1 flex items-center gap-2">
                          <StatusPill status={it.status} />
                          {it.startDate && <span>{it.startDate} → {it.endDate || '?'}</span>}
                        </div>
                      </div>
                      <div className="flex gap-1.5 ml-3">
                        {it.status === 'planning' && (
                          <button onClick={() => handleIterStatus(it.id, 'active')} className="text-xs px-2 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-white">Start</button>
                        )}
                        {it.status === 'active' && (
                          <button onClick={() => handleIterStatus(it.id, 'review')} className="text-xs px-2 py-1 rounded bg-indigo-700 hover:bg-indigo-600 text-white">Review</button>
                        )}
                        {it.status === 'review' && (
                          <button onClick={() => handleIterStatus(it.id, 'completed')} className="text-xs px-2 py-1 rounded bg-gray-600 hover:bg-gray-500 text-white">Complete</button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </div>

      {/* Create Project Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-[28rem] space-y-4">
            <h3 className="text-base font-semibold text-white">New Project</h3>
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Project name" className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200" />
            <textarea value={newDesc} onChange={e => setNewDesc(e.target.value)} placeholder="Description (optional)" className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 h-20 resize-none" />
            <input value={newRepo} onChange={e => setNewRepo(e.target.value)} placeholder="Repository URL (optional)" className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200" />
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowCreate(false)} className="text-sm text-gray-500 hover:text-gray-300">Cancel</button>
              <button onClick={handleCreate} className="btn-primary text-sm px-4 py-2 rounded-lg">Create Project</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function IterModelBadge({ model }: { model: string }) {
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
      model === 'scrum' ? 'bg-indigo-900/40 text-indigo-300' : 'bg-gray-700 text-gray-400'
    }`}>
      {model}
    </span>
  );
}

function StatusPill({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: 'bg-emerald-900/40 text-emerald-400',
    planning: 'bg-blue-900/40 text-blue-400',
    review: 'bg-amber-900/40 text-amber-400',
    completed: 'bg-gray-700 text-gray-400',
    archived: 'bg-gray-800 text-gray-500',
  };
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${colors[status] ?? 'bg-gray-700 text-gray-400'}`}>
      {status}
    </span>
  );
}
