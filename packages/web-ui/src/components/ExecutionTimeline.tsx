/**
 * Unified Execution Timeline — shared component rendering for agent tool calls,
 * text output, status changes, and errors across all views.
 *
 * Non-component utilities (types, converters, helpers) live in execution-utils.ts
 * to keep this file components-only for Vite HMR Fast Refresh compatibility.
 */
import { useState, useRef, useEffect, useCallback, memo, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { api, wsClient, type TaskLogEntry } from '../api.ts';
import { navBus } from '../navBus.ts';
import { PAGE } from '../routes.ts';
import { MarkdownMessage } from './MarkdownMessage.tsx';
import { CodingToolCard, type CodingToolSession } from './CodingToolCard.tsx';
import {
  getToolMeta, getShellCommand, formatDuration, formatLogTime, truncate, prettyJson, formatArgsDetail,
  filterCompletedStarts, streamEntryToExecEntry, taskLogToEntry,
  parseTaskApprovalFromResult, parseRequirementApprovalFromResult,
  type SubagentLogEntry, type ToolCallInfo, type ExecEntry, type ExecutionStreamEntryUI,
  type TaskApprovalInfo, type RequirementApprovalInfo,
} from './execution-utils.ts';

// Re-export everything from execution-utils so existing imports keep working
export {
  getToolMeta, formatDuration, formatLogTime,
  taskLogToEntry, activityLogToEntry, attachSubagentLogsToEntries, filterCompletedStarts,
  streamEntryToExecEntry, parseTaskApprovalFromResult, parseRequirementApprovalFromResult,
  type SubagentLogEntry, type ToolCallInfo, type ExecEntry, type ExecutionStreamEntryUI,
  type TaskApprovalInfo, type RequirementApprovalInfo,
} from './execution-utils.ts';

// All types, tool metadata, format helpers, conversion functions, and filters
// are now in execution-utils.ts — imported and re-exported above.

// ─── ThinkingDots ─────────────────────────────────────────────────────────────

export function ThinkingDots({ label }: { label?: string }) {
  const { t } = useTranslation('common');
  return (
    <div className="flex items-center gap-1.5 text-xs text-fg-secondary py-0.5">
      <span>{label ?? t('execution.thinking')}</span>
      <span className="flex gap-0.5">
        {[0, 150, 300].map(d => (
          <span key={d} className="w-1 h-1 rounded-full bg-brand-400 animate-bounce"
            style={{ animationDelay: `${d}ms`, animationDuration: '1s' }} />
        ))}
      </span>
    </div>
  );
}

// ─── StreamingText ────────────────────────────────────────────────────────────

const STREAM_THROTTLE_MS = 150;

export function StreamingText({ content, className }: { content: string; className?: string }) {
  const [throttled, setThrottled] = useState(content);
  const lastUpdate = useRef(0);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const now = Date.now();
    const elapsed = now - lastUpdate.current;
    if (elapsed >= STREAM_THROTTLE_MS) {
      lastUpdate.current = now;
      setThrottled(content);
    } else if (!pending.current) {
      pending.current = setTimeout(() => {
        lastUpdate.current = Date.now();
        pending.current = null;
        setThrottled(content);
      }, STREAM_THROTTLE_MS - elapsed);
    }
    return () => { if (pending.current) { clearTimeout(pending.current); pending.current = null; } };
  }, [content]);

  const displayContent = useMemo(() => throttled, [throttled]);

  return (
    <div className="bg-surface-elevated/50 rounded-lg px-3 py-2.5 my-1 min-w-0 overflow-hidden">
      <MarkdownMessage content={displayContent} className={className ?? 'text-sm text-fg-secondary break-words'} />
      <span className="inline-block w-0.5 h-4 bg-brand-400 animate-pulse ml-0.5 align-middle" />
    </div>
  );
}


// ─── Tool Detail Modal ────────────────────────────────────────────────────────

