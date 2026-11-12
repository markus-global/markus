/**
 * 评审进展 tab 里的单轮评审卡片：头部是结论，展开后是该轮评审的**全过程**
 * （正文 / 思考 / 工具调用），复用 `FullExecutionLog` —— 和「执行日志」同一套渲染器，
 * 但喂的是**评审人自己的回合**数据，不是执行者的。
 *
 * 历史教训：这个 tab 曾经直接渲染 `<TaskExecutionLogs>`，两个 tab 内容一模一样。
 * 复用渲染器是对的，复用**同一份数据**才是错的。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, activityLogToStreamEntry } from '../api.ts';
import {
  CompactExecutionCard,
  FullExecutionLog,
  type ExecutionStreamEntryUI,
} from './ExecutionTimeline.tsx';
import { matchReviewActivities } from '../lib/reviewActivities.ts';
import type { ReviewSession } from '../lib/taskReview.ts';

export function ReviewSessionCard({ session, taskId }: { session: ReviewSession; taskId: string }) {
  const { t } = useTranslation('work');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [entries, setEntries] = useState<ExecutionStreamEntryUI[]>([]);
  const [loaded, setLoaded] = useState(false);
  /**
   * 两态跟执行日志的每一轮完全一致：
   *   compact = 一行摘要（点开才看？不，这一层已经是卡内展开后了）
   *   full    = 正文可见、思考与工具调用各自折叠（点那一行才展开）
   * 直接上 `FullExecutionLog` 会把思考/工具全铺开，所以默认走 compact，再点进 full。
   */
  const [viewMode, setViewMode] = useState<'compact' | 'full'>('compact');
  /**
   * In-flight guard as a REF, never state.
   *
   * History: this was `loading` in the dependency array AND set inside the effect, so
   * `setLoading(true)` re-ran the effect, the cleanup flipped `cancelled = true`, and the
   * terminal `setLoading(false)/setLoaded(true)` were guarded out — the card sat on
   * "loading…" forever. A self-referential dependency can never settle.
   */
  const inFlight = useRef(false);

  const live = session.status === 'reviewing';

  useEffect(() => {
    // 换轮次/换卡就重置，避免串数据
    setOpen(false);
    setEntries([]);
    setLoaded(false);
    setViewMode('compact');
    inFlight.current = false;
  }, [session.id, taskId]);

  useEffect(() => {
    if (!open || loaded) return;
    if (inFlight.current) return;
    inFlight.current = true;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        // limit is generous on purpose: the window fallback has to be able to reach
        // historical rows that predate taskId attribution.
        const { activities } = await api.agents.getActivities(session.reviewerId, { limit: 200 });
        const matched = matchReviewActivities(activities, {
          taskId,
          queuedAt: session.queuedAt,
          completedAt: session.completedAt,
        });
        const collected: ExecutionStreamEntryUI[] = [];
        for (const act of matched) {
          const { logs } = await api.agents.getActivityLogs(session.reviewerId, act.id);
          for (const log of logs) {
            const e = activityLogToStreamEntry(log, act.id, session.reviewerId);
            if (!e) continue;
            // ExecutionStreamEntryAPI 与 UI 形状一致；显式转一层避免跨层类型漂移
            collected.push(e as unknown as ExecutionStreamEntryUI);
          }
        }
        if (!cancelled) setEntries(collected);
      } catch {
        if (!cancelled) setEntries([]);
      } finally {
        inFlight.current = false;
        // Always settle the UI. `cancelled` only guards writes, never the spinner.
        if (!cancelled) {
          setLoading(false);
          setLoaded(true);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [open, loaded, session.reviewerId, session.queuedAt, session.completedAt, taskId]);

  const outcomeLabel = useMemo(() => {
    if (live) return t('task.reviewLive');
    if (session.outcome === 'approved') return t('task.reviewOutcomeApproved');
    if (session.outcome === 'revision_requested') return t('task.reviewOutcomeRevision');
    return t('task.reviewOutcomeClosed');
  }, [live, session.outcome, t]);

  const badgeTone = live
    ? 'text-purple-400 border-purple-500/30'
    : session.outcome === 'approved'
      ? 'text-green-500 border-green-500/30'
      : 'text-amber-500 border-amber-500/30';

  return (
    <div className="rounded-md border border-border-subtle bg-surface-elevated/40">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] hover:bg-surface-elevated/70 transition-colors"
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${live ? 'bg-purple-400 animate-pulse' : session.outcome === 'approved' ? 'bg-green-400' : 'bg-amber-400'}`} />
        <span className="font-medium text-fg-secondary">{session.reviewerName}</span>
        <span className="text-fg-tertiary">{t('task.reviewRound', { round: session.round })}</span>
        <span className={`ml-auto shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${badgeTone}`}>{outcomeLabel}</span>
        <span className="shrink-0 text-fg-tertiary">{open ? '▾' : '▸'}</span>
      </button>

      <div className="px-3 pb-2 text-[10px] text-fg-tertiary">
        {new Date(session.queuedAt).toLocaleString()}
        {session.completedAt ? ` → ${new Date(session.completedAt).toLocaleString()}` : ''}
        {session.decidedByName ? ` · ${t('task.reviewDecidedBy', { name: session.decidedByName })}` : ''}
      </div>

      {session.note && !open && (
        <p className="px-3 pb-2 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-fg-secondary">{session.note}</p>
      )}

      {open && (
        <div className="border-t border-border-subtle px-3 py-2">
          {session.note && (
            <p className="mb-2 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-fg-secondary">{session.note}</p>
          )}
          {live && <div className="mb-1 text-[10px] text-purple-400">{t('task.reviewLive')}</div>}
          {loading && <div className="py-2 text-[11px] italic text-fg-tertiary">{t('task.reviewLoading')}</div>}
          {!loading && loaded && entries.length === 0 && (
            <div className="py-2 text-[11px] italic text-fg-tertiary">{t('task.reviewNoTurns')}</div>
          )}
          {entries.length > 0 && (
            viewMode === 'compact' ? (
              <CompactExecutionCard
                entries={entries}
                isActive={live}
                onExpand={() => setViewMode('full')}
                embedded
              />
            ) : (
              <FullExecutionLog
                entries={entries}
                isActive={live}
                onCollapse={() => setViewMode('compact')}
                embedded
                expandThinking={false}
                showRounds={false}
              />
            )
          )}
        </div>
      )}
    </div>
  );
}
