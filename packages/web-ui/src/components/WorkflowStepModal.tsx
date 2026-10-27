/**
 * `WorkflowStepModal` — a single step's detail.
 *
 * Steps used to print their whole prompt inline (`line-clamp-2`), which made a
 * 10-step card a wall of truncated text that was still unreadable. The card now
 * shows one line per step and this modal carries the whole thing: prompt, role,
 * upstream dependencies, and the task the step actually produced.
 */
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  TONE_CLASS,
  stepDisplayStatus,
  stepStatusMeta,
  type WorkflowStepLike,
  type WorkflowTaskLike,
} from '../lib/workflow-view.ts';

export interface WorkflowStepModalProps {
  step: WorkflowStepLike;
  index: number;
  total: number;
  /** Upstream steps, already resolved to display names by the caller. */
  dependsOnNames: string[];
  roleName?: string;
  task?: WorkflowTaskLike;
  onClose: () => void;
  onOpenTask?: (taskId: string) => void;
}

export function WorkflowStepModal({
  step,
  index,
  total,
  dependsOnNames,
  roleName,
  task,
  onClose,
  onOpenTask,
}: WorkflowStepModalProps) {
  const { t } = useTranslation(['work', 'common']);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const status = stepDisplayStatus(task);
  const statusMeta = stepStatusMeta(status);
  const pill = { tone: statusMeta.tone, label: t(`work:task.${statusMeta.key}`, statusMeta.label) };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="workflow-step-title"
        className="relative flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border-default bg-surface-secondary shadow-2xl"
        data-testid="workflow-step-modal"
      >
        <header className="flex items-start justify-between gap-3 border-b border-border-default/50 px-5 py-3">
          <div className="min-w-0">
            <p className="text-[10px] font-medium uppercase tracking-wider text-fg-quaternary">
              {t('work:task.workflowStepOf', '步骤 {{index}} / {{total}}', { index: index + 1, total })}
            </p>
            <h2 id="workflow-step-title" className="mt-0.5 truncate text-sm font-semibold text-fg-primary">
              {step.name}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-fg-tertiary">
              <span className="rounded bg-surface-elevated px-1.5 py-0.5" title={step.role}>
                {roleName ?? step.role}
              </span>
              <span className={`rounded px-1.5 py-0.5 font-medium ${TONE_CLASS[pill.tone].chip}`}>{pill.label}</span>
              {dependsOnNames.length > 0 ? (
                <span>
                  {t('work:task.workflowDependsOn', '依赖 {{steps}}', {
                    steps: dependsOnNames.join('、'),
                  })}
                </span>
              ) : null}
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={t('common:close', '关闭')}
            className="rounded-lg p-1.5 text-fg-tertiary transition-colors hover:bg-surface-elevated hover:text-fg-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-3">
          {task ? (
            <button
              type="button"
              onClick={() => onOpenTask?.(task.id)}
              disabled={!onOpenTask}
              className="mb-3 flex w-full items-center gap-2 rounded-lg border border-border-default/50 bg-surface px-3 py-2 text-left transition-colors hover:border-brand-500/40 hover:bg-surface-elevated/60"
            >
              <span className={`h-2 w-2 shrink-0 rounded-full ${TONE_CLASS[pill.tone].dot}`} aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11px] font-medium text-fg-secondary">{task.title}</span>
                <span className="block text-[10px] text-fg-quaternary">
                  {t('work:task.workflowOpenTask', '查看对应任务')}
                </span>
              </span>
              <svg className="h-3.5 w-3.5 shrink-0 text-fg-quaternary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          ) : (
            <p className="mb-3 text-[11px] text-fg-quaternary">
              {t('work:task.workflowStepNoTaskHint', '这一步还没有产生任务（运行后会自动创建）。')}
            </p>
          )}

          <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-fg-quaternary">
            {t('work:task.workflowStepPrompt', '提示词')}
          </p>
          <pre className="max-h-[45vh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface px-3 py-2.5 font-mono text-[11px] leading-relaxed text-fg-secondary">
            {step.prompt || '—'}
          </pre>
        </div>
      </div>
    </div>
  );
}

export default WorkflowStepModal;