function ToolDetailModal({ info, onClose }: { info: ToolCallInfo; onClose: () => void }) {
  const { t } = useTranslation('common');
  const meta = getToolMeta(info.tool);
  const argEntries = formatArgsDetail(info.args);
  const isRunning = info.status === 'running';
  const success = info.status !== 'error';

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div className="relative bg-surface-secondary border border-border-default rounded-xl shadow-2xl w-[560px] max-w-[92vw] max-h-[80vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-border-default flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <span className="opacity-60 text-sm">{meta.icon}</span>
            <span className={`text-sm font-semibold ${isRunning ? 'text-brand-500' : success ? 'text-fg-primary' : 'text-red-500'}`}>{meta.label}</span>
            <span className={`text-xs px-1.5 py-0.5 rounded ${isRunning ? 'bg-brand-500/15 text-brand-500' : success ? 'bg-green-500/15 text-green-600' : 'bg-red-500/15 text-red-500'}`}>
              {isRunning ? t('execution.toolRunning') : success ? t('execution.toolSuccess') : t('execution.toolFailed')}
            </span>
          </div>
          <div className="flex items-center gap-3">
            {info.durationMs != null && <span className="text-xs text-fg-tertiary">{formatDuration(info.durationMs)}</span>}
            <button onClick={onClose} className="text-fg-tertiary hover:text-fg-secondary text-lg leading-none">×</button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {argEntries.length > 0 && (
            <div>
              <h4 className="text-[10px] font-semibold text-fg-tertiary uppercase tracking-wider mb-2">{t('execution.arguments')}</h4>
              <div className="space-y-2">
                {argEntries.map(({ key, value }) => (
                  <div key={key}>
                    <div className="text-[11px] text-brand-500 font-medium mb-0.5">{key}</div>
                    <pre className="text-xs text-fg-secondary bg-surface-elevated/70 rounded-lg px-3 py-2 overflow-x-auto max-h-80 overflow-y-auto whitespace-pre-wrap break-all font-mono">{value}</pre>
                  </div>
                ))}
              </div>
            </div>
          )}
          {!isRunning && info.result && (
            <div>
              <h4 className="text-[10px] font-semibold text-fg-tertiary uppercase tracking-wider mb-2">{t('execution.result')}</h4>
              <pre className="text-xs text-fg-secondary bg-surface-elevated/70 rounded-lg px-3 py-2 overflow-x-auto overflow-y-auto max-h-[60vh] whitespace-pre-wrap break-all font-mono">{prettyJson(info.result)}</pre>
            </div>
          )}
          {!isRunning && info.error && (
            <div>
              <h4 className="text-[10px] font-semibold text-red-500 uppercase tracking-wider mb-2">{t('execution.error')}</h4>
              <pre className="text-xs text-red-500 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 overflow-x-auto max-h-60 overflow-y-auto whitespace-pre-wrap break-all font-mono">{prettyJson(String(info.error))}</pre>
            </div>
          )}
          {info.subagentLogs && info.subagentLogs.length > 0 && (
            <div>
              <h4 className="text-[10px] font-semibold text-fg-tertiary uppercase tracking-wider mb-2">{t('execution.subagentExecution')}</h4>
              <div className="bg-surface-elevated/50 rounded-lg px-3 py-2 space-y-1 max-h-[50vh] overflow-y-auto">
                {info.subagentLogs.map((log, idx) => {
                  const icon = log.eventType === 'started' ? '▶' : log.eventType === 'completed' ? '✓' : log.eventType === 'error' ? '✗' : log.eventType === 'tool_start' ? '◎' : log.eventType === 'tool_end' ? '●' : log.eventType === 'thinking' ? '💭' : '→';
                  const color = log.eventType === 'error' ? 'text-red-500' : log.eventType === 'completed' ? 'text-green-500' : log.eventType === 'started' ? 'text-brand-500' : 'text-fg-tertiary';
                  return (
                    <div key={idx} className="flex items-start gap-1.5 text-xs">
                      <span className={`shrink-0 ${color}`}>{icon}</span>
                      <span className={`font-mono break-all ${color}`}>{log.content}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {!argEntries.length && !isRunning && !info.result && !info.error && !(info.subagentLogs?.length) && (
            <div className="text-sm text-fg-tertiary italic py-4 text-center">{t('execution.noToolDetail')}</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── TaskApprovalCard — inline approval UI for pending tasks ────────

const APPROVAL_PRIORITY_COLORS: Record<string, string> = {
  urgent: 'text-red-500',
  high: 'text-amber-500',
  medium: 'text-blue-500',
  low: 'text-fg-tertiary',
};

type TaskCardState = 'loading' | 'pending' | 'approving' | 'rejecting' | 'in_progress' | 'completed' | 'review' | 'blocked' | 'failed' | 'cancelled' | 'archived';

const TASK_STATUS_TO_CARD_STATE: Record<string, TaskCardState> = {
  pending: 'pending',
  in_progress: 'in_progress',
  completed: 'completed',
  review: 'review',
  blocked: 'blocked',
  failed: 'failed',
  cancelled: 'cancelled',
  archived: 'archived',
};

const TASK_STATUS_CONFIG: Record<string, { icon: string; labelKey: string; borderClass: string; bgClass: string; badgeClass: string; textClass: string }> = {
  pending:     { icon: '⏳', labelKey: 'execution.card.pendingApproval', borderClass: 'border-amber-500/40',       bgClass: 'bg-amber-500/5',          badgeClass: 'bg-amber-500/15 text-amber-600', textClass: '' },
  approving:   { icon: '⏳', labelKey: 'execution.card.approving',      borderClass: 'border-amber-500/40',       bgClass: 'bg-amber-500/5',          badgeClass: 'bg-amber-500/15 text-amber-600', textClass: '' },
  rejecting:   { icon: '⏳', labelKey: 'execution.card.rejecting',      borderClass: 'border-amber-500/40',       bgClass: 'bg-amber-500/5',          badgeClass: 'bg-amber-500/15 text-amber-600', textClass: '' },
  in_progress: { icon: '▶',  labelKey: 'execution.card.inProgress',     borderClass: 'border-blue-500/40',        bgClass: 'bg-blue-500/5',           badgeClass: 'bg-blue-500/15 text-blue-500',   textClass: 'text-blue-500' },
  completed:   { icon: '✅', labelKey: 'execution.card.completed',      borderClass: 'border-green-500/30',       bgClass: 'bg-green-500/5',          badgeClass: 'bg-green-500/15 text-green-500', textClass: 'text-green-500' },
  review:      { icon: '👀', labelKey: 'execution.card.inReview',       borderClass: 'border-purple-500/40',      bgClass: 'bg-purple-500/5',         badgeClass: 'bg-purple-500/15 text-purple-500', textClass: 'text-purple-500' },
  blocked:     { icon: '🚫', labelKey: 'execution.card.blocked',        borderClass: 'border-orange-500/40',      bgClass: 'bg-orange-500/5',         badgeClass: 'bg-orange-500/15 text-orange-500', textClass: 'text-orange-500' },
  failed:      { icon: '❌', labelKey: 'execution.card.failed',         borderClass: 'border-red-500/30',         bgClass: 'bg-red-500/5',            badgeClass: 'bg-red-500/15 text-red-500',     textClass: 'text-red-500' },
  cancelled:   { icon: '⊘',  labelKey: 'execution.card.cancelled',     borderClass: 'border-border-default/40',  bgClass: 'bg-surface-secondary/30', badgeClass: 'bg-surface-elevated text-fg-tertiary', textClass: 'text-fg-tertiary' },
  archived:    { icon: '📦', labelKey: 'execution.card.archived',       borderClass: 'border-border-default/40',  bgClass: 'bg-surface-secondary/30', badgeClass: 'bg-surface-elevated text-fg-tertiary', textClass: 'text-fg-tertiary' },
  loading:     { icon: '⏳', labelKey: 'execution.card.loading',        borderClass: 'border-border-default/40',  bgClass: 'bg-surface-secondary/30', badgeClass: 'bg-surface-elevated text-fg-tertiary', textClass: '' },
};

export function TaskApprovalCard({ info }: { info: TaskApprovalInfo }) {
  const { t } = useTranslation('common');
  const [cardState, setCardState] = useState<TaskCardState>('loading');

  useEffect(() => {
    let cancelled = false;
    api.tasks.get(info.taskId).then(({ task }) => {
      if (cancelled) return;
      setCardState(TASK_STATUS_TO_CARD_STATE[task.status] ?? 'pending');
    }).catch(() => {
      if (!cancelled) setCardState('pending');
    });
    return () => { cancelled = true; };
  }, [info.taskId]);

  useEffect(() => {
    return wsClient.on('task:update', (event) => {
      const p = event.payload;
      if ((p['taskId'] as string) === info.taskId && p['status']) {
        setCardState(TASK_STATUS_TO_CARD_STATE[p['status'] as string] ?? 'pending');
      }
    });
  }, [info.taskId]);

  const markNotifRead = () => {
    window.dispatchEvent(new CustomEvent('markus:mark-read-by-ref', { detail: { taskId: info.taskId } }));
  };

  const handleApprove = async () => {
    setCardState('approving');
    try {
      await api.tasks.approve(info.taskId);
      setCardState('in_progress');
      markNotifRead();
    } catch {
      setCardState('pending');
    }
  };

  const handleReject = async () => {
    setCardState('rejecting');
    try {
      await api.tasks.reject(info.taskId);
      setCardState('cancelled');
      markNotifRead();
    } catch {
      setCardState('pending');
    }
  };

  const isPending = cardState === 'pending' || cardState === 'approving' || cardState === 'rejecting';
  const cfg = TASK_STATUS_CONFIG[cardState] ?? TASK_STATUS_CONFIG['loading']!;

  const goToTask = () => navBus.navigate(PAGE.WORK, { openTask: info.taskId });

  return (
    <div className={`my-2 rounded-lg border ${cfg.borderClass} ${cfg.bgClass} p-3 max-w-md transition-colors`}>
      <div className="flex items-start gap-2 mb-1 cursor-pointer group" role="button" tabIndex={0} onClick={goToTask} onKeyDown={e => e.key === 'Enter' && goToTask()}>
        <span className="text-sm mt-0.5">{cfg.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${cfg.badgeClass}`}>{t('execution.taskBadge')}</span>
            {!isPending && cardState !== 'loading' && (
              <span className={`text-[10px] font-medium ${cfg.textClass}`}>{t(cfg.labelKey)}</span>
            )}
          </div>
          <div className={`text-sm font-medium truncate mt-1 group-hover:underline ${!isPending && cardState !== 'loading' ? 'text-fg-secondary' : 'text-fg-primary'}`}>{info.title}</div>
          {info.description && (
            <div className="text-xs text-fg-secondary mt-0.5 line-clamp-2">{info.description}</div>
          )}
          <div className="flex items-center gap-2 mt-1.5 text-[11px] text-fg-tertiary">
            {info.priority && (
              <span className={APPROVAL_PRIORITY_COLORS[info.priority] ?? 'text-fg-tertiary'}>
                {t(`priority.${info.priority}`, { defaultValue: info.priority })}
              </span>
            )}
            <span className="opacity-50">{t('execution.idPrefix', { id: info.taskId.slice(0, 8) })}</span>
          </div>
        </div>
      </div>

      {isPending && (
        <div className="flex items-center gap-2 mt-2 pt-2 border-t border-border-default/30">
          <button
            onClick={handleApprove}
            disabled={cardState !== 'pending'}
            className="flex-1 px-3 py-1.5 text-xs font-medium rounded-md bg-green-600 hover:bg-green-500 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {cardState === 'approving' ? t('execution.card.approving') : t('approve')}
          </button>
          <button
            onClick={handleReject}
            disabled={cardState !== 'pending'}
            className="flex-1 px-3 py-1.5 text-xs font-medium rounded-md bg-surface-elevated hover:bg-surface-overlay text-fg-secondary border border-border-default transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {cardState === 'rejecting' ? t('execution.card.rejecting') : t('reject')}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── RequirementApprovalCard — inline approval for proposed requirements ──────

type ReqCardState = 'loading' | 'pending' | 'approving' | 'rejecting' | 'in_progress' | 'completed' | 'rejected' | 'cancelled' | 'archived';

const REQ_STATUS_TO_CARD_STATE: Record<string, ReqCardState> = {
  pending: 'pending',
  in_progress: 'in_progress',
  completed: 'completed',
  rejected: 'rejected',
  cancelled: 'cancelled',
  archived: 'archived',
};

const REQ_STATUS_CONFIG: Record<string, { icon: string; labelKey: string; borderClass: string; bgClass: string; badgeClass: string; textClass: string }> = {
  pending:     { icon: '📋', labelKey: 'execution.card.pendingApproval', borderClass: 'border-amber-500/40',       bgClass: 'bg-amber-500/5',          badgeClass: 'bg-amber-500/15 text-amber-600', textClass: '' },
  approving:   { icon: '⏳', labelKey: 'execution.card.approving',      borderClass: 'border-amber-500/40',       bgClass: 'bg-amber-500/5',          badgeClass: 'bg-amber-500/15 text-amber-600', textClass: '' },
  rejecting:   { icon: '⏳', labelKey: 'execution.card.rejecting',      borderClass: 'border-amber-500/40',       bgClass: 'bg-amber-500/5',          badgeClass: 'bg-amber-500/15 text-amber-600', textClass: '' },
  in_progress: { icon: '▶',  labelKey: 'execution.card.inProgress',     borderClass: 'border-blue-500/40',        bgClass: 'bg-blue-500/5',           badgeClass: 'bg-blue-500/15 text-blue-500',   textClass: 'text-blue-500' },
  completed:   { icon: '✅', labelKey: 'execution.card.completed',      borderClass: 'border-green-500/30',       bgClass: 'bg-green-500/5',          badgeClass: 'bg-green-500/15 text-green-500', textClass: 'text-green-500' },
  rejected:    { icon: '❌', labelKey: 'execution.card.rejected',       borderClass: 'border-red-500/30',         bgClass: 'bg-red-500/5',            badgeClass: 'bg-red-500/15 text-red-500',     textClass: 'text-red-500' },
  cancelled:   { icon: '⊘',  labelKey: 'execution.card.cancelled',     borderClass: 'border-border-default/40',  bgClass: 'bg-surface-secondary/30', badgeClass: 'bg-surface-elevated text-fg-tertiary', textClass: 'text-fg-tertiary' },
  archived:    { icon: '📦', labelKey: 'execution.card.archived',       borderClass: 'border-border-default/40',  bgClass: 'bg-surface-secondary/30', badgeClass: 'bg-surface-elevated text-fg-tertiary', textClass: 'text-fg-tertiary' },
  loading:     { icon: '⏳', labelKey: 'execution.card.loading',        borderClass: 'border-border-default/40',  bgClass: 'bg-surface-secondary/30', badgeClass: 'bg-surface-elevated text-fg-tertiary', textClass: '' },
};

const REQ_WS_EVENTS = [
  'requirement:approved', 'requirement:rejected', 'requirement:updated',
  'requirement:completed', 'requirement:cancelled', 'requirement:resubmitted',
] as const;

export function RequirementApprovalCard({ info }: { info: RequirementApprovalInfo }) {
  const { t } = useTranslation('common');
  const [cardState, setCardState] = useState<ReqCardState>('loading');
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectInput, setShowRejectInput] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.requirements.get(info.requirementId).then(({ requirement }) => {
      if (cancelled) return;
      setCardState(REQ_STATUS_TO_CARD_STATE[requirement.status] ?? 'pending');
    }).catch(() => {
      if (!cancelled) setCardState('pending');
    });
    return () => { cancelled = true; };
  }, [info.requirementId]);

  useEffect(() => {
    const unsubs = REQ_WS_EVENTS.map(evt =>
      wsClient.on(evt, (event) => {
        const p = event.payload as Record<string, unknown>;
        if ((p['id'] as string) === info.requirementId && p['status']) {
          setCardState(REQ_STATUS_TO_CARD_STATE[p['status'] as string] ?? 'pending');
        }
      })
    );
    return () => unsubs.forEach(fn => fn());
  }, [info.requirementId]);

  const markNotifRead = () => {
    window.dispatchEvent(new CustomEvent('markus:mark-read-by-ref', { detail: { requirementId: info.requirementId } }));
  };

  const handleApprove = async () => {
    setCardState('approving');
    try {
      await api.requirements.approve(info.requirementId);
      setCardState('in_progress');
      markNotifRead();
    } catch {
      setCardState('pending');
    }
  };

  const handleReject = async () => {
    if (!showRejectInput) {
      setShowRejectInput(true);
      return;
    }
    if (!rejectReason.trim()) return;
    setCardState('rejecting');
    try {
      await api.requirements.reject(info.requirementId, rejectReason.trim());
      setCardState('rejected');
      markNotifRead();
    } catch {
      setCardState('pending');
    }
  };

  const isPending = cardState === 'pending' || cardState === 'approving' || cardState === 'rejecting';
  const cfg = REQ_STATUS_CONFIG[cardState] ?? REQ_STATUS_CONFIG['loading']!;

  const goToReq = () => navBus.navigate(PAGE.WORK, { openRequirement: info.requirementId });

  return (
    <div className={`my-2 rounded-lg border ${cfg.borderClass} ${cfg.bgClass} p-3 max-w-md transition-colors`}>
      <div className="flex items-start gap-2 mb-1 cursor-pointer group" role="button" tabIndex={0} onClick={goToReq} onKeyDown={e => e.key === 'Enter' && goToReq()}>
        <span className="text-sm mt-0.5">{cfg.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${cfg.badgeClass}`}>{t('execution.reqBadge')}</span>
            {!isPending && cardState !== 'loading' && (
              <span className={`text-[10px] font-medium ${cfg.textClass}`}>{t(cfg.labelKey)}</span>
            )}
          </div>
          <div className={`text-sm font-medium truncate mt-1 group-hover:underline ${!isPending && cardState !== 'loading' ? 'text-fg-secondary' : 'text-fg-primary'}`}>{info.title}</div>
          {info.description && (
            <div className="text-xs text-fg-secondary mt-0.5 line-clamp-3">{info.description}</div>
          )}
          <div className="flex items-center gap-2 mt-1.5 text-[11px] text-fg-tertiary">
            {info.priority && (
              <span className={APPROVAL_PRIORITY_COLORS[info.priority] ?? 'text-fg-tertiary'}>
                {t(`priority.${info.priority}`, { defaultValue: info.priority })}
              </span>
            )}
            <span className="opacity-50">{t('execution.idPrefix', { id: info.requirementId.slice(0, 8) })}</span>
          </div>
        </div>
      </div>

      {isPending && (
        <div className="mt-2 pt-2 border-t border-border-default/30 space-y-2">
          {showRejectInput && (
            <input
              type="text"
              value={rejectReason}
              onChange={e => setRejectReason(e.target.value)}
              placeholder={t('execution.rejectionReasonPlaceholder')}
              className="w-full px-2 py-1.5 text-xs rounded-md bg-surface-secondary border border-border-default text-fg-primary placeholder:text-fg-tertiary focus:outline-none focus:border-brand-500"
              onKeyDown={e => e.key === 'Enter' && handleReject()}
              autoFocus
            />
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={handleApprove}
              disabled={cardState !== 'pending'}
              className="flex-1 px-3 py-1.5 text-xs font-medium rounded-md bg-green-600 hover:bg-green-500 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {cardState === 'approving' ? t('execution.card.approving') : t('approve')}
            </button>
            <button
              onClick={handleReject}
              disabled={cardState !== 'pending' || (showRejectInput && !rejectReason.trim())}
              className="flex-1 px-3 py-1.5 text-xs font-medium rounded-md bg-surface-elevated hover:bg-surface-overlay text-fg-secondary border border-border-default transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {cardState === 'rejecting' ? t('execution.card.rejecting') : t('reject')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── CodingToolDetailModal — rich detail view for coding tool invocations ─────

const CODING_TOOL_META: Record<string, { label: string; badgeClass: string }> = {
  'claude-code': { label: 'Claude Code', badgeClass: 'bg-orange-500/15 text-orange-500' },
  codex: { label: 'Codex', badgeClass: 'bg-emerald-500/15 text-emerald-500' },
  'cursor-agent': { label: 'Cursor', badgeClass: 'bg-blue-500/15 text-blue-500' },
};

function CodingToolDetailModal({ session, info, onClose }: { session: CodingToolSession; info: ToolCallInfo; onClose: () => void }) {
  const args = (info.args && typeof info.args === 'object' && !Array.isArray(info.args))
    ? info.args as Record<string, unknown>
    : {};
  const isRunning = session.status === 'running' || session.status === 'created' || session.status === 'context_injected';
  const isFailed = session.status === 'failed' || session.status === 'timeout';
  const isSuccess = session.status === 'completed';
  const toolMeta = CODING_TOOL_META[session.tool] ?? { label: session.tool, badgeClass: 'bg-surface-elevated text-fg-tertiary' };
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const durationMs = session.cost?.durationMs ?? info.durationMs;
  const modelUsed = typeof args.model === 'string' ? args.model : undefined;
  const modeUsed = typeof args.mode === 'string' ? args.mode : undefined;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div className="relative bg-surface-secondary border border-border-default rounded-xl shadow-2xl w-[640px] max-w-[92vw] max-h-[80vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="px-5 py-3 border-b border-border-default flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-xs px-2 py-0.5 rounded font-medium ${toolMeta.badgeClass}`}>{toolMeta.label}</span>
            <span className={`text-xs px-1.5 py-0.5 rounded ${isRunning ? 'bg-brand-500/15 text-brand-500' : isSuccess ? 'bg-green-500/15 text-green-600' : 'bg-red-500/15 text-red-500'}`}>
              {isRunning ? 'Running' : isSuccess ? 'Completed' : isFailed ? 'Failed' : session.status}
            </span>
            {durationMs != null && <span className="text-xs text-fg-tertiary tabular-nums">{formatDuration(durationMs)}</span>}
            {modelUsed && <span className="text-[10px] bg-surface-elevated px-1.5 py-0.5 rounded text-fg-tertiary font-mono">{modelUsed}</span>}
            {modeUsed && <span className="text-[10px] bg-surface-elevated px-1.5 py-0.5 rounded text-fg-tertiary">{modeUsed}</span>}
          </div>
          <button onClick={onClose} className="text-fg-tertiary hover:text-fg-secondary text-lg leading-none ml-2">×</button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Prompt */}
          <div>
            <h4 className="text-[10px] font-semibold text-fg-tertiary uppercase tracking-wider mb-2">Prompt</h4>
            <pre className="text-xs text-fg-secondary bg-surface-elevated/70 rounded-lg px-3 py-2 overflow-x-auto max-h-40 overflow-y-auto whitespace-pre-wrap break-all font-mono">
              {session.prompt}
            </pre>
          </div>

          {/* Input arguments */}
          {Object.keys(args).length > 0 && (
            <div>
              <h4 className="text-[10px] font-semibold text-fg-tertiary uppercase tracking-wider mb-2">Input Arguments</h4>
              <div className="space-y-1.5">
                {Object.entries(args).filter(([k]) => k !== 'prompt').map(([key, value]) => (
                  <div key={key} className="flex items-start gap-2 text-xs">
                    <span className="text-brand-500 font-medium shrink-0 font-mono">{key}:</span>
                    <span className="text-fg-secondary font-mono break-all">{typeof value === 'string' ? value : JSON.stringify(value)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Result */}
          {session.result && !isRunning && (
            <div>
              <h4 className="text-[10px] font-semibold text-fg-tertiary uppercase tracking-wider mb-2">Result</h4>
              <div className="space-y-2">
                {session.result.summary && (
                  <div className="text-xs text-fg-secondary">{session.result.summary}</div>
                )}
                {session.result.diffStats && (
                  <div className="flex items-center gap-3 text-xs font-mono">
                    <span className="text-fg-tertiary">{session.result.diffStats.filesChanged} files changed</span>
                    <span className="text-green-500">+{session.result.diffStats.additions}</span>
                    <span className="text-red-500">-{session.result.diffStats.deletions}</span>
                  </div>
                )}
                {session.result.modifiedFiles && session.result.modifiedFiles.length > 0 && (
                  <div>
                    <div className="text-[10px] text-fg-tertiary mb-1">Modified files:</div>
                    <div className="bg-surface-elevated/70 rounded-lg px-3 py-2 max-h-32 overflow-y-auto">
                      {session.result.modifiedFiles.map((f, i) => (
                        <div key={i} className="text-[11px] text-fg-secondary font-mono truncate">{f}</div>
                      ))}
                    </div>
                  </div>
                )}
                {session.result.error && (
                  <pre className="text-xs text-red-500 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 overflow-x-auto max-h-60 overflow-y-auto whitespace-pre-wrap break-all font-mono">
                    {session.result.error}
                  </pre>
                )}
              </div>
            </div>
          )}

          {/* Cost */}
          {session.cost && (session.cost.inputTokens != null || session.cost.outputTokens != null || session.cost.estimatedCostUsd != null) && (
            <div>
              <h4 className="text-[10px] font-semibold text-fg-tertiary uppercase tracking-wider mb-2">Cost</h4>
              <div className="flex items-center gap-4 text-xs text-fg-secondary">
                {session.cost.inputTokens != null && <span>{session.cost.inputTokens.toLocaleString()} input tokens</span>}
                {session.cost.outputTokens != null && <span>{session.cost.outputTokens.toLocaleString()} output tokens</span>}
                {session.cost.estimatedCostUsd != null && <span className="font-medium">${session.cost.estimatedCostUsd.toFixed(4)}</span>}
                {durationMs != null && <span className="text-fg-tertiary">{formatDuration(durationMs)}</span>}
              </div>
            </div>
          )}

          {/* Raw output */}
          {session.result?.rawOutput && (
            <div>
              <button
                type="button"
                onClick={() => setShowRaw(!showRaw)}
                className="flex items-center gap-1.5 text-[10px] text-fg-tertiary hover:text-fg-secondary transition-colors"
              >
                <svg className={`w-3 h-3 transition-transform ${showRaw ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
                <span className="font-semibold uppercase tracking-wider">Raw Output</span>
              </button>
              {showRaw && (
                <pre className="mt-2 text-[11px] text-fg-tertiary bg-surface-elevated/70 rounded-lg px-3 py-2 overflow-x-auto max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-all font-mono">
                  {session.result.rawOutput}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── toolCallInfoToSession — convert generic ToolCallInfo to CodingToolSession ─

function toolCallInfoToSession(info: ToolCallInfo): CodingToolSession | null {
  if (info.tool !== 'invoke_coding_tool') return null;
  const args = (info.args && typeof info.args === 'object' && !Array.isArray(info.args))
    ? info.args as Record<string, unknown>
    : {};
  const toolName = (typeof args.tool === 'string' ? args.tool : 'unknown') as string;
  const prompt = typeof args.prompt === 'string' ? args.prompt : '';

  const statusMap: Record<string, string> = { running: 'running', done: 'completed', error: 'failed', stopped: 'cancelled' };
  const sessionStatus = statusMap[info.status] ?? info.status;

  let result: CodingToolSession['result'] | undefined;
  let cost: CodingToolSession['cost'] | undefined;
  if (info.result) {
    try {
      const parsed = JSON.parse(info.result);
      if (parsed && typeof parsed === 'object') {
        const inner = parsed.result && typeof parsed.result === 'object' ? parsed.result : parsed;
        result = {
          success: inner.success ?? parsed.success ?? (info.status === 'done'),
          summary: inner.summary ?? inner.message ?? parsed.summary ?? parsed.message ?? 'Completed',
          diffStats: inner.diffStats ?? parsed.diffStats,
          modifiedFiles: inner.modifiedFiles ?? parsed.modifiedFiles,
          exitCode: inner.exitCode ?? parsed.exitCode,
          rawOutput: inner.rawOutput ?? inner.output ?? parsed.rawOutput ?? parsed.output,
          error: inner.error ?? parsed.error,
        };
        if (inner.cost) cost = inner.cost;
        else if (parsed.cost) cost = parsed.cost;
      }
    } catch {
      result = { success: info.status === 'done', summary: info.result.slice(0, 500), rawOutput: info.result };
    }
  }
  if (info.durationMs != null) {
    cost = { ...cost, durationMs: info.durationMs };
  }

  let progressMessage: string | undefined;
  if (info.liveOutput && info.status === 'running') {
    const lines = info.liveOutput.trim().split('\n');
    progressMessage = lines[lines.length - 1]?.slice(0, 200);
  }

  return {
    id: `tc-${toolName}-${Date.now()}`,
    tool: toolName,
    status: sessionStatus,
    prompt,
    progressMessage,
    result,
    cost,
    createdAt: new Date().toISOString(),
  };
}

// ─── ToolCallRow — unified rendering for a single tool call ───────────────────

export function ToolCallRow({ info, showTime, time, isLast }: {
  info: ToolCallInfo;
  showTime?: boolean;
  time?: string;
  isLast?: boolean;
}) {
  const { t } = useTranslation('common');
  const meta = getToolMeta(info.tool);
  const [expanded, setExpanded] = useState(false);
  const isDone = info.status !== 'running';
  const isStopped = info.status === 'stopped';
  const isSubagentTool = info.tool === 'spawn_subagent' || info.tool === 'spawn_subagents';
  const hasSubagentLogs = isSubagentTool && info.subagentLogs && info.subagentLogs.length > 0;
  const clickable = true;

  const codingSession = useMemo(() => toolCallInfoToSession(info), [info]);
  const [codingModalOpen, setCodingModalOpen] = useState(false);

  const shellCmd = getShellCommand(info);
  const outputRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [info.liveOutput]);

  if (codingSession) {
    return (
      <>
        <div className="cursor-pointer" onClick={() => setCodingModalOpen(true)}>
          <CodingToolCard session={codingSession} />
        </div>
        {codingModalOpen && createPortal(
          <CodingToolDetailModal session={codingSession} info={info} onClose={() => setCodingModalOpen(false)} />,
          document.body,
        )}
      </>
    );
  }

  return (
    <>
      <div
        className={`relative py-0.5 min-w-0 ${!isLast ? 'border-b border-border-default/30 pb-1.5 mb-0.5' : ''} ${clickable ? 'cursor-pointer rounded hover:bg-surface-elevated/30 transition-colors' : ''}`}
        onClick={() => setExpanded(true)}
      >
        {showTime && time && (
          <span className="text-[10px] text-fg-tertiary tabular-nums hidden md:block mb-0.5">{time}</span>
        )}
        <div className="flex items-start gap-2">
        <div className="flex flex-col items-center shrink-0 mt-0.5" style={{ width: 14 }}>
          <div className={`w-3 h-3 rounded-full border flex items-center justify-center text-[8px] shrink-0 ${
            info.status === 'running' ? 'border-brand-500 bg-brand-500/15 animate-pulse'
            : info.status === 'error' ? 'border-red-500 bg-red-500/15 text-red-500'
            : isStopped ? 'border-gray-500 bg-surface-secondary text-fg-tertiary'
            : 'border-green-500 bg-green-500/15 text-green-500'
          }`}>
            {info.status === 'done' ? '✓' : info.status === 'error' ? '✗' : isStopped ? '■' : ''}
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <div className={`flex items-center gap-1 text-xs leading-snug ${
            info.status === 'running' ? 'text-brand-500'
            : info.status === 'error' ? 'text-red-500 line-through opacity-50'
            : isStopped ? 'text-fg-tertiary opacity-60'
            : 'text-fg-tertiary'
          }`}>
            <span className="opacity-60">{meta.icon}</span>
            <span>{meta.label}{info.status === 'running' ? '…' : ''}</span>
            {info.status === 'running' && (
              <svg className="w-3 h-3 animate-spin ml-0.5 shrink-0" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            )}
            {info.durationMs != null && info.status !== 'running' && (
              <span className="text-[10px] text-fg-tertiary ml-0.5">{formatDuration(info.durationMs)}</span>
            )}
            {hasSubagentLogs && (
              <span className="text-[10px] text-fg-tertiary ml-0.5 opacity-60">{t('execution.toolSteps', { count: info.subagentLogs!.filter(l => l.eventType === 'tool_end').length })}</span>
            )}
          </div>
          {/* Show shell command being executed */}
          {shellCmd && (
            <div className={`mt-0.5 font-mono text-[11px] truncate max-w-full ${info.status === 'running' ? 'text-fg-secondary' : 'text-fg-tertiary'}`} title={shellCmd}>
              <span className="text-fg-tertiary select-none">$ </span>{truncate(shellCmd, 120)}
            </div>
          )}
          {/* Live streaming output */}
          {info.liveOutput && info.status === 'running' && (
            <pre ref={outputRef} className="mt-1 font-mono text-[11px] text-fg-tertiary bg-surface-secondary/60 rounded px-2 py-1.5 max-h-32 overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-all">
              {info.liveOutput}
            </pre>
          )}
        </div>
        </div>
      </div>
      {expanded && createPortal(<ToolDetailModal info={info} onClose={() => setExpanded(false)} />, document.body)}
      {isDone && (() => {
        const taskApproval = parseTaskApprovalFromResult(info.tool, info.result);
        if (taskApproval) return <TaskApprovalCard info={taskApproval} />;
        const reqApproval = parseRequirementApprovalFromResult(info.tool, info.result);
        if (reqApproval) return <RequirementApprovalCard info={reqApproval} />;
        return null;
      })()}
    </>
  );
}

// ─── ThinkingRow — collapsible thinking content ───────────────────────────────

function ThinkingRow({ content, time, showTime }: { content: string; time?: string; showTime?: boolean }) {
  const { t } = useTranslation('common');
  const [expanded, setExpanded] = useState(false);
  const preview = content.split('\n')[0] ?? '';
  return (
    <div>
      {showTime && time && (
        <span className="text-[10px] text-fg-tertiary tabular-nums hidden md:block mb-0.5">{time}</span>
      )}
      <div className="min-w-0 my-1 overflow-hidden bg-purple-500/[0.06] border border-purple-500/15 rounded-lg px-3 py-2 transition-colors hover:bg-purple-500/[0.1]">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 text-xs text-purple-400 w-full"
        >
          <svg className={`w-3 h-3 transition-transform shrink-0 ${expanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
          <span className="font-medium shrink-0">{t('execution.thinking')}</span>
          {!expanded && <span className="text-fg-tertiary text-[11px] truncate">{preview}</span>}
        </button>
        {expanded && (
          <div className="mt-2 pt-2 border-t border-purple-500/15 overflow-hidden">
            <MarkdownMessage content={content} className="text-xs text-fg-tertiary break-words" />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── ExecEntryRow — renders a single execution entry ──────────────────────────

export const MemoExecEntryRow = memo(ExecEntryRow);

export function ExecEntryRow({ entry, showTime, isLast }: {
  entry: ExecEntry;
  showTime?: boolean;
  isLast?: boolean;
}) {
  const { t } = useTranslation('common');
  if (entry.type === 'tool') {
    return <ToolCallRow info={entry.info} showTime={showTime} time={entry.time} isLast={isLast} key={entry.key} />;
  }
  if (entry.type === 'thinking') {
    return <ThinkingRow content={entry.content} time={entry.time} showTime={showTime} />;
  }
  if (entry.type === 'text') {
    return (
      <div>
        {showTime && entry.time && (
          <span className="text-[10px] text-fg-tertiary tabular-nums hidden md:block mb-0.5">{entry.time}</span>
        )}
        <div className="min-w-0 bg-surface-elevated/50 rounded-lg px-3 py-2.5 my-1 overflow-hidden">
          <MarkdownMessage content={entry.content} className="text-sm text-fg-secondary break-words" />
        </div>
      </div>
    );
  }
  if (entry.type === 'status') {
    const isCompleted = entry.content === 'completed' || entry.content === 'execution_finished';
    const isStarted = entry.content === 'started';
    const isResumed = entry.content === 'resumed';
    const color = isCompleted ? 'text-green-600' : isStarted ? 'text-blue-600' : isResumed ? 'text-amber-600' : 'text-fg-tertiary';
    const dot = isCompleted ? 'bg-green-400' : isStarted ? 'bg-blue-400' : isResumed ? 'bg-amber-400' : 'bg-gray-500';
    return (
      <div className="py-0.5 px-1">
        {showTime && entry.time && (
          <span className="text-[10px] text-fg-tertiary tabular-nums hidden md:block mb-0.5">{entry.time}</span>
        )}
        <div className="flex items-center gap-2">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
          <span className={`text-xs capitalize ${color}`}>{t(`execution.statusKnown.${entry.content}`, { defaultValue: entry.content })}</span>
        </div>
      </div>
    );
  }
  if (entry.type === 'error') {
    return (
      <div>
        {showTime && entry.time && (
          <span className="text-[10px] text-fg-tertiary tabular-nums hidden md:block mb-0.5">{entry.time}</span>
        )}
        <div className="min-w-0 text-xs text-red-500 bg-red-500/10 border border-red-500/20 rounded px-2.5 py-2 my-1 leading-relaxed break-words overflow-hidden">
          <span className="font-medium">{t('execution.errorPrefix')}</span> {entry.content}
        </div>
      </div>
    );
  }
  return null;
}

// ─── Legacy adapter: LogEntryRow for backward compatibility ───────────────────

export function LogEntryRow({ entry }: { entry: TaskLogEntry }) {
  const execEntry = taskLogToEntry(entry);
  if (!execEntry) return null;
  return <ExecEntryRow entry={execEntry} />;
}

// ─── CompactExecutionCard ─────────────────────────────────────────────────────

export interface CompactExecutionCardProps {
  entries: ExecutionStreamEntryUI[];
  streamingText?: string;
  isActive: boolean;
  onExpand: () => void;
  showRounds?: boolean;
  /** When true, removes border/background — used inside chat bubbles */
  embedded?: boolean;
}

export function CompactExecutionCard({ entries, streamingText, isActive, onExpand, showRounds, embedded }: CompactExecutionCardProps) {
  const { t } = useTranslation('common');
  const lastEntry = entries.length > 0 ? entries[entries.length - 1]! : null;
  const toolCount = entries.filter(e => e.type === 'tool_end').length;
  const errorCount = entries.filter(e => e.type === 'error').length;

  const firstTime = entries.length > 0 ? new Date(entries[0]!.createdAt).getTime() : Date.now();
  const lastTime = lastEntry ? new Date(lastEntry.createdAt).getTime() : Date.now();
  const elapsed = isActive ? Date.now() - firstTime : lastTime - firstTime;

  const rounds = new Set(entries.filter(e => e.executionRound != null).map(e => e.executionRound!));
  const currentRound = rounds.size > 0 ? Math.max(...rounds) : undefined;
  const hasMultipleRounds = showRounds && rounds.size > 1;

  let statusIcon: string;
  let statusLabel: string;
  let statusDetail: string | null = null;

  if (!isActive) {
    if (errorCount > 0 && lastEntry?.type === 'error') {
      statusIcon = '❌';
      statusLabel = t('execution.compact.failed');
    } else {
      const lastStatus = [...entries].reverse().find(e => e.type === 'status');
      const statusContent = lastStatus?.content ?? '';
      if (statusContent === 'completed' || statusContent === 'execution_finished') {
        statusIcon = '✅';
        statusLabel = t('execution.compact.completed');
      } else {
        statusIcon = '●';
        statusLabel = t('execution.compact.toolsExecuted', { count: toolCount });
      }
    }
  } else if (streamingText) {
    statusIcon = '✍';
    statusLabel = t('execution.compact.writingResponse');
    statusDetail = truncate(streamingText.split('\n').pop() ?? '', 80);
  } else if (lastEntry?.type === 'tool_start') {
    const meta = getToolMeta(lastEntry.content);
    statusIcon = meta.icon;
    statusLabel = `${meta.label}...`;
    const shellCmd = lastEntry.metadata?.arguments && typeof lastEntry.metadata.arguments === 'object'
      ? (lastEntry.metadata.arguments as Record<string, unknown>).command as string | undefined
      : undefined;
    if (shellCmd) statusDetail = `$ ${truncate(shellCmd, 80)}`;
  } else if (lastEntry?.type === 'tool_end') {
    const meta = getToolMeta(lastEntry.content);
    statusIcon = meta.icon;
    statusLabel = meta.label;
  } else {
    statusIcon = '💭';
    statusLabel = t('execution.compact.thinking');
  }

  const elapsedStr = formatDuration(elapsed);

  return (
    <div
      onClick={onExpand}
      className={`overflow-hidden transition-all cursor-pointer min-w-0 ${
        embedded
          ? 'hover:bg-surface-elevated/20'
          : `rounded-lg border hover:brightness-110 ${isActive ? 'border-2 exec-card-active' : 'border border-border-default bg-surface-elevated/30 hover:border-brand-500/40'}`
      }`}
    >
      <div className={embedded ? 'py-2' : 'px-3 py-2.5 bg-surface-primary/80'}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {isActive ? (
              <svg className="w-3.5 h-3.5 animate-spin text-brand-500 shrink-0" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : (
              <span className="text-sm shrink-0">{statusIcon}</span>
            )}
            <span className={`text-xs font-medium truncate ${isActive ? 'text-fg-primary' : 'text-fg-secondary'}`}>
              {statusLabel}
            </span>
          </div>
          {elapsedStr && (
            <span className="text-[10px] text-fg-tertiary tabular-nums shrink-0">{elapsedStr}</span>
          )}
        </div>

        {streamingText ? (
          <div className={`mt-1.5 ml-5.5 text-xs text-fg-secondary whitespace-pre-wrap break-words leading-relaxed ${embedded && isActive ? '' : 'max-h-32 overflow-y-auto'}`}>
            <MarkdownMessage content={streamingText} className="text-xs" />
          </div>
        ) : statusDetail ? (
          <div className="mt-1 ml-5.5 text-[11px] font-mono text-fg-tertiary truncate">{statusDetail}</div>
        ) : null}

        <div className="flex items-center justify-between mt-2">
          <div className="flex items-center gap-2 text-[10px] text-fg-tertiary">
            {toolCount > 0 && <span>🔧 {t('execution.compact.toolsLine', { count: toolCount })}</span>}
            {entries.some(e => e.type === 'text' && !e.metadata?.isThinking) && <span>💬 {t('execution.compact.text')}</span>}
            {entries.some(e => e.type === 'text' && e.metadata?.isThinking) && <span className="text-purple-400">💭 {t('execution.compact.thinkingTag')}</span>}
            {hasMultipleRounds && currentRound != null && (
              <>
                <span className="opacity-30">·</span>
                <span>{t('execution.compact.round', { n: currentRound })}</span>
                <span className="opacity-30">·</span>
                <span>{t('execution.compact.rounds', { count: rounds.size })}</span>
              </>
            )}
          </div>
          <span className="text-[10px] text-brand-500 flex items-center gap-0.5">
            {t('execution.compact.showFullLog')}
            <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" /></svg>
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── FullExecutionLog ─────────────────────────────────────────────────────────

interface RoundGroup {
  round: number;
  entries: ExecEntry[];
}

function groupByRound(entries: ExecutionStreamEntryUI[]): RoundGroup[] {
  const groups = new Map<number, ExecEntry[]>();
  for (const e of entries) {
    const round = e.executionRound ?? 1;
    if (!groups.has(round)) groups.set(round, []);
    const exec = streamEntryToExecEntry(e);
    if (exec) groups.get(round)!.push(exec);
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => a - b)
    .map(([round, entries]) => ({ round, entries }));
}

export interface FullExecutionLogProps {
  entries: ExecutionStreamEntryUI[];
  streamingText?: string;
  isActive: boolean;
  onCollapse: () => void;
  showRounds?: boolean;
  /** When true, disables internal max-height/scroll — parent handles scrolling */
  embedded?: boolean;
}

export function FullExecutionLog({ entries, streamingText, isActive, onCollapse, showRounds, embedded }: FullExecutionLogProps) {
  const { t } = useTranslation('common');
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expandedRounds, setExpandedRounds] = useState<Set<number>>(new Set());

  const rounds = groupByRound(entries);
  const hasMultipleRounds = showRounds && rounds.length > 1;

  useEffect(() => {
    if (rounds.length > 0) {
      setExpandedRounds(prev => {
        const next = new Set(prev);
        next.add(rounds[rounds.length - 1]!.round);
        return next;
      });
    }
  }, [rounds.length]);

  useEffect(() => {
    if (embedded || !scrollRef.current || !isActive) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [entries.length, streamingText, isActive, embedded]);

  const toggleRound = (round: number) => {
    setExpandedRounds(prev => {
      const next = new Set(prev);
      if (next.has(round)) next.delete(round);
      else next.add(round);
      return next;
    });
  };

  const allExec = hasMultipleRounds
    ? null
    : entries.map(streamEntryToExecEntry).filter((e): e is ExecEntry => e !== null);
  const filtered = allExec ? filterCompletedStarts(allExec) : null;

  return (
    <div className={`min-w-0 overflow-hidden ${embedded ? '' : 'rounded-lg border border-border-default bg-surface-primary/50'}`}>
      <div
        onClick={onCollapse}
        className={`flex items-center cursor-pointer hover:bg-surface-elevated/40 transition-colors ${
          embedded ? 'justify-end py-0.5' : 'justify-between px-3 py-1.5 border-b border-border-default'
        }`}
      >
        {!embedded && <span className="text-[10px] text-fg-tertiary font-medium uppercase tracking-wider">{t('execution.fullLog.title')}</span>}
        <span className="text-[10px] text-brand-500 flex items-center gap-0.5">
          {t('execution.fullLog.collapse')}
          <svg className="w-3 h-3 rotate-180" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" /></svg>
        </span>
      </div>

      <div ref={embedded ? undefined : scrollRef} className={`space-y-0.5 min-w-0 overflow-x-hidden ${embedded ? 'py-1' : 'px-3 py-2 max-h-[60vh] overflow-y-auto scrollbar-thin'}`}>
        {hasMultipleRounds ? (
          rounds.map(rg => {
            const isExpanded = expandedRounds.has(rg.round);
            const filteredEntries = filterCompletedStarts(rg.entries);
            const toolCount = rg.entries.filter(e => e.type === 'tool' && (e as any).info?.status !== 'running').length;
            return (
              <div key={rg.round} className="border border-border-default/50 rounded-lg mb-2 overflow-hidden">
                <button
                  onClick={() => toggleRound(rg.round)}
                  className="w-full flex items-center justify-between px-3 py-1.5 bg-surface-elevated/30 hover:bg-surface-elevated/50 transition-colors"
                >
                  <span className="text-xs text-fg-secondary font-medium">{t('execution.compact.round', { n: rg.round })}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-fg-tertiary">{t('execution.compact.toolsLine', { count: toolCount })}</span>
                    <svg className={`w-3 h-3 text-fg-tertiary transition-transform ${isExpanded ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
                    </svg>
                  </div>
                </button>
                {isExpanded && (
                  <div className="px-3 py-1.5 space-y-0.5">
                    {filteredEntries.map((entry, i) => (
                      <MemoExecEntryRow key={i} entry={entry} showTime isLast={i === filteredEntries.length - 1} />
                    ))}
                  </div>
                )}
              </div>
            );
          })
        ) : (
          filtered && filtered.map((entry, i) => (
            <MemoExecEntryRow key={i} entry={entry} showTime isLast={i === filtered.length - 1} />
          ))
        )}

        {isActive && streamingText && <StreamingText content={streamingText} />}
        {isActive && !streamingText && <ThinkingDots />}
      </div>
    </div>
  );
}
