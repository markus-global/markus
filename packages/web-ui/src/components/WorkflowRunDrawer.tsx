/**
 * `WorkflowRunDrawer` — the per-run detail panel.
 *
 * Before this existed, clicking a run in the workflow card could only lead
 * *out* of the workflow view ("查看任务" → task board), so the two questions a
 * run actually raises — **which step is running now** and **which step failed**
 * — were unanswerable in place. The drawer joins the template's steps with the
 * run's tasks and shows the join.
 */
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkflowInfo, WorkflowRunInfo, WorkflowTemplateInfo } from '../api.ts';
import { timeAgo } from '../lib/timeAgo.ts';
import {
  TONE_CLASS,
  computeProgress,
  matchTasksToSteps,
  runStatusMeta,
  stepDisplayStatus,
  isRunActive,
  dependsOnNames,
  buildStepIndex,
  type WorkflowTaskLike,
  type StepDisplayStatus,
} from '../lib/workflow-view.ts';

export interface WorkflowRunDrawerProps {
  workflow: WorkflowInfo;
  run: WorkflowRunInfo;
  detail?: WorkflowTemplateInfo;
  tasks?: WorkflowTaskLike[];
  tasksLoading?: boolean;
  onClose: () => void;
  onPauseResume: () => void;
  onCancel: () => void;
  onViewTasks: () => void;
  pausing?: boolean;
  roleAgentName?: (role: string) => string | undefined;
  /** Deep-link to the task a step produced. */
  onOpenTask?: (taskId: string) => void;
}

const STEP_DOT: Record<StepDisplayStatus, string> = {
  done: TONE_CLASS.success.bar,
  failed: TONE_CLASS.danger.bar,
  active: TONE_CLASS.info.bar,
  pending: 'bg-fg-quaternary/50',
  unknown: 'bg-border-default',
};

const STEP_LABEL_KEY: Record<StepDisplayStatus, { key: string; label: string }> = {
  done: { key: 'runStatusCompleted', label: '已完成' },
  failed: { key: 'runStatusFailed', label: '失败' },
  active: { key: 'runStatusRunning', label: '进行中' },
  pending: { key: 'workflowStepPending', label: '待处理' },
  unknown: { key: 'workflowStepNoTask', label: '未创建任务' },
};

