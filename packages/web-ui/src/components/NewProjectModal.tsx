import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { api, type ProjectInfo, type TeamInfo } from '../api.ts';

interface Props {
  orgId?: string;
  onCreated: (project: ProjectInfo) => void;
  onClose: () => void;
}

export function NewProjectModal({ orgId, onCreated, onClose }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [iterationModel, setIterationModel] = useState<'kanban' | 'sprint'>('kanban');
  const [repoUrl, setRepoUrl] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [teams, setTeams] = useState<TeamInfo[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    api.teams.list().then(d => setTeams(d.teams)).catch(() => {});
  }, []);

  const handleSubmit = useCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    setTouched(true);
    if (!name.trim() || creating) return;
    setCreating(true);
    setError('');
    try {
      const repos = repoUrl.trim()
        ? [{ url: repoUrl.trim(), defaultBranch: defaultBranch.trim() || 'main' }]
        : [];
      const res = await api.projects.create({
        name: name.trim(),
        description: description.trim() || undefined,
        iterationModel,
        repositories: repos.length > 0 ? repos : undefined,
        teamIds: teamIds.length > 0 ? teamIds : undefined,
        orgId: orgId ?? 'default',
      } as Partial<ProjectInfo>);
      onCreated(res.project);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project');
    }
    setCreating(false);
  }, [name, description, iterationModel, repoUrl, defaultBranch, teamIds, orgId, creating, onCreated]);

  const nameInvalid = touched && !name.trim();

  return createPortal(
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <form
        className="bg-surface-secondary border border-border-default rounded-xl p-6 w-[520px] shadow-2xl max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 className="text-base font-semibold mb-5">New Project</h3>
        <div className="space-y-4">
          <div>
            <label className="block text-xs text-fg-secondary mb-1.5 font-medium">Project Name *</label>
            <input
              value={name}
              onChange={e => { setName(e.target.value); setError(''); }}
              onBlur={() => setTouched(true)}
              placeholder="e.g. Mobile App, Website Redesign"
              className={`input ${nameInvalid ? '!border-red-500 focus:!ring-red-500/25' : ''}`}
              autoFocus
            />
            {nameInvalid && <p className="text-[11px] text-red-400 mt-1">Project name is required</p>}
          </div>

          <div>
            <label className="block text-xs text-fg-secondary mb-1.5 font-medium">Description</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="What is this project about?"
              className="input"
              rows={3}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-fg-secondary mb-1.5 font-medium">Iteration Model</label>
              <div className="flex gap-2">
                {(['kanban', 'sprint'] as const).map(model => (
                  <button
                    key={model}
                    type="button"
                    onClick={() => setIterationModel(model)}
                    className={`flex-1 py-2 text-xs rounded-lg border transition-colors ${
                      iterationModel === model
                        ? 'border-brand-500 bg-brand-600/15 text-brand-300'
                        : 'border-border-default text-fg-tertiary hover:border-gray-600'
                    }`}
                  >
                    {model === 'kanban' ? 'Kanban' : 'Sprint'}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-xs text-fg-secondary mb-1.5 font-medium">Assign Teams</label>
              {teams.length === 0 ? (
                <div className="text-[11px] text-fg-tertiary py-2">No teams available</div>
              ) : (
                <div className="space-y-1 max-h-32 overflow-y-auto">
                  {teams.map(t => {
                    const checked = teamIds.includes(t.id);
                    return (
                      <label key={t.id} className="flex items-center gap-2 text-xs text-fg-secondary cursor-pointer hover:text-fg-primary py-0.5">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => setTeamIds(prev =>
                            checked ? prev.filter(id => id !== t.id) : [...prev, t.id]
                          )}
                          className="accent-brand-500"
                        />
                        <span className="truncate">{t.name}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-[1fr_auto] gap-3">
            <div>
              <label className="block text-xs text-fg-secondary mb-1.5 font-medium">Repository URL</label>
              <input
                value={repoUrl}
                onChange={e => setRepoUrl(e.target.value)}
                placeholder="https://github.com/org/repo (optional)"
                className="input"
              />
            </div>
            {repoUrl.trim() && (
              <div>
                <label className="block text-xs text-fg-secondary mb-1.5 font-medium">Branch</label>
                <input
                  value={defaultBranch}
                  onChange={e => setDefaultBranch(e.target.value)}
                  placeholder="main"
                  className="input !w-24"
                />
              </div>
            )}
          </div>

          {error && (
            <div className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">{error}</div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm border border-border-default rounded-lg hover:bg-surface-elevated text-fg-secondary">Cancel</button>
            <button
              type="submit"
              disabled={!name.trim() || creating}
              className="px-4 py-2 text-sm bg-brand-600 hover:bg-brand-500 disabled:opacity-40 rounded-lg text-white"
            >
              {creating ? 'Creating...' : 'Create Project'}
            </button>
          </div>
        </div>
      </form>
    </div>,
    document.body,
  );
}
