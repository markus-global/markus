import { Suspense, lazy, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.ts';
import type { DeliverableInfo } from '../api.ts';

const LazyMarkdownMessage = lazy(() => import('./MarkdownMessage.tsx').then(m => ({ default: m.MarkdownMessage })));

export const DELIVERABLE_TYPE_META: Record<string, { icon: string; color: string }> = {
  file:      { icon: '📄', color: 'bg-green-500/10 text-green-600' },
  directory: { icon: '📁', color: 'bg-blue-500/10 text-blue-600' },
};

export const DELIVERABLE_STATUS_META: Record<string, { color: string }> = {
  active:   { color: 'text-green-600 bg-green-500/10' },
  verified: { color: 'text-blue-600 bg-blue-500/10' },
  outdated: { color: 'text-fg-tertiary bg-surface-elevated/50' },
};

/**
 * Modal showing a deliverable's details. Extracted from AgentProfile so it can be
 * reused by inline/block deliverable cards rendered inside chat markdown.
 */
export function DeliverableDetailModal({ item, onClose, onOpenInPage }: {
  item: DeliverableInfo;
  onClose: () => void;
  onOpenInPage: (id: string) => void;
}) {
  const { t } = useTranslation(['agent', 'common']);
  const typeMeta = DELIVERABLE_TYPE_META[item.type] ?? { icon: '📎', color: 'bg-surface-elevated text-fg-secondary' };
  const statusMeta = DELIVERABLE_STATUS_META[item.status] ?? DELIVERABLE_STATUS_META.active!;
  const isUrl = /^https?:\/\//i.test(item.reference ?? '');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className="relative bg-surface-primary rounded-2xl shadow-2xl border border-border-default w-full max-w-lg max-h-[85vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 bg-surface-primary/95 backdrop-blur-sm border-b border-border-default px-5 py-4 flex items-start gap-3 rounded-t-2xl z-10">
          <span className={`inline-flex items-center justify-center w-10 h-10 rounded-xl text-lg shrink-0 ${typeMeta.color}`}>
            {typeMeta.icon}
          </span>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold text-fg-primary">{item.title}</h3>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <span className={`px-1.5 py-0.5 text-[10px] rounded font-medium ${statusMeta.color}`}>{item.status}</span>
              <span className="text-[10px] text-fg-tertiary">{item.type}</span>
              {item.format && <span className="text-[10px] px-1.5 py-0.5 bg-surface-elevated rounded text-fg-secondary">{item.format}</span>}
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-surface-overlay transition-colors shrink-0 text-fg-tertiary hover:text-fg-primary">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          {/* Summary */}
          {item.summary && (
            <div>
              <label className="text-[10px] text-fg-tertiary uppercase tracking-wider font-medium">{t('agent:deliverables.summary')}</label>
              <div className="mt-1.5">
                <Suspense fallback={<p className="text-sm text-fg-secondary">{item.summary}</p>}>
                  <LazyMarkdownMessage content={item.summary} className="text-sm text-fg-secondary" />
                </Suspense>
              </div>
            </div>
          )}

          {/* Reference */}
          {item.reference && (
            <div>
              <label className="text-[10px] text-fg-tertiary uppercase tracking-wider font-medium">{t('agent:deliverables.reference')}</label>
              <div className="mt-1.5 flex items-center gap-2 bg-surface-elevated rounded-lg px-3 py-2">
                <span className="text-xs text-fg-secondary font-mono break-all flex-1 select-all">{item.reference}</span>
                {isUrl ? (
                  <button
                    onClick={() => window.open(item.reference, '_blank', 'noopener,noreferrer')}
                    className="px-2 py-1 text-[10px] rounded bg-brand-600/20 text-brand-500 hover:bg-brand-600/30 transition-colors shrink-0"
                  >{t('common:open')}</button>
                ) : (
                  <button
                    onClick={() => { api.files.reveal(item.reference).catch(() => {}); }}
                    className="px-2 py-1 text-[10px] rounded bg-brand-600/20 text-brand-500 hover:bg-brand-600/30 transition-colors shrink-0"
                  >{t('common:open')}</button>
                )}
              </div>
            </div>
          )}

          {/* Diff stats */}
          {item.diffStats && (
            <div className="flex items-center gap-3 text-xs bg-surface-elevated rounded-lg px-3 py-2">
              <span className="text-fg-tertiary font-medium">Diff:</span>
              <span className="text-fg-secondary">{item.diffStats.filesChanged} file{item.diffStats.filesChanged !== 1 ? 's' : ''}</span>
              <span className="text-green-500">+{item.diffStats.additions}</span>
              <span className="text-red-500">-{item.diffStats.deletions}</span>
            </div>
          )}

          {/* Test results */}
          {item.testResults && (
            <div className="flex items-center gap-3 text-xs bg-surface-elevated rounded-lg px-3 py-2">
              <span className="text-fg-tertiary font-medium">Tests:</span>
              <span className="text-green-500">{item.testResults.passed} passed</span>
              {item.testResults.failed > 0 && <span className="text-red-500">{item.testResults.failed} failed</span>}
              {item.testResults.skipped > 0 && <span className="text-fg-tertiary">{item.testResults.skipped} skipped</span>}
            </div>
          )}

          {/* Tags */}
          {item.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {item.tags.map(tag => (
                <span key={tag} className="px-2 py-0.5 text-[11px] bg-surface-elevated rounded-md text-fg-tertiary">{tag}</span>
              ))}
            </div>
          )}

          {/* Metadata */}
          <div className="flex items-center gap-4 text-[10px] text-fg-tertiary flex-wrap pt-1 border-t border-border-default/50">
            <span>{t('agent:deliverables.created')}: {new Date(item.createdAt).toLocaleString()}</span>
            <span>{t('agent:deliverables.updated')}: {new Date(item.updatedAt).toLocaleString()}</span>
            {item.accessCount > 0 && <span>{t('agent:deliverables.accessed', { count: item.accessCount })}</span>}
          </div>
        </div>

        {/* Footer actions */}
        <div className="sticky bottom-0 bg-surface-primary/95 backdrop-blur-sm border-t border-border-default px-5 py-3 flex items-center justify-end gap-2 rounded-b-2xl">
          <button
            onClick={() => onOpenInPage(item.id)}
            className="px-3 py-1.5 text-xs font-medium text-brand-500 hover:bg-brand-500/10 rounded-lg transition-colors flex items-center gap-1.5"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
            </svg>
            {t('agent:deliverables.openInPage')}
          </button>
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs font-medium text-fg-secondary bg-surface-elevated hover:bg-surface-overlay rounded-lg transition-colors"
          >{t('common:close')}</button>
        </div>
      </div>
    </div>
  );
}
