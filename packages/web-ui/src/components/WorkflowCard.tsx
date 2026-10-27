/**
 * `WorkflowCard` — one workflow in the Work page's workflow view.
 *
 * Replaces the inline card that lived in `pages/Work.tsx` (2026-10-27 review).
 * The old card was a list item pretending to be a detail page: 24px hit area,
 * no keyboard path, a second clickable target nested inside the header, a
 * silent `catch {}` on the detail fetch, raw `depends_on` ids printed at the
 * user, a fake "DAG" and no answer to "how far did the run get / which step
 * failed".
 *
 * The card now answers three questions before the panel is even opened —
 * **what is it / how is it doing / what can I do** — and the panel is a
 * structured detail (progress, steps with real dependency names, a layered
 * DAG, params, runs) rather than a text dump.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { WorkflowInfo, WorkflowRunInfo, WorkflowTemplateInfo } from '../api.ts';
import { Disclosure } from './Disclosure.tsx';
import { timeAgo } from '../lib/timeAgo.ts';
import {
  TONE_CLASS,
  buildStepIndex,
  computeProgress,
  dependsOnNames,
  layeredDag,
  matchTasksToSteps,
  runStatusMeta,
  shouldClampPrompt,
  isRunActive,
  type WorkflowTaskLike,
} from '../lib/workflow-view.ts';

export interface WorkflowCardProps {
  workflow: WorkflowInfo;
  /** Parsed template, once loaded. */
  detail?: WorkflowTemplateInfo;
  detailState: 'idle' | 'loading' | 'error' | 'ready';
  onRetryDetail: () => void;
  expanded: boolean;
  onToggle: () => void;
  runs: WorkflowRunInfo[];
  /** Tasks per run id — only recent runs are prefetched. */
  runTasks: Record<string, WorkflowTaskLike[] | undefined>;
  onRun: () => void;
  onViewTasks: (run: WorkflowRunInfo) => void;
  onOpenRun: (run: WorkflowRunInfo) => void;
  onPauseResume: (run: WorkflowRunInfo) => void;
  onCancelRun: (run: WorkflowRunInfo) => void;
  pausingRunId?: string | null;
  /** Role label → assigned agent display name (undefined when unknown). */
  roleAgentName?: (role: string) => string | undefined;
  onSendToAgent: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

function StatusChip({ status }: { status: string }) {
  const { t } = useTranslation(['work']);
  const meta = runStatusMeta(status);
  const tone = TONE_CLASS[meta.tone];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${tone.chip}`}
      data-status={status}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} aria-hidden="true" />
      {t(`work:task.${meta.key}`, meta.label)}
    </span>
  );
}

function ActionMenu({ items }: { items: Array<{ key: string; label: string; onSelect: () => void; danger?: boolean }> }) {
  const { t } = useTranslation(['work']);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocPointer = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('work:task.workflowMoreActions', '更多操作')}
        title={t('work:task.workflowMoreActions', '更多操作')}
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-fg-tertiary transition-colors hover:bg-surface-elevated hover:text-fg-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60"
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-xl border border-border-default bg-surface-secondary py-1 shadow-xl"
        >
          {items.map((item) => (
            <button
              key={item.key}
              role="menuitem"
              type="button"
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={`flex w-full items-center px-3 py-2 text-left text-xs transition-colors hover:bg-surface-elevated focus:bg-surface-elevated focus:outline-none ${item.danger ? 'text-red-500' : 'text-fg-secondary'}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-2 pt-3" data-testid="workflow-detail-skeleton" aria-busy="true">
      <div className="h-2.5 w-2/3 animate-pulse rounded bg-surface-elevated" />
      <div className="h-2.5 w-full animate-pulse rounded bg-surface-elevated" />
      <div className="h-2.5 w-5/6 animate-pulse rounded bg-surface-elevated" />
    </div>
  );
}

