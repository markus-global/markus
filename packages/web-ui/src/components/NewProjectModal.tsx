import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { api, type ProjectInfo, type TeamInfo } from '../api.ts';
import { useIsMobile } from '../hooks/useIsMobile.ts';

interface Props {
  orgId?: string;
  onCreated: (project: ProjectInfo) => void;
  onClose: () => void;
}

export function NewProjectModal({ orgId, onCreated, onClose }: Props) {
  const { t } = useTranslation(['work', 'common']);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [teams, setTeams] = useState<TeamInfo[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [touched, setTouched] = useState(false);
  const isMobile = useIsMobile();

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
        repositories: repos.length > 0 ? repos : undefined,
        teamIds: teamIds.length > 0 ? teamIds : undefined,
        orgId: orgId ?? 'default',
      } as Partial<ProjectInfo>);
      onCreated(res.project);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('project.failedToCreate'));
    }
    setCreating(false);
  }, [name, description, repoUrl, defaultBranch, teamIds, orgId, creating, onCreated, t]);

  const nameInvalid = touched && !name.trim();

  return createPortal(
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-3" onClick={onClose}>
      <form
        className={`bg-surface-secondary border border-border-default rounded-xl p-6 shadow-2xl max-h-[90dvh] overflow-y-auto ${isMobile ? 'w-full' : 'w-[520px]'}`}
        onClick={e => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 className="text-base font-semibold mb-5">{t('project.newProject')}</h3>
        <div className="space-y-4">
          <div>
            <label className="block text-xs text-fg-secondary mb-1.5 font-medium">{t('project.projectName')}</label>
            <input
              value={name}
              onChange={e => { setName(e.target.value); setError(''); }}
              onBlur={() => setTouched(true)}
              placeholder={t('project.projectNamePlaceholder')}
              className={`input ${nameInvalid ? '!border-red-500 focus:!ring-red-500/25' : ''}`}
              autoFocus={!isMobile}
            />
            {nameInvalid && <p className="text-[11px] text-red-400 mt-1">{t('project.projectNameRequired')}</p>}
          </div>

          <div>
            <label className="block text-xs text-fg-secondary mb-1.5 font-medium">{t('project.description')}</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder={t('project.descriptionPlaceholder')}
              className="input"
              rows={3}
            />
          </div>

          <div>
            <label className="block text-xs text-fg-secondary mb-1.5 font-medium">{t('project.assignTeams')}</label>
            {teams.length === 0 ? (
              <div className="text-[11px] text-fg-tertiary py-2">{t('project.noTeamsAvailable')}</div>
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

          <div className="grid grid-cols-[1fr_auto] gap-3">
            <div>
              <label className="block text-xs text-fg-secondary mb-1.5 font-medium">{t('project.repositoryUrl')}</label>
              <input
                value={repoUrl}
                onChange={e => setRepoUrl(e.target.value)}
                placeholder={t('project.repositoryPlaceholder')}
                className="input"
              />
            </div>
            {repoUrl.trim() && (
              <div>
                <label className="block text-xs text-fg-secondary mb-1.5 font-medium">{t('project.branch')}</label>
                <input
                  value={defaultBranch}
                  onChange={e => setDefaultBranch(e.target.value)}
                  placeholder={t('project.branchPlaceholder')}
                  className="input !w-24"
                />
              </div>
            )}
          </div>

          {error && (
            <div className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">{error}</div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm border border-border-default rounded-lg hover:bg-surface-elevated text-fg-secondary">{t('common:cancel')}</button>
            <button
              type="submit"
              disabled={!name.trim() || creating}
              className="px-4 py-2 text-sm bg-brand-600 hover:bg-brand-500 disabled:opacity-40 rounded-lg text-white"
            >
              {creating ? t('common:creating') : t('project.createProject')}
            </button>
          </div>
        </div>
      </form>
    </div>,
    document.body,
  );
}