export function WorkflowRunDrawer({
  workflow,
  run,
  detail,
  tasks,
  tasksLoading,
  onClose,
  onPauseResume,
  onCancel,
  onViewTasks,
  pausing,
  roleAgentName,
  onOpenTask,
}: WorkflowRunDrawerProps) {
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

  const steps = run.templateSnapshot?.steps ?? detail?.steps ?? [];
  const stepIndex = buildStepIndex(steps);
  const mapped = matchTasksToSteps(steps, tasks ?? []);
  const progress = computeProgress(steps, mapped);
  const meta = runStatusMeta(run.status);

  const unmatchedTasks = (tasks ?? []).filter(
    (task) => !Object.values(mapped).some((m) => m?.id === task.id),
  );

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="presentation">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="workflow-run-drawer-title"
        className="relative flex h-full w-full max-w-md flex-col border-l border-border-default bg-surface-secondary shadow-2xl"
        data-testid="workflow-run-drawer"
      >
        <header className="flex items-start justify-between gap-3 border-b border-border-default/50 px-4 py-3">
          <div className="min-w-0">
            <h2 id="workflow-run-drawer-title" className="truncate text-sm font-semibold text-fg-primary">
              {workflow.displayName || workflow.name} · #{run.runNumber}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-fg-tertiary">
              <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium ${TONE_CLASS[meta.tone].chip}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${TONE_CLASS[meta.tone].dot}`} aria-hidden="true" />
                {t(`work:task.${meta.key}`, meta.label)}
              </span>
              <span>{timeAgo(run.startedAt, t)}</span>
              {run.triggeredBy === 'schedule' ? (
                <span className="text-purple-500">{t('work:task.workflowScheduled', '定时')}</span>
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

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {/* Progress */}
          <div className="mb-4">
            <div className="mb-1 flex items-center justify-between text-[11px] text-fg-tertiary">
              <span>
                {t('work:task.workflowProgress', '{{done}}/{{total}} 个任务完成', {
                  done: progress.done,
                  total: progress.total || run.taskIds.length,
                })}
              </span>
              {progress.failed > 0 ? (
                <span className="text-red-500">
                  {t('work:task.workflowFailedCount', '{{count}} 步失败', { count: progress.failed })}
                </span>
              ) : null}
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-elevated">
              <div
                className={`h-full rounded-full transition-all ${progress.failed > 0 ? TONE_CLASS.danger.bar : TONE_CLASS.success.bar}`}
                style={{
                  width: `${progress.total > 0 ? progress.percent : 0}%`,
                }}
              />
            </div>
          </div>

          {/* Steps × tasks */}
          <section className="mb-4">
            <h3 className="mb-2 text-[10px] font-medium uppercase tracking-wider text-fg-tertiary">
              {t('work:task.workflowSteps', '步骤')}
            </h3>
            {tasksLoading && steps.length === 0 ? (
              <div className="space-y-2" aria-busy="true">
                <div className="h-3 w-2/3 animate-pulse rounded bg-surface-elevated" />
                <div className="h-3 w-full animate-pulse rounded bg-surface-elevated" />
                <div className="h-3 w-1/2 animate-pulse rounded bg-surface-elevated" />
              </div>
            ) : steps.length === 0 ? (
              <p className="text-[11px] text-fg-quaternary">{t('work:task.workflowLoading', '加载中…')}</p>
            ) : (
              <ol className="space-y-1">
                {steps.map((step, idx) => {
                  const task = mapped[step.id];
                  const state = stepDisplayStatus(task);
                  const label = STEP_LABEL_KEY[state];
                  const deps = dependsOnNames(step, stepIndex);
                  const roleName = roleAgentName?.(step.role);
                  const rowBody = (
                    <>
                      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${STEP_DOT[state]}`} aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span className="text-xs font-medium text-fg-primary">
                            {idx + 1}. {step.name}
                          </span>
                          <span className="text-[10px] text-fg-quaternary">
                            {t(`work:task.${label.key}`, label.label)}
                          </span>
                        </span>
                        <span className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-fg-quaternary">
                          <span>{roleName ?? step.role}</span>
                          {deps.length > 0 ? (
                            <span>
                              {t('work:task.workflowDependsOn', '依赖 {{steps}}', { steps: deps.join('、') })}
                            </span>
                          ) : null}
                          {task ? <span className="max-w-[16rem] truncate">{task.title}</span> : null}
                        </span>
                      </span>
                      {task && onOpenTask ? (
                        <svg
                          className="mt-1 h-3 w-3 shrink-0 text-fg-quaternary opacity-0 transition-opacity group-hover:opacity-100"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={2}
                          aria-hidden="true"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                        </svg>
                      ) : null}
                    </>
                  );
                  return (
                    <li key={step.id}>
                      {task && onOpenTask ? (
                        <button
                          type="button"
                          onClick={() => onOpenTask(task.id)}
                          data-testid={`workflow-run-step-${step.id}`}
                          title={t('work:task.workflowOpenTask', '查看对应任务')}
                          className="group flex w-full items-start gap-2 rounded-lg px-1 py-1 text-left transition-colors hover:bg-surface-elevated/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60"
                        >
                          {rowBody}
                        </button>
                      ) : (
                        <div className="flex items-start gap-2 rounded-lg px-1 py-1">{rowBody}</div>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
            {unmatchedTasks.length > 0 ? (
              <p className="mt-2 text-[10px] text-fg-quaternary">
                {t('work:task.workflowUnmatchedTasks', '另有 {{count}} 个任务未能对应到步骤', {
                  count: unmatchedTasks.length,
                })}
              </p>
            ) : null}
          </section>

          {/* Run parameters */}
          {Object.keys(run.params ?? {}).length > 0 ? (
            <section className="mb-4">
              <h3 className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-fg-tertiary">
                {t('work:task.workflowParamsCount', '参数 ({{count}})', {
                  count: Object.keys(run.params).length,
                })}
              </h3>
              <dl className="space-y-1">
                {Object.entries(run.params).map(([key, value]) => (
                  <div key={key} className="flex gap-2 text-[11px]">
                    <dt className="w-24 shrink-0 truncate text-fg-tertiary">{key}</dt>
                    <dd className="min-w-0 flex-1 break-words text-fg-secondary">{value || '—'}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : null}

          {/* Role assignments */}
          {Object.keys(run.roleMapping ?? {}).length > 0 ? (
            <section className="mb-4">
              <h3 className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-fg-tertiary">
                {t('work:task.workflowRoleAssignments', '角色分配')}
              </h3>
              <dl className="space-y-1">
                {Object.entries(run.roleMapping).map(([role, agentId]) => (
                  <div key={role} className="flex gap-2 text-[11px]">
                    <dt className="w-24 shrink-0 truncate text-fg-tertiary">{role}</dt>
                    <dd className="min-w-0 flex-1 truncate text-fg-secondary">
                      {roleAgentName?.(role) ?? agentId}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : null}
        </div>

        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border-default/50 px-4 py-3">
          {isRunActive(run.status) ? (
            <>
              <button
                type="button"
                onClick={onPauseResume}
                disabled={pausing}
                className="rounded-lg bg-amber-500/15 px-3 py-1.5 text-xs font-medium text-amber-600 transition-colors hover:bg-amber-500/25 disabled:opacity-60 dark:text-amber-400"
              >
                {pausing
                  ? '…'
                  : run.status === 'running'
                    ? t('work:task.workflowPause', '暂停')
                    : t('work:task.workflowResume', '恢复')}
              </button>
              <button
                type="button"
                onClick={onCancel}
                className="rounded-lg bg-red-500/15 px-3 py-1.5 text-xs font-medium text-red-500 transition-colors hover:bg-red-500/25"
              >
                {t('work:task.workflowCancelRun', '取消运行')}
              </button>
            </>
          ) : null}
          <button
            type="button"
            onClick={onViewTasks}
            className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-500"
          >
            {t('work:task.workflowViewTasks', '查看任务')}
          </button>
        </footer>
      </div>
    </div>
  );
}

export default WorkflowRunDrawer;
