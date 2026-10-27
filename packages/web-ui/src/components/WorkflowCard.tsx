/**
 * `WorkflowCard` — one workflow in the Work page's workflow view.
 *
 * Layout rules this file encodes (2026-10-27, second pass with the Owner):
 *
 *   1. **One representation per fact.** The card used to render the steps twice
 *      — a list *and* a separate "DAG" strip — and put run progress in the
 *      header *and* in the run rows. Now steps appear once (as a layered flow,
 *      which is what the DAG strip was trying to be) and progress appears only
 *      where it belongs: on the run.
 *   2. **The header is an index, not a dashboard.** Name, size, version, the
 *      latest run's status. No counters, no bar — clicking a run is the way to
 *      see numbers, and the run drawer is where they live.
 *   3. **Steps are one line each.** A prompt is detail, not a subtitle: clicking
 *      the step opens its modal, which also links to the task the step produced.
 *   4. **A run row is a row, not a toolbar.** One `…` affordance opens the run;
 *      pause/cancel/见任务 live inside that run's drawer.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkflowInfo, WorkflowRunInfo, WorkflowTemplateInfo } from '../api.ts';
import { Disclosure } from './Disclosure.tsx';
import { WorkflowStepModal } from './WorkflowStepModal.tsx';
import { timeAgo } from '../lib/timeAgo.ts';
import {
  TONE_CLASS,
  buildStepIndex,
  computeProgress,
  dependsOnNames,
  layeredDag,
  matchTasksToSteps,
  runStatusMeta,
  isRunActive,
  type WorkflowStepLike,
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
  onOpenRun: (run: WorkflowRunInfo) => void;
  /** Save an edit to a template step (definition, not run state). */
  onSaveStep?: (stepId: string, patch: { name?: string; role?: string; prompt?: string }) => Promise<void>;
  /** Role label → assigned agent display name (undefined when unknown). */
  roleAgentName?: (role: string) => string | undefined;
  onSendToAgent: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

