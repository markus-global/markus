/**
 * Unified Execution Timeline — shared component rendering for agent tool calls,
 * text output, status changes, and errors across all views.
 *
 * Non-component utilities (types, converters, helpers) live in execution-utils.ts
 * to keep this file components-only for Vite HMR Fast Refresh compatibility.
 */
import { useState, useRef, useEffect, useCallback, memo } from 'react';
import { api, wsClient, type TaskLogEntry } from '../api.ts';
import { navBus } from '../navBus.ts';
import { PAGE } from '../routes.ts';
import { MarkdownMessage } from './MarkdownMessage.tsx';
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

export function ThinkingDots({ label = 'Thinking' }: { label?: string }) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-fg-secondary py-0.5">
      <span>{label}</span>
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

export function StreamingText({ content, className }: { content: string; className?: string }) {
  return (
    <div className="bg-surface-elevated/50 rounded-lg px-3 py-2.5 my-1 min-w-0 overflow-hidden">
      <MarkdownMessage content={content} className={className ?? 'text-sm text-fg-secondary break-words'} />
      <span className="inline-block w-0.5 h-4 bg-brand-400 animate-pulse ml-0.5 align-middle" />
    </div>
  );
}


// ─── Tool Detail Modal ────────────────────────────────────────────────────────

function ToolDetailModal({ info, onClose }: { info: ToolCallInfo; onClose: () => void }) {
  const meta = getToolMeta(info.tool);
  const argEntries = formatArgsDetail(info.args);
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
            <span className={`text-sm font-semibold ${success ? 'text-fg-primary' : 'text-red-500'}`}>{meta.label}</span>
            <span className={`text-xs px-1.5 py-0.5 rounded ${success ? 'bg-green-500/15 text-green-600' : 'bg-red-500/15 text-red-500'}`}>
              {success ? 'Success' : 'Failed'}
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
              <h4 className="text-[10px] font-semibold text-fg-tertiary uppercase tracking-wider mb-2">Arguments</h4>
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
          {info.result && (
            <div>
              <h4 className="text-[10px] font-semibold text-fg-tertiary uppercase tracking-wider mb-2">Result</h4>
              <pre className="text-xs text-fg-secondary bg-surface-elevated/70 rounded-lg px-3 py-2 overflow-x-auto overflow-y-auto max-h-[60vh] whitespace-pre-wrap break-all font-mono">{prettyJson(info.result)}</pre>
            </div>
          )}
          {info.error && (
            <div>
              <h4 className="text-[10px] font-semibold text-red-500 uppercase tracking-wider mb-2">Error</h4>
              <pre className="text-xs text-red-500 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 overflow-x-auto max-h-40 whitespace-pre-wrap break-all font-mono">{prettyJson(String(info.error))}</pre>
            </div>
          )}
          {!argEntries.length && !info.result && !info.error && (
            <div className="text-sm text-fg-tertiary italic py-4 text-center">No detailed data recorded for this tool call.</div>
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

const TASK_STATUS_CONFIG: Record<string, { icon: string; label: string; borderClass: string; bgClass: string; badgeClass: string; textClass: string }> = {
  pending:     { icon: '⏳', label: 'Pending Approval', borderClass: 'border-amber-500/40',       bgClass: 'bg-amber-500/5',          badgeClass: 'bg-amber-500/15 text-amber-600', textClass: '' },
  approving:   { icon: '⏳', label: 'Approving…',       borderClass: 'border-amber-500/40',       bgClass: 'bg-amber-500/5',          badgeClass: 'bg-amber-500/15 text-amber-600', textClass: '' },
  rejecting:   { icon: '⏳', label: 'Rejecting…',       borderClass: 'border-amber-500/40',       bgClass: 'bg-amber-500/5',          badgeClass: 'bg-amber-500/15 text-amber-600', textClass: '' },
  in_progress: { icon: '▶',  label: 'In Progress',      borderClass: 'border-blue-500/40',        bgClass: 'bg-blue-500/5',           badgeClass: 'bg-blue-500/15 text-blue-500',   textClass: 'text-blue-500' },
  completed:   { icon: '✅', label: 'Completed',         borderClass: 'border-green-500/30',       bgClass: 'bg-green-500/5',          badgeClass: 'bg-green-500/15 text-green-500', textClass: 'text-green-500' },
  review:      { icon: '👀', label: 'In Review',         borderClass: 'border-purple-500/40',      bgClass: 'bg-purple-500/5',         badgeClass: 'bg-purple-500/15 text-purple-500', textClass: 'text-purple-500' },
  blocked:     { icon: '🚫', label: 'Blocked',           borderClass: 'border-orange-500/40',      bgClass: 'bg-orange-500/5',         badgeClass: 'bg-orange-500/15 text-orange-500', textClass: 'text-orange-500' },
  failed:      { icon: '❌', label: 'Failed',            borderClass: 'border-red-500/30',         bgClass: 'bg-red-500/5',            badgeClass: 'bg-red-500/15 text-red-500',     textClass: 'text-red-500' },
  cancelled:   { icon: '⊘',  label: 'Cancelled',        borderClass: 'border-border-default/40',  bgClass: 'bg-surface-secondary/30', badgeClass: 'bg-surface-elevated text-fg-tertiary', textClass: 'text-fg-tertiary' },
  archived:    { icon: '📦', label: 'Archived',          borderClass: 'border-border-default/40',  bgClass: 'bg-surface-secondary/30', badgeClass: 'bg-surface-elevated text-fg-tertiary', textClass: 'text-fg-tertiary' },
  loading:     { icon: '⏳', label: 'Loading…',          borderClass: 'border-border-default/40',  bgClass: 'bg-surface-secondary/30', badgeClass: 'bg-surface-elevated text-fg-tertiary', textClass: '' },
};

export function TaskApprovalCard({ info }: { info: TaskApprovalInfo }) {
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

  const handleApprove = async () => {
    setCardState('approving');
    try {
      await api.tasks.approve(info.taskId);
      setCardState('in_progress');
    } catch {
      setCardState('pending');
    }
  };

  const handleReject = async () => {
    setCardState('rejecting');
    try {
      await api.tasks.reject(info.taskId);
      setCardState('cancelled');
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
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${cfg.badgeClass}`}>Task</span>
            {!isPending && cardState !== 'loading' && (
              <span className={`text-[10px] font-medium ${cfg.textClass}`}>{cfg.label}</span>
            )}
          </div>
          <div className={`text-sm font-medium truncate mt-1 group-hover:underline ${!isPending && cardState !== 'loading' ? 'text-fg-secondary' : 'text-fg-primary'}`}>{info.title}</div>
          {info.description && (
            <div className="text-xs text-fg-secondary mt-0.5 line-clamp-2">{info.description}</div>
          )}
          <div className="flex items-center gap-2 mt-1.5 text-[11px] text-fg-tertiary">
            {info.priority && (
              <span className={APPROVAL_PRIORITY_COLORS[info.priority] ?? 'text-fg-tertiary'}>
                {info.priority}
              </span>
            )}
            <span className="opacity-50">ID: {info.taskId.slice(0, 8)}...</span>
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
            {cardState === 'approving' ? 'Approving…' : 'Approve'}
          </button>
          <button
            onClick={handleReject}
            disabled={cardState !== 'pending'}
            className="flex-1 px-3 py-1.5 text-xs font-medium rounded-md bg-surface-elevated hover:bg-surface-overlay text-fg-secondary border border-border-default transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {cardState === 'rejecting' ? 'Rejecting…' : 'Reject'}
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

const REQ_STATUS_CONFIG: Record<string, { icon: string; label: string; borderClass: string; bgClass: string; badgeClass: string; textClass: string }> = {
  pending:     { icon: '📋', label: 'Pending Approval', borderClass: 'border-amber-500/40',       bgClass: 'bg-amber-500/5',          badgeClass: 'bg-amber-500/15 text-amber-600', textClass: '' },
  approving:   { icon: '⏳', label: 'Approving…',       borderClass: 'border-amber-500/40',       bgClass: 'bg-amber-500/5',          badgeClass: 'bg-amber-500/15 text-amber-600', textClass: '' },
  rejecting:   { icon: '⏳', label: 'Rejecting…',       borderClass: 'border-amber-500/40',       bgClass: 'bg-amber-500/5',          badgeClass: 'bg-amber-500/15 text-amber-600', textClass: '' },
  in_progress: { icon: '▶',  label: 'In Progress',      borderClass: 'border-blue-500/40',        bgClass: 'bg-blue-500/5',           badgeClass: 'bg-blue-500/15 text-blue-500',   textClass: 'text-blue-500' },
  completed:   { icon: '✅', label: 'Completed',         borderClass: 'border-green-500/30',       bgClass: 'bg-green-500/5',          badgeClass: 'bg-green-500/15 text-green-500', textClass: 'text-green-500' },
  rejected:    { icon: '❌', label: 'Rejected',          borderClass: 'border-red-500/30',         bgClass: 'bg-red-500/5',            badgeClass: 'bg-red-500/15 text-red-500',     textClass: 'text-red-500' },
  cancelled:   { icon: '⊘',  label: 'Cancelled',        borderClass: 'border-border-default/40',  bgClass: 'bg-surface-secondary/30', badgeClass: 'bg-surface-elevated text-fg-tertiary', textClass: 'text-fg-tertiary' },
  archived:    { icon: '📦', label: 'Archived',          borderClass: 'border-border-default/40',  bgClass: 'bg-surface-secondary/30', badgeClass: 'bg-surface-elevated text-fg-tertiary', textClass: 'text-fg-tertiary' },
  loading:     { icon: '⏳', label: 'Loading…',          borderClass: 'border-border-default/40',  bgClass: 'bg-surface-secondary/30', badgeClass: 'bg-surface-elevated text-fg-tertiary', textClass: '' },
};

const REQ_WS_EVENTS = [
  'requirement:approved', 'requirement:rejected', 'requirement:updated',
  'requirement:completed', 'requirement:cancelled', 'requirement:resubmitted',
] as const;

export function RequirementApprovalCard({ info }: { info: RequirementApprovalInfo }) {
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

  const handleApprove = async () => {
    setCardState('approving');
    try {
      await api.requirements.approve(info.requirementId);
      setCardState('in_progress');
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
    } catch {
      setCardState('pending');
    }
  };

  const isPending = cardState === 'pending' || cardState === 'approving' || cardState === 'rejecting';
  const cfg = REQ_STATUS_CONFIG[cardState] ?? REQ_STATUS_CONFIG['loading']!;

  return (
    <div className={`my-2 rounded-lg border ${cfg.borderClass} ${cfg.bgClass} p-3 max-w-md transition-colors`}>
      <div className="flex items-start gap-2 mb-1">
        <span className="text-sm mt-0.5">{cfg.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${cfg.badgeClass}`}>REQ</span>
            {!isPending && cardState !== 'loading' && (
              <span className={`text-[10px] font-medium ${cfg.textClass}`}>{cfg.label}</span>
            )}
          </div>
          <div className={`text-sm font-medium truncate mt-1 ${!isPending && cardState !== 'loading' ? 'text-fg-secondary' : 'text-fg-primary'}`}>{info.title}</div>
          {info.description && (
            <div className="text-xs text-fg-secondary mt-0.5 line-clamp-3">{info.description}</div>
          )}
          <div className="flex items-center gap-2 mt-1.5 text-[11px] text-fg-tertiary">
            {info.priority && (
              <span className={APPROVAL_PRIORITY_COLORS[info.priority] ?? 'text-fg-tertiary'}>
                {info.priority}
              </span>
            )}
            <span className="opacity-50">ID: {info.requirementId.slice(0, 8)}...</span>
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
              placeholder="Rejection reason..."
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
              {cardState === 'approving' ? 'Approving…' : 'Approve'}
            </button>
            <button
              onClick={handleReject}
              disabled={cardState !== 'pending' || (showRejectInput && !rejectReason.trim())}
              className="flex-1 px-3 py-1.5 text-xs font-medium rounded-md bg-surface-elevated hover:bg-surface-overlay text-fg-secondary border border-border-default transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {cardState === 'rejecting' ? 'Rejecting…' : 'Reject'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── ToolCallRow — unified rendering for a single tool call ───────────────────

export function ToolCallRow({ info, showTime, time, isLast }: {
  info: ToolCallInfo;
  showTime?: boolean;
  time?: string;
  isLast?: boolean;
}) {
  const meta = getToolMeta(info.tool);
  const [expanded, setExpanded] = useState(false);
  const isDone = info.status !== 'running';
  const isStopped = info.status === 'stopped';
  const isSubagentTool = info.tool === 'spawn_subagent' || info.tool === 'spawn_subagents';
  const hasSubagentLogs = isSubagentTool && info.subagentLogs && info.subagentLogs.length > 0;
  const clickable = isDone || hasSubagentLogs;

  const shellCmd = getShellCommand(info);
  const outputRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [info.liveOutput]);

  return (
    <>
      <div
        className={`relative flex items-start gap-2 py-0.5 min-w-0 ${!isLast ? 'border-b border-border-default/30 pb-1.5 mb-0.5' : ''} ${clickable ? 'cursor-pointer rounded hover:bg-surface-elevated/30 transition-colors' : ''}`}
        onClick={() => isDone && setExpanded(true)}
      >
        {showTime && time && (
          <span className="text-[10px] text-fg-tertiary shrink-0 w-24 text-right tabular-nums mt-0.5 hidden md:inline">{time}</span>
        )}
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
              <span className="text-[10px] text-fg-tertiary ml-0.5 opacity-60">({info.subagentLogs!.filter(l => l.eventType === 'tool_end').length} steps)</span>
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
      {expanded && <ToolDetailModal info={info} onClose={() => setExpanded(false)} />}
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
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="flex items-start gap-2">
      {showTime && time && (
        <span className="text-[10px] text-fg-tertiary shrink-0 w-24 text-right tabular-nums mt-2.5 hidden md:inline">{time}</span>
      )}
      <div className="flex-1 min-w-0 my-1 overflow-hidden">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 text-xs text-purple-400 hover:text-purple-300 transition-colors"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-purple-400/60 shrink-0" />
          <span>Thinking</span>
          <span className="text-fg-tertiary text-[10px]">({content.length} chars)</span>
          <svg className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
        </button>
        {expanded && (
          <div className="mt-1.5 bg-purple-500/[0.06] border border-purple-500/15 rounded-lg px-3 py-2.5 overflow-hidden">
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
  if (entry.type === 'tool') {
    return <ToolCallRow info={entry.info} showTime={showTime} time={entry.time} isLast={isLast} key={entry.key} />;
  }
  if (entry.type === 'thinking') {
    return <ThinkingRow content={entry.content} time={entry.time} showTime={showTime} />;
  }
  if (entry.type === 'text') {
    return (
      <div className={`flex items-start gap-2 ${showTime ? '' : ''}`}>
        {showTime && entry.time && (
          <span className="text-[10px] text-fg-tertiary shrink-0 w-24 text-right tabular-nums mt-2.5 hidden md:inline">{entry.time}</span>
        )}
        <div className="flex-1 min-w-0 bg-surface-elevated/50 rounded-lg px-3 py-2.5 my-1 overflow-hidden">
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
      <div className="flex items-center gap-2 py-0.5 px-1">
        {showTime && entry.time && (
          <span className="text-[10px] text-fg-tertiary shrink-0 w-24 text-right tabular-nums hidden md:inline">{entry.time}</span>
        )}
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
        <span className={`text-xs capitalize ${color}`}>{entry.content}</span>
      </div>
    );
  }
  if (entry.type === 'error') {
    return (
      <div className={`flex items-start gap-2 ${showTime ? '' : ''}`}>
        {showTime && entry.time && (
          <span className="text-[10px] text-fg-tertiary shrink-0 w-24 text-right tabular-nums mt-2 hidden md:inline">{entry.time}</span>
        )}
        <div className="flex-1 min-w-0 text-xs text-red-500 bg-red-500/10 border border-red-500/20 rounded px-2.5 py-2 my-1 leading-relaxed break-words overflow-hidden">
          <span className="font-medium">Error:</span> {entry.content}
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
      statusLabel = 'Failed';
    } else {
      const lastStatus = [...entries].reverse().find(e => e.type === 'status');
      const statusContent = lastStatus?.content ?? '';
      if (statusContent === 'completed' || statusContent === 'execution_finished') {
        statusIcon = '✅';
        statusLabel = 'Completed';
      } else {
        statusIcon = '●';
        statusLabel = `${toolCount} tool${toolCount !== 1 ? 's' : ''} executed`;
      }
    }
  } else if (streamingText) {
    statusIcon = '✍';
    statusLabel = 'Writing response...';
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
    statusLabel = 'Thinking...';
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
          <div className="mt-1.5 ml-5.5 text-xs text-fg-secondary max-h-32 overflow-y-auto whitespace-pre-wrap break-words leading-relaxed">
            <MarkdownMessage content={streamingText} className="text-xs" />
          </div>
        ) : statusDetail ? (
          <div className="mt-1 ml-5.5 text-[11px] font-mono text-fg-tertiary truncate">{statusDetail}</div>
        ) : null}

        <div className="flex items-center justify-between mt-2">
          <div className="flex items-center gap-2 text-[10px] text-fg-tertiary">
            {toolCount > 0 && <span>🔧 {toolCount} tool{toolCount !== 1 ? 's' : ''}</span>}
            {entries.some(e => e.type === 'text' && !e.metadata?.isThinking) && <span>💬 text</span>}
            {entries.some(e => e.type === 'text' && e.metadata?.isThinking) && <span className="text-purple-400">💭 thinking</span>}
            {hasMultipleRounds && currentRound != null && (
              <>
                <span className="opacity-30">·</span>
                <span>Round #{currentRound}</span>
                <span className="opacity-30">·</span>
                <span>{rounds.size} rounds</span>
              </>
            )}
          </div>
          <span className="text-[10px] text-brand-500 flex items-center gap-0.5">
            Show Full Log
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
        {!embedded && <span className="text-[10px] text-fg-tertiary font-medium uppercase tracking-wider">Execution Log</span>}
        <span className="text-[10px] text-brand-500 flex items-center gap-0.5">
          Collapse
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
                  <span className="text-xs text-fg-secondary font-medium">Round #{rg.round}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-fg-tertiary">{toolCount} tool{toolCount !== 1 ? 's' : ''}</span>
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
