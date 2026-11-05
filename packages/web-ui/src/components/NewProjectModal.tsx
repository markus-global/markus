import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { api, type ProjectInfo } from '../api.ts';
import { useIsMobile } from '../hooks/useIsMobile.ts';
import { useNativeBrowserOverlay } from '../hooks/useNativeBrowserOverlay.ts';
import { ROW_GRID_CLS, ROW_LABEL_CLS, ROW_INPUT_CLS } from '../lib/dialogStyles.ts';

interface Props {
  orgId?: string;
  onCreated: (project: ProjectInfo) => void;
  onClose: () => void;
}

// A project location may be a local directory (/Users/me/app) or a remote Git
// repository (https://github.com/org/repo). They land in different fields so the
// consumers of `repositories` (agent task context, project-tools) read the right
// one — previously the modal sent `url` while every consumer read `localPath`,
// so a typed location was silently dropped.
function isRemoteUrl(v: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/i.test(v);
}

export function NewProjectModal({ orgId, onCreated, onClose }: Props) {
  const { t } = useTranslation(['work', 'common']);
  useNativeBrowserOverlay(true);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [touched, setTouched] = useState(false);
  const isMobile = useIsMobile();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleSubmit = useCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    setTouched(true);
    if (!name.trim() || creating) return;
    setCreating(true);
    setError('');
    try {
      const loc = repoUrl.trim();
      const repos = loc
        ? [{
            ...(isRemoteUrl(loc) ? { url: loc } : { localPath: loc }),
            defaultBranch: defaultBranch.trim() || 'main',
            role: 'primary' as const,
          }]
        : [];
      const res = await api.projects.create({
        name: name.trim(),
        description: description.trim() || undefined,
        repositories: repos.length > 0 ? repos : undefined,
        orgId: orgId ?? 'default',
      } as Partial<ProjectInfo>);
      onCreated(res.project);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('project.failedToCreate'));
    }
    setCreating(false);
  }, [name, description, repoUrl, defaultBranch, orgId, creating, onCreated, t]);

  const nameInvalid = touched && !name.trim();

  return createPortal(
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-3" onClick={onClose}>
      <form
        className={`bg-surface-secondary border border-border-default rounded-xl p-6 shadow-2xl max-h-[90dvh] overflow-y-auto space-y-4 ${isMobile ? 'w-full' : 'w-[26rem]'}`}
        onClick={e => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 className="text-base font-semibold text-fg-primary">{t('project.newProject')}</h3>

        <div className={ROW_GRID_CLS}>
          <label className={ROW_LABEL_CLS}>{t('project.projectName')}</label>
          <div>
            <input
              value={name}
              onChange={e => { setName(e.target.value); setError(''); }}
              onBlur={() => setTouched(true)}
              placeholder={t('project.projectNamePlaceholder')}
              className={`${ROW_INPUT_CLS} ${nameInvalid ? '!border-red-500' : ''}`}
              autoFocus={!isMobile}
            />
            {nameInvalid && <p className="text-[11px] text-red-400 mt-1">{t('project.projectNameRequired')}</p>}
          </div>

          <label className={ROW_LABEL_CLS}>{t('project.description')}</label>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder={t('project.descriptionPlaceholder')}
            className={`${ROW_INPUT_CLS} resize-none`}
            rows={2}
          />

          <label className={ROW_LABEL_CLS}>{t('project.repositoryUrl')}</label>
          <input
            value={repoUrl}
            onChange={e => setRepoUrl(e.target.value)}
            placeholder={t('project.repositoryPlaceholder')}
            className={`${ROW_INPUT_CLS} placeholder:text-[11px]`}
          />

          {repoUrl.trim() && (
            <>
              <label className={ROW_LABEL_CLS}>{t('project.branch')}</label>
              <input
                value={defaultBranch}
                onChange={e => setDefaultBranch(e.target.value)}
                placeholder={t('project.branchPlaceholder')}
                className={ROW_INPUT_CLS}
              />
            </>
          )}
        </div>

        {error && (
          <div className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">{error}</div>
        )}

        <div className="flex justify-end gap-3 pt-1">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm border border-border-default rounded-lg hover:bg-surface-elevated text-fg-secondary">{t('common:cancel')}</button>
          <button
            type="submit"
            disabled={!name.trim() || creating}
            className="px-4 py-2 text-sm bg-brand-600 hover:bg-brand-500 disabled:opacity-40 rounded-lg text-on-brand"
          >
            {creating ? t('common:creating') : t('project.createProject')}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