function StatusChip({ status, className = '' }: { status: string; className?: string }) {
  const { t } = useTranslation(['work']);
  const meta = runStatusMeta(status);
  const tone = TONE_CLASS[meta.tone];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${tone.chip} ${className}`}
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
        <EllipsisIcon />
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

function EllipsisIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
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

/**
 * Layered step flow — rows are dependency depth, siblings in a row are parallel.
 *
 * This replaces two half-views that existed side by side ("步骤" list + a "DAG"
 * strip that was just chips in template order with a decorative arrow). The
 * order here is topological, so reading top-to-bottom *is* the execution order,
 * and a bracket marks the steps that can run at the same time.
 */
function StepFlow({
  steps,
  roleAgentName,
  onOpenStep,
}: {
  steps: WorkflowStepLike[];
  roleAgentName?: (role: string) => string | undefined;
  onOpenStep: (step: WorkflowStepLike, index: number) => void;
}) {
  const { t } = useTranslation(['work']);
  const stepIndex = buildStepIndex(steps);
  const { layers } = layeredDag(steps);
  const order = new Map(steps.map((step, i) => [step.id, i]));
  let running = 0;

  return (
    <ol className="space-y-1" data-testid="workflow-step-flow">
      {layers.map((layer, layerIdx) => {
        const parallel = layer.length > 1;
        return (
          <li key={layerIdx}>
            {parallel ? (
              <p className="mb-1 pl-5 text-[10px] font-medium uppercase tracking-wider text-fg-quaternary">
                {t('work:task.workflowParallel', '并行 {{count}} 步', { count: layer.length })}
              </p>
            ) : null}
            <div className={parallel ? 'ml-1 space-y-0.5 border-l border-brand-500/30 pl-2' : 'space-y-0.5'}>
              {layer.map((stepId) => {
                const step = stepIndex.get(stepId);
                if (!step) return null;
                const deps = dependsOnNames(step, stepIndex);
                const roleName = roleAgentName?.(step.role);
                const displayIndex = (order.get(stepId) ?? 0) + 1;
                running += 1;
                return (
                  <li key={stepId}>
                    <button
                      type="button"
                      onClick={() => onOpenStep(step, (order.get(stepId) ?? 0))}
                      data-testid={`workflow-step-${stepId}`}
                      className="group flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-surface-elevated/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60"
                    >
                      <span className="w-4 shrink-0 text-right text-[10px] tabular-nums text-fg-quaternary">
                        {displayIndex}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs text-fg-primary">{step.name}</span>
                      {deps.length > 1 ? (
                        <span
                          className="shrink-0 rounded bg-surface-elevated px-1 py-0.5 text-[9px] text-fg-quaternary"
                          title={deps.join('、')}
                        >
                          ↑{deps.length}
                        </span>
                      ) : null}
                      <span className="hidden shrink-0 text-[10px] text-fg-quaternary sm:inline" title={step.role}>
                        {roleName ?? step.role}
                      </span>
                      <svg
                        className="h-3 w-3 shrink-0 text-fg-quaternary opacity-0 transition-opacity group-hover:opacity-100"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                        aria-hidden="true"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                      </svg>
                    </button>
                  </li>
                );
              })}
            </div>
          </li>
        );
      })}
      {running === 0 ? (
        <li className="text-[11px] text-fg-quaternary">{t('work:task.workflowNoSteps', '该模板没有步骤')}</li>
      ) : null}
    </ol>
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
  onOpenRun,
  onSaveStep,
  roleAgentName,
  onSendToAgent,
  onEdit,
  onDuplicate,
  onDelete,
}: WorkflowCardProps) {
  const { t } = useTranslation(['work', 'common']);
  const [openStep, setOpenStep] = useState<{ step: WorkflowStepLike; index: number } | null>(null);

  const latestRun = runs[0];
  const anyActive = runs.some((run) => isRunActive(run.status));
  const steps = detail?.steps ?? [];

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
      </span>
      {workflow.description ? (
        <span className="mt-0.5 line-clamp-1 block text-[11px] text-fg-tertiary">{workflow.description}</span>
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
            {steps.length > 0 ? (
              <StepFlow
                steps={steps}
                roleAgentName={roleAgentName}
                onOpenStep={(step, index) => setOpenStep({ step, index })}
              />
            ) : null}

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

            <div>
              <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-fg-tertiary">
                {t('work:task.workflowRecentRuns', '最近运行')}
              </p>
              {runs.length === 0 ? (
                <p className="text-[11px] text-fg-quaternary">
                  {t('work:task.workflowNoRecentRuns', '暂无运行记录')}
                </p>
              ) : (
                <ul className="space-y-0.5">
                  {runs.map((run) => {
                    const runMapped = matchTasksToSteps(steps, runTasks[run.id] ?? []);
                    const runProgress = computeProgress(steps, runMapped);
                    return (
                      <li key={run.id}>
                        {/* The whole row is the affordance — a 28px icon as the only
                            way in was a hit target, not a row. */}
                        <button
                          type="button"
                          onClick={() => onOpenRun(run)}
                          aria-label={t('work:task.workflowRunDetails', '运行详情')}
                          data-testid={`workflow-run-open-${run.id}`}
                          className="group flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left text-xs transition-colors hover:bg-surface-elevated/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60"
                        >
                          <span className="shrink-0 font-medium tabular-nums text-fg-secondary">
                            #{run.runNumber}
                          </span>
                          <StatusChip status={run.status} />
                          <span className="shrink-0 text-[11px] tabular-nums text-fg-tertiary">
                            {runProgress.total > 0
                              ? `${runProgress.done}/${runProgress.total}`
                              : t('work:task.workflowStepCountShort', '{{count}} 个任务', {
                                  count: run.taskIds.length,
                                })}
                          </span>
                          <span className="shrink-0 text-[11px] text-fg-quaternary">
                            {timeAgo(run.startedAt, t)}
                          </span>
                          {run.triggeredBy === 'schedule' ? (
                            <span className="shrink-0 text-[10px] text-purple-500">
                              {t('work:task.workflowScheduled', '定时')}
                            </span>
                          ) : null}
                          <span className="flex-1" />
                          <svg
                            className="h-3.5 w-3.5 shrink-0 text-fg-quaternary opacity-0 transition-opacity group-hover:opacity-100"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={2}
                            aria-hidden="true"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                          </svg>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        )}
      </Disclosure>

      {openStep ? (
        <WorkflowStepModal
          step={openStep.step}
          index={openStep.index}
          total={steps.length}
          dependsOnNames={dependsOnNames(openStep.step, buildStepIndex(steps))}
          onClose={() => setOpenStep(null)}
          onSave={(patch) => onSaveStep?.(openStep.step.id, patch) ?? Promise.resolve()}
        />
      ) : null}
    </div>
  );
}

export default WorkflowCard;