export function WorkflowCard({
  workflow,
  detail,
  detailState,
  onRetryDetail,
  expanded,
  onToggle,
  runs,
  runTasks,
  onRun,
  onViewTasks,
  onOpenRun,
  onPauseResume,
  onCancelRun,
  pausingRunId,
  roleAgentName,
  onSendToAgent,
  onEdit,
  onDuplicate,
  onDelete,
}: WorkflowCardProps) {
  const { t } = useTranslation(['work', 'common']);
  const [showAllRuns, setShowAllRuns] = useState(false);
  const [openPrompts, setOpenPrompts] = useState<Set<string>>(new Set());

  const latestRun = runs[0];
  const anyActive = runs.some((run) => isRunActive(run.status));
  const steps = detail?.steps ?? [];
  const stepIndex = buildStepIndex(steps);
  const mapped = latestRun ? matchTasksToSteps(steps, runTasks[latestRun.id] ?? []) : {};
  const progress = computeProgress(steps, mapped);
  const hasProgress = progress.total > 0;

  const visibleRuns = showAllRuns ? runs : runs.slice(0, 3);
  const dag = steps.length > 1 ? layeredDag(steps) : { layers: [], depth: {}, edges: [] };
  const showDag = dag.layers.length > 1;

  const togglePrompt = (stepId: string) =>
    setOpenPrompts((prev) => {
      const next = new Set(prev);
      if (next.has(stepId)) next.delete(stepId);
      else next.add(stepId);
      return next;
    });

  const summary = (
    <span className="block">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="truncate text-sm font-semibold text-fg-primary">
          {workflow.displayName || workflow.name}
        </span>
        <span className="text-[11px] text-fg-tertiary">
          {t('work:task.workflowStepsCount', '{{count}} 步骤', { count: workflow.stepCount })}
        </span>
        {workflow.hasSchedule ? (
          <span className="rounded bg-purple-500/15 px-1.5 py-0.5 text-[10px] font-medium text-purple-500">
            {t('work:task.workflowScheduled', '定时')}
          </span>
        ) : null}
        <span className="text-[10px] text-fg-quaternary">v{workflow.version}</span>
        {latestRun ? <StatusChip status={latestRun.status} /> : null}
        {hasProgress ? (
          <span className="text-[11px] font-medium text-fg-secondary" data-testid="workflow-progress">
            {t('work:task.workflowProgress', '{{done}}/{{total}} 个任务完成', {
              done: progress.done,
              total: progress.total,
            })}
          </span>
        ) : null}
      </span>
      {workflow.description ? (
        <span className="mt-0.5 line-clamp-1 block text-[11px] text-fg-tertiary">{workflow.description}</span>
      ) : null}
      {latestRun && progress.failedSteps.length > 0 ? (
        <span className="mt-0.5 block truncate text-[11px] text-red-500" data-testid="workflow-failed-step">
          {t('work:task.workflowFailedAt', '失败于 {{step}}', { step: progress.failedSteps[0]!.name })}
        </span>
      ) : null}
    </span>
  );

  const actions = (
    <>
      {anyActive ? (
        <span className="inline-flex items-center gap-1.5 rounded-lg bg-blue-500/15 px-2.5 py-1 text-xs font-medium text-blue-600 dark:text-blue-400">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" aria-hidden="true" />
          {t('work:task.workflowRunning', '运行中')}
        </span>
      ) : (
        <button
          type="button"
          onClick={onRun}
          className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60"
        >
          {t('work:task.workflowRun', '运行')}
        </button>
      )}
      <ActionMenu
        items={[
          { key: 'edit', label: t('work:task.workflowEditYaml', '编辑 YAML'), onSelect: onEdit },
          { key: 'duplicate', label: t('work:task.workflowDuplicate', '复制为新工作流'), onSelect: onDuplicate },
          { key: 'send', label: t('work:task.workflowSendToAgent', '发送到智能体对话'), onSelect: onSendToAgent },
          { key: 'delete', label: t('work:task.workflowDelete', '删除工作流'), onSelect: onDelete, danger: true },
        ]}
      />
    </>
  );

  return (
    <div
      className="rounded-xl border border-border-default/50 bg-surface-secondary p-4"
      data-testid={`workflow-card-${workflow.name}`}
    >
      <Disclosure
        expanded={expanded}
        onToggle={onToggle}
        summary={summary}
        actions={actions}
        testId={`workflow-${workflow.name}`}
        panelLabel={workflow.displayName || workflow.name}
        panelClassName="pt-3"
      >
        {detailState === 'error' ? (
          <div className="flex items-center justify-between gap-3 rounded-lg bg-red-500/5 px-3 py-2">
            <span className="text-xs text-red-500">
              {t('work:task.workflowDetailFailed', '详情加载失败')}
            </span>
            <button
              type="button"
              onClick={onRetryDetail}
              className="rounded-lg bg-surface-elevated px-2.5 py-1 text-[11px] font-medium text-fg-secondary transition-colors hover:text-fg-primary"
            >
              {t('work:task.workflowRetry', '重试')}
            </button>
          </div>
        ) : !detail ? (
          <DetailSkeleton />
        ) : (
          <div className="space-y-4">
            {workflow.description ? (
              <p className="text-xs leading-relaxed text-fg-secondary">{workflow.description}</p>
            ) : null}

            {/* Progress of the most recent run — the question the old card could not answer. */}
            {hasProgress ? (
              <div data-testid="workflow-progress-bar">
                <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-fg-tertiary">
                  <span className="font-medium text-fg-secondary">
                    #{latestRun!.runNumber} ·{' '}
                    {t('work:task.workflowProgress', '{{done}}/{{total}} 个任务完成', {
                      done: progress.done,
                      total: progress.total,
                    })}
                  </span>
                  {progress.failedSteps.length > 0 ? (
                    <span className="text-red-500">
                      {t('work:task.workflowFailedAt', '失败于 {{step}}', {
                        step: progress.failedSteps.map((s) => s.name).join('、'),
                      })}
                    </span>
                  ) : progress.activeSteps.length > 0 ? (
                    <span className="text-blue-600 dark:text-blue-400">
                      {progress.activeSteps.map((s) => s.name).join('、')}
                    </span>
                  ) : null}
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-elevated">
                  <div
                    className={`h-full rounded-full transition-all ${progress.failed > 0 ? TONE_CLASS.danger.bar : TONE_CLASS.success.bar}`}
                    style={{ width: `${progress.percent}%` }}
                  />
                </div>
              </div>
            ) : null}

            {/* Steps — names, real role, dependency NAMES, prompt on demand. */}
            <div>
              <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-fg-tertiary">
                {t('work:task.workflowSteps', '步骤')}
              </p>
              <ol className="space-y-2">
                {steps.map((step, idx) => {
                  const deps = dependsOnNames(step, stepIndex);
                  const task = mapped[step.id];
                  const promptOpen = openPrompts.has(step.id);
                  const roleName = roleAgentName?.(step.role);
                  const longPrompt = shouldClampPrompt(step.prompt);
                  return (
                    <li key={step.id} className="flex items-start gap-2">
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-500/15 text-[9px] font-bold text-brand-500">
                        {idx + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="text-xs font-medium text-fg-primary">{step.name}</span>
                          <span
                            className="rounded bg-surface-elevated px-1.5 py-0.5 text-[10px] text-fg-tertiary"
                            title={step.role}
                          >
                            {roleName ?? step.role}
                          </span>
                          {targetChip(task ? task.status : null, t)}
                          {deps.length > 0 ? (
                            <span className="text-[10px] text-fg-quaternary">
                              {t('work:task.workflowDependsOn', '依赖 {{steps}}', {
                                steps: deps.join('、'),
                              })}
                            </span>
                          ) : null}
                        </div>
                        <p
                          className={`mt-0.5 text-[11px] leading-relaxed text-fg-tertiary ${promptOpen ? '' : 'line-clamp-2'}`}
                        >
                          {step.prompt}
                        </p>
                        {longPrompt ? (
                          <button
                            type="button"
                            onClick={() => togglePrompt(step.id)}
                            aria-expanded={promptOpen}
                            className="mt-0.5 text-[10px] font-medium text-brand-500 transition-colors hover:text-brand-400"
                          >
                            {promptOpen
                              ? t('work:task.workflowHidePrompt', '收起')
                              : t('work:task.workflowShowPrompt', '展开')}
                          </button>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>

            {/* Layered DAG: columns are dependency depth, so parallel steps are visible. */}
            {showDag ? (
              <div data-testid="workflow-dag">
                <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-fg-tertiary">
                  {t('work:task.workflowDependencies', '依赖关系')}
                </p>
                <div className="flex items-start gap-2 overflow-x-auto pb-1">
                  {dag.layers.map((layer, layerIdx) => (
                    <div key={layerIdx} className="flex items-center gap-2">
                      {layerIdx > 0 ? (
                        <svg className="h-3 w-3 shrink-0 text-fg-quaternary" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      ) : null}
                      <div className="flex flex-col gap-1">
                        {layer.map((stepId) => {
                          const step = stepIndex.get(stepId);
                          if (!step) return null;
                          const task = mapped[stepId];
                          return (
                            <span
                              key={stepId}
                              className="whitespace-nowrap rounded border border-border-default/40 bg-surface px-2 py-1 text-[10px] font-medium text-fg-secondary"
                              title={dependsOnNames(step, stepIndex).join('、')}
                            >
                              {step.name}
                              {task ? (
                                <span
                                  className={`ml-1 inline-block h-1.5 w-1.5 rounded-full ${TONE_CLASS[stepTone(task.status)].dot}`}
                                  aria-hidden="true"
                                />
                              ) : null}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {/* Params + schedule */}
            {detail.params && detail.params.length > 0 ? (
              <div>
                <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-fg-tertiary">
                  {t('work:task.workflowParamsCount', '参数 ({{count}})', { count: detail.params.length })}
                </p>
                <div className="flex flex-wrap gap-2">
                  {detail.params.map((param) => (
                    <span
                      key={param.name}
                      className="inline-flex items-center gap-1 rounded border border-border-default/40 bg-surface-elevated px-2 py-0.5 text-[10px]"
                    >
                      <span className="font-medium text-fg-secondary">{param.label || param.name}</span>
                      <span className="text-fg-quaternary">{param.type || 'string'}</span>
                      {param.required ? <span className="text-red-500">*</span> : null}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}

            {detail.schedule ? (
              <p className="text-[11px] text-fg-tertiary">
                {t('work:task.workflowScheduled', '定时')}:{' '}
                {detail.schedule.cron ? `cron ${detail.schedule.cron}` : detail.schedule.interval}
              </p>
            ) : null}

            {/* Runs */}
            <div>
              <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-fg-tertiary">
                {t('work:task.workflowRecentRuns', '最近运行')}
              </p>
              {runs.length === 0 ? (
                <p className="text-[11px] text-fg-quaternary">
                  {t('work:task.workflowNoRecentRuns', '暂无运行记录')}
                </p>
              ) : (
                <>
                  <ul className="space-y-1">
                    {visibleRuns.map((run) => {
                      const runMapped = matchTasksToSteps(steps, runTasks[run.id] ?? []);
                      const runProgress = computeProgress(steps, runMapped);
                      return (
                        <li
                          key={run.id}
                          className="flex flex-wrap items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors hover:bg-surface-elevated/50"
                        >
                          <span className="font-medium text-fg-secondary">#{run.runNumber}</span>
                          <StatusChip status={run.status} />
                          {runProgress.total > 0 ? (
                            <span className="text-[11px] text-fg-tertiary">
                              {runProgress.done}/{runProgress.total}
                            </span>
                          ) : (
                            <span className="text-[11px] text-fg-tertiary">
                              {t('work:task.workflowStepCountShort', '{{count}} 个任务', {
                                count: run.taskIds.length,
                              })}
                            </span>
                          )}
                          <span className="text-[11px] text-fg-quaternary">
                            {timeAgo(run.startedAt, t)}
                          </span>
                          {run.triggeredBy === 'schedule' ? (
                            <span className="text-[10px] text-purple-500">
                              {t('work:task.workflowScheduled', '定时')}
                            </span>
                          ) : null}
                          <span className="flex-1" />
                          {isRunActive(run.status) ? (
                            <>
                              <button
                                type="button"
                                onClick={() => onPauseResume(run)}
                                disabled={pausingRunId === run.id}
                                className="rounded-lg bg-amber-500/15 px-2.5 py-1 text-[10px] font-medium text-amber-600 transition-colors hover:bg-amber-500/25 dark:text-amber-400"
                              >
                                {pausingRunId === run.id
                                  ? '…'
                                  : run.status === 'running'
                                    ? t('work:task.workflowPause', '暂停')
                                    : t('work:task.workflowResume', '恢复')}
                              </button>
                              <button
                                type="button"
                                onClick={() => onCancelRun(run)}
                                className="rounded-lg bg-red-500/15 px-2.5 py-1 text-[10px] font-medium text-red-500 transition-colors hover:bg-red-500/25"
                              >
                                {t('work:task.workflowCancelRun', '取消运行')}
                              </button>
                            </>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => onOpenRun(run)}
                            className="rounded-lg bg-surface-elevated px-2.5 py-1 text-[10px] font-medium text-fg-secondary transition-colors hover:text-fg-primary"
                          >
                            {t('work:task.workflowRunDetails', '详情')}
                          </button>
                          <button
                            type="button"
                            onClick={() => onViewTasks(run)}
                            className="rounded-lg bg-brand-500/15 px-2.5 py-1 text-[10px] font-medium text-brand-500 transition-colors hover:bg-brand-500/25"
                          >
                            {t('work:task.workflowViewTasks', '查看任务')}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  {runs.length > 3 ? (
                    <button
                      type="button"
                      onClick={() => setShowAllRuns((v) => !v)}
                      className="mt-1.5 text-[10px] font-medium text-fg-tertiary transition-colors hover:text-fg-primary"
                    >
                      {showAllRuns
                        ? t('work:task.workflowShowFewerRuns', '只看最近')
                        : t('work:task.workflowShowAllRuns', '显示全部 {{count}} 次运行', {
                            count: runs.length,
                          })}
                    </button>
                  ) : null}
                </>
              )}
            </div>
          </div>
        )}
      </Disclosure>
    </div>
  );
}

function stepTone(status: string) {
  if (status === 'completed' || status === 'archived') return 'success' as const;
  if (status === 'failed' || status === 'rejected') return 'danger' as const;
  if (status === 'in_progress' || status === 'review') return 'info' as const;
  return 'neutral' as const;
}

/** A tiny status chip for the step's task, so the step list doubles as progress. */
function targetChip(status: string | null, t: TFunction) {
  if (!status) {
    return (
      <span className="text-[10px] text-fg-quaternary">
        {t('work:task.workflowStepNoTask', '未开始')}
      </span>
    );
  }
  const tone = stepTone(status);
  const label =
    status === 'completed' || status === 'archived'
      ? t('work:task.runStatusCompleted', '已完成')
      : status === 'failed' || status === 'rejected'
        ? t('work:task.runStatusFailed', '失败')
        : status === 'in_progress' || status === 'review'
          ? t('work:task.runStatusRunning', '进行中')
          : t('work:task.workflowStepPending', '待处理');
  return <span className={`rounded px-1.5 py-0.5 text-[10px] ${TONE_CLASS[tone].chip}`}>{label}</span>;
}

export default WorkflowCard;
