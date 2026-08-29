import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type DeliverableInfo, type ProjectInfo } from '../api.ts';
import { navBus } from '../navBus.ts';
import { PAGE } from '../routes.ts';

/**
 * 项目详情「知识库」区块（需求 A / V2 架构）。
 * - 绑定/移除知识库根目录（knowledgeBasePaths）
 * - 「重新同步」→ POST /projects/:id/knowledge/sync → upsert source='knowledge' 交付物
 * - 列出项目知识库文件（复用交付物列表），点击 → 产出物页面筛选预览
 * - 「在产出物中查看」→ 导航 Deliverables（project + source=knowledge）
 */
export function ProjectKnowledgePanel({ project, onUpdateProject }: {
  project: ProjectInfo;
  onUpdateProject: (data: Partial<ProjectInfo>) => Promise<void>;
}) {
  const { t } = useTranslation(['work', 'common']);
  const paths = project.knowledgeBasePaths ?? [];
  const [draftPath, setDraftPath] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [docs, setDocs] = useState<DeliverableInfo[]>([]);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const loadDocs = useCallback(async () => {
    if (!project.id) return;
    setLoadingDocs(true);
    try {
      const { results } = await api.deliverables.search({ projectId: project.id, source: 'knowledge', limit: 200 });
      setDocs(results);
    } catch (err) {
      setNotice({ type: 'error', text: `${t('work:project.kbLoadFailed')}: ${String(err)}` });
    } finally {
      setLoadingDocs(false);
    }
  }, [project.id, t]);

  useEffect(() => { void loadDocs(); }, [loadDocs]);

  const handleAddPath = async () => {
    const p = draftPath.trim();
    if (!p) return;
    const next = [...new Set([...paths, p])];
    await onUpdateProject({ knowledgeBasePaths: next });
    setDraftPath('');
    setNotice({ type: 'success', text: t('work:project.kbPathsSaved') });
  };

  const handleRemovePath = async (path: string) => {
    await onUpdateProject({ knowledgeBasePaths: paths.filter(x => x !== path) });
    setNotice({ type: 'success', text: t('work:project.kbPathsSaved') });
  };

  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    setNotice(null);
    try {
      const res = await api.projects.syncKnowledge(project.id, paths.length ? paths : undefined);
      setNotice({
        type: res.errors.length > 0 ? 'error' : 'success',
        text: t('work:project.kbSyncResult', {
          scanned: res.scanned,
          registered: res.registered,
          updated: res.updated,
          outdated: res.outdated,
          errors: res.errors.length,
        }),
      });
      await loadDocs();
    } catch (err) {
      setNotice({ type: 'error', text: `${t('work:project.kbSyncFailed')}: ${String(err)}` });
    } finally {
      setSyncing(false);
    }
  };

  const openInDeliverables = (deliverableId?: string) => {
    navBus.navigate(PAGE.DELIVERABLES, {
      projectId: project.id,
      source: 'knowledge',
      ...(deliverableId ? { openDeliverable: deliverableId } : {}),
    });
  };

  return (
    <div className="bg-surface-elevated rounded-xl p-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h4 className="text-xs font-semibold text-fg-secondary">{t('work:project.kbHeading')}</h4>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => openInDeliverables()}
            className="text-[10px] px-2 py-1 rounded-md text-fg-tertiary hover:text-brand-500 hover:bg-surface-overlay transition-colors"
          >
            {t('work:project.kbOpenInDeliverables')}
          </button>
          <button
            type="button"
            onClick={handleSync}
            disabled={syncing || paths.length === 0}
            className="text-[10px] px-2 py-1 rounded-md bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {syncing ? t('work:project.kbSyncing') : t('work:project.kbSync')}
          </button>
        </div>
      </div>

      {/* Bound paths */}
      <div className="space-y-1.5 mb-3">
        {paths.length === 0 && (
          <p className="text-[11px] text-fg-tertiary">{t('work:project.kbNoPaths')}</p>
        )}
        {paths.map((p, i) => (
          <div key={`${p}-${i}`} className="flex items-center gap-2 group">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-fg-tertiary shrink-0">
              <path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z" />
            </svg>
            <span className="text-xs text-fg-secondary flex-1 min-w-0 truncate font-mono" title={p}>{p}</span>
            <button
              type="button"
              onClick={() => handleRemovePath(p)}
              className="text-fg-tertiary hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
              title={t('work:project.removeRepo')}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          </div>
        ))}
        <div className="flex gap-2">
          <input
            value={draftPath}
            onChange={e => setDraftPath(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void handleAddPath(); }}
            placeholder={t('work:project.kbPathPlaceholder')}
            className="flex-1 px-2.5 py-1.5 text-xs bg-surface-primary border border-border-default rounded-md text-fg-primary placeholder:text-fg-tertiary"
          />
          <button
            type="button"
            onClick={handleAddPath}
            disabled={!draftPath.trim()}
            className="px-2.5 py-1.5 text-xs bg-surface-overlay text-fg-secondary hover:text-fg-primary rounded-md disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {t('work:project.kbAdd')}
          </button>
        </div>
      </div>

      {notice && (
        <div className={`mb-2 px-2.5 py-1.5 text-[11px] rounded-md ${notice.type === 'success' ? 'bg-green-500/15 text-green-600' : 'bg-red-500/15 text-red-500'}`}>
          {notice.text}
        </div>
      )}

      {/* Knowledge documents (source='knowledge' deliverables) */}
      <div className="border-t border-border-default/60 pt-3">
        <h5 className="text-[11px] font-medium text-fg-tertiary mb-2">
          {t('work:project.kbDocsHeading')}{docs.length > 0 && <span className="ml-1 text-fg-quaternary">({docs.length})</span>}
        </h5>
        {loadingDocs ? (
          <p className="text-[11px] text-fg-tertiary">{t('work:project.kbLoadingDocs')}</p>
        ) : docs.length === 0 ? (
          <p className="text-[11px] text-fg-tertiary">{t('work:project.kbNoDocs')}</p>
        ) : (
          <div className="max-h-64 overflow-y-auto space-y-0.5">
            {docs.map(d => (
              <button
                key={d.id}
                type="button"
                onClick={() => openInDeliverables(d.id)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left hover:bg-surface-overlay transition-colors group"
                title={d.reference ?? d.title}
              >
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-overlay text-fg-tertiary shrink-0 uppercase">{d.format ?? 'file'}</span>
                <span className="text-xs text-fg-secondary truncate flex-1 min-w-0 group-hover:text-brand-500">{d.title}</span>
                <span className="text-[10px] text-fg-quaternary shrink-0">→</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}