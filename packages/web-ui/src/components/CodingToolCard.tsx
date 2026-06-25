import { useState, useEffect, useMemo } from 'react';
import { formatDuration } from './execution-utils.ts';

export type CodingToolName = 'claude-code' | 'codex' | 'cursor-agent';

export interface CodingToolSession {
  id: string;
  tool: CodingToolName | string;
  status: string;
  prompt: string;
  progressMessage?: string;
  progressPercent?: number;
  result?: {
    success: boolean;
    summary: string;
    diffStats?: { filesChanged: number; additions: number; deletions: number };
    modifiedFiles?: string[];
    exitCode?: number;
    rawOutput?: string;
    error?: string;
  };
  cost?: {
    inputTokens?: number;
    outputTokens?: number;
    estimatedCostUsd?: number;
    durationMs?: number;
  };
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

const TOOL_META: Record<string, { label: string; icon: string; badgeClass: string }> = {
  'claude-code': { label: 'Claude Code', icon: '🤖', badgeClass: 'bg-orange-500/15 text-orange-500' },
  codex: { label: 'Codex', icon: '⬡', badgeClass: 'bg-emerald-500/15 text-emerald-500' },
  'cursor-agent': { label: 'Cursor', icon: '▶', badgeClass: 'bg-blue-500/15 text-blue-500' },
};

const STATUS_PIPELINE = ['created', 'context_injected', 'running'] as const;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'timeout']);

const STATUS_LABELS: Record<string, string> = {
  created: 'Created',
  context_injected: 'Context injected',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  timeout: 'Timed out',
};

function getToolMeta(tool: string) {
  return TOOL_META[tool] ?? {
    label: tool.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    icon: '⚙',
    badgeClass: 'bg-surface-elevated text-fg-tertiary',
  };
}

function computeDurationMs(session: CodingToolSession, now: number): number | undefined {
  if (session.cost?.durationMs != null) return session.cost.durationMs;
  const start = session.startedAt ?? session.createdAt;
  const startMs = new Date(start).getTime();
  if (Number.isNaN(startMs)) return undefined;
  if (session.completedAt) {
    const endMs = new Date(session.completedAt).getTime();
    return Number.isNaN(endMs) ? undefined : Math.max(0, endMs - startMs);
  }
  if (session.status === 'running' || session.status === 'context_injected') {
    return Math.max(0, now - startMs);
  }
  return undefined;
}

function statusIndex(status: string): number {
  if (status === 'completed') return STATUS_PIPELINE.length;
  if (TERMINAL_STATUSES.has(status)) return STATUS_PIPELINE.length;
  const idx = STATUS_PIPELINE.indexOf(status as typeof STATUS_PIPELINE[number]);
  return idx >= 0 ? idx : 0;
}

export interface CodingToolCardProps {
  session: CodingToolSession;
  className?: string;
}

export function CodingToolCard({ session, className }: CodingToolCardProps) {
  const meta = getToolMeta(session.tool);
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const isActive = session.status === 'running' || session.status === 'context_injected' || session.status === 'created';
  const isFailed = session.status === 'failed' || session.status === 'timeout' || session.result?.success === false;
  const isSuccess = session.status === 'completed' || session.result?.success === true;

  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isActive]);

  const durationMs = useMemo(() => computeDurationMs(session, now), [session, now]);
  const currentStep = statusIndex(session.status);
  const rawOutput = session.result?.rawOutput ?? (isSuccess || isFailed ? session.result?.summary : undefined);

  const borderClass = isActive
    ? 'border-brand-500/40 bg-brand-500/5'
    : isFailed
      ? 'border-red-500/30 bg-red-500/5'
      : isSuccess
        ? 'border-green-500/30 bg-green-500/5'
        : 'border-border-default bg-surface-secondary/30';

  return (
    <div className={`my-2 rounded-lg border ${borderClass} p-3 max-w-2xl transition-colors ${className ?? ''}`}>
      {/* Header */}
      <div className="flex items-start gap-2">
        <span className="text-sm mt-0.5">{meta.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${meta.badgeClass}`}>
              {meta.label}
            </span>
            <span className={`text-[10px] font-medium ${
              isActive ? 'text-brand-500' : isFailed ? 'text-red-500' : isSuccess ? 'text-green-500' : 'text-fg-tertiary'
            }`}>
              {STATUS_LABELS[session.status] ?? session.status}
            </span>
            {durationMs != null && (
              <span className="text-[10px] text-fg-tertiary tabular-nums">{formatDuration(durationMs)}</span>
            )}
            {session.cost?.estimatedCostUsd != null && (
              <span className="text-[10px] text-fg-tertiary tabular-nums">
                ${session.cost.estimatedCostUsd.toFixed(4)}
              </span>
            )}
          </div>
          <div className="text-xs text-fg-secondary mt-1 line-clamp-2">{session.prompt}</div>
        </div>
        {isActive && (
          <svg className="w-3.5 h-3.5 animate-spin text-brand-500 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        )}
      </div>

      {/* Status pipeline */}
      <div className="flex items-center gap-1 mt-3 ml-6">
        {STATUS_PIPELINE.map((step, i) => {
          const done = currentStep > i || (currentStep === i && !isActive && isSuccess);
          const active = currentStep === i && isActive;
          const failed = isFailed && i === STATUS_PIPELINE.length - 1 && session.status !== 'completed';
          return (
            <div key={step} className="flex items-center gap-1 flex-1 min-w-0">
              <div className={`w-2 h-2 rounded-full shrink-0 ${
                failed ? 'bg-red-500'
                : done ? 'bg-green-500'
                : active ? 'bg-brand-500 animate-pulse'
                : 'bg-gray-600'
              }`} title={STATUS_LABELS[step]} />
              {i < STATUS_PIPELINE.length - 1 && (
                <div className={`h-px flex-1 ${done ? 'bg-green-500/50' : 'bg-border-default/60'}`} />
              )}
            </div>
          );
        })}
        <div className={`w-2 h-2 rounded-full shrink-0 ${
          isFailed ? 'bg-red-500' : isSuccess ? 'bg-green-500' : isActive ? 'bg-gray-600' : 'bg-gray-600'
        }`} title={isFailed ? 'Failed' : 'Done'} />
      </div>

      {/* Progress */}
      {(session.progressMessage || session.progressPercent != null) && isActive && (
        <div className="mt-2 ml-6 space-y-1">
          {session.progressPercent != null && (
            <div className="h-1 bg-surface-elevated rounded-full overflow-hidden">
              <div
                className="h-full bg-brand-500 transition-all duration-300"
                style={{ width: `${Math.min(100, Math.max(0, session.progressPercent))}%` }}
              />
            </div>
          )}
          {session.progressMessage && (
            <div className="text-[11px] text-fg-tertiary font-mono truncate">{session.progressMessage}</div>
          )}
        </div>
      )}

      {/* Result summary & diff stats */}
      {session.result && !isActive && (
        <div className="mt-2 ml-6 space-y-1.5">
          {session.result.summary && (
            <div className="text-xs text-fg-secondary">{session.result.summary}</div>
          )}
          {session.result.diffStats && (
            <div className="flex items-center gap-3 text-[10px] font-mono">
              <span className="text-fg-tertiary">{session.result.diffStats.filesChanged} files</span>
              <span className="text-green-500">+{session.result.diffStats.additions}</span>
              <span className="text-red-500">−{session.result.diffStats.deletions}</span>
            </div>
          )}
          {session.cost && (session.cost.inputTokens != null || session.cost.outputTokens != null) && (
            <div className="text-[10px] text-fg-tertiary">
              {session.cost.inputTokens != null && <span>{session.cost.inputTokens.toLocaleString()} in</span>}
              {session.cost.inputTokens != null && session.cost.outputTokens != null && <span className="mx-1">·</span>}
              {session.cost.outputTokens != null && <span>{session.cost.outputTokens.toLocaleString()} out</span>}
            </div>
          )}
        </div>
      )}

      {/* Expandable raw output */}
      {rawOutput && (
        <div className="mt-2 ml-6 border-t border-border-default/30 pt-2">
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1.5 text-[10px] text-fg-tertiary hover:text-fg-secondary transition-colors"
          >
            <svg className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
            <span className="font-medium uppercase tracking-wider">Raw output</span>
          </button>
          {expanded && (
            <pre className="mt-2 text-[11px] text-fg-tertiary bg-surface-elevated/70 rounded-lg px-3 py-2 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap break-all font-mono">
              {rawOutput}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
