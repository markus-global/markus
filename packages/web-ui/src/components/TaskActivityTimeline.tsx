/**
 * 任务详情页「活动」tab：执行轮次与评审轮次合成一条时间线。
 *
 * 每一条自己带编号：**「第 N 轮执行」/「第 N 轮评审」**，两套编号各算各的，
 * 不去造一个假的全局轮次（那样两个体系会互相覆盖）。
 *
 * 渲染复用已有两态：CompactExecutionCard（一行摘要）⇄ FullExecutionLog（全过程，
 * 正文可见、思考与工具各自折叠）。评审那一侧复用 ReviewSessionCard。
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, taskLogToStreamEntry } from '../api.ts';
import { FullExecutionLog, type ExecutionStreamEntryUI } from './ExecutionTimeline.tsx';
import { ReviewSessionCard } from './ReviewSessionCard.tsx';
import { buildActivityTimeline, type ActivityFilter } from '../lib/activityTimeline.ts';
import type { ReviewSession } from '../lib/taskReview.ts';
import type { RoundSummary } from '../api.ts';

export function TaskActivityTimeline({
  taskId,
  reviewSessions,
}: {
  taskId: string;
  reviewSessions: ReviewSession[];
}) {
  const { t } = useTranslation('work');
  const [rounds, setRounds] = useState<RoundSummary[]>([]);
  const [filter, setFilter] = useState<ActivityFilter>('all');

  useEffect(() => {
    let cancelled = false;
    api.tasks.getLogsSummary(taskId)
      .then(d => { if (!cancelled) setRounds(d.rounds ?? []); })
      .catch(() => { if (!cancelled) setRounds([]); });
    return () => { cancelled = true; };
  }, [taskId]);

  const items = useMemo(
    () => buildActivityTimeline(rounds, reviewSessions, filter),
    [rounds, reviewSessions, filter],
  );

  const chip = (f: ActivityFilter, label: string) => (
    <button
      key={f}
      type="button"
      onClick={() => setFilter(f)}
      className={`rounded px-2 py-0.5 text-[10px] transition-colors ${filter === f ? 'bg-surface-elevated text-fg-primary font-medium' : 'text-fg-tertiary hover:text-fg-secondary'}`}
    >
      {label}
    </button>
  );

  return (
    <div className="px-6 pt-3 pb-4">
      <div className="mb-2 flex items-center gap-1">
        {chip('all', t('task.activityFilterAll'))}
        {chip('execution', t('task.activityFilterExecution'))}
        {chip('review', t('task.activityFilterReview'))}
      </div>

      {items.length === 0 ? (
        <div className="py-6 text-xs italic text-fg-tertiary">{t('task.activityEmpty')}</div>
      ) : (
        <div className="space-y-2">
          {items.map(item =>
            item.kind === 'review' ? (
              <div key={item.key}>
                <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-fg-tertiary">
                  {t('task.reviewRoundLabel', { round: item.round })}
                </div>
                <ReviewSessionCard session={item.session} taskId={taskId} />
              </div>
            ) : (
              <ExecutionRoundCard key={item.key} taskId={taskId} item={item} label={t('task.executionRoundLabel', { round: item.round })} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** 一轮执行：折叠一行摘要 → 展开加载该轮日志（正文可见、思考/工具折叠）。 */
function ExecutionRoundCard({
  taskId, item, label,
}: {
  taskId: string;
  item: { round: number; startedAt: string; endedAt: string | null; toolCount: number; logCount: number; status: string };
  label: string;
}) {
  const { t } = useTranslation('work');
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<ExecutionStreamEntryUI[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!open || loaded) return;
    let cancelled = false;
    api.tasks.getLogs(taskId, item.round)
      .then(d => {
        if (cancelled) return;
        setEntries((d.logs ?? []).map(l => taskLogToStreamEntry(l) as unknown as ExecutionStreamEntryUI));
        setLoaded(true);
      })
      .catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [open, loaded, taskId, item.round]);

  return (
    <div className="rounded-md border border-border-subtle bg-surface-elevated/40">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] transition-colors hover:bg-surface-elevated/70"
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-400" />
        <span className="font-medium text-fg-secondary">{label}</span>
        <span className="text-fg-tertiary">{t('task.executionToolCount', { count: item.toolCount })}</span>
        <span className="ml-auto shrink-0 text-[10px] text-fg-tertiary">
          {new Date(item.startedAt).toLocaleString()}
        </span>
        <span className="shrink-0 text-fg-tertiary">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="border-t border-border-subtle px-3 py-2">
          {!loaded && <div className="py-2 text-[11px] italic text-fg-tertiary">{t('task.reviewLoading')}</div>}
          {loaded && entries.length === 0 && (
            <div className="py-2 text-[11px] italic text-fg-tertiary">{t('task.noExecutionLogAvailable')}</div>
          )}
          {entries.length > 0 && (
            // 和执行日志完全同一种形式：一条时间线，正文与折叠的思考/工具行相间出现。
            // 不要再套一层 CompactExecutionCard —— 那会把整轮压成一坨摘要。
            <FullExecutionLog
              entries={entries}
              isActive={false}
              embedded
              expandThinking={false}
              showRounds={false}
            />
          )}
        </div>
      )}
    </div>
  );
}
