import { useEffect, useRef, useState, useCallback, type MouseEvent as ReactMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { AgentInfo } from '../api.ts';
import { MarkdownMessage } from '../components/MarkdownMessage.tsx';
import { ActivityIndicator, type ActivityStep } from '../components/ActivityIndicator.tsx';
import {
  CompactExecutionCard, FullExecutionLog,
  TaskApprovalCard, RequirementApprovalCard,
  parseTaskApprovalFromResult, parseRequirementApprovalFromResult,
  type ExecutionStreamEntryUI,
  type TaskApprovalInfo, type RequirementApprovalInfo,
} from '../components/ExecutionTimeline.tsx';
import { Avatar } from '../components/Avatar.tsx';
import type { ChatMsg, MsgSegment } from './ChatHelpers.ts';

// ─── NotificationBadge ────────────────────────────────────────────────────────

export function NotificationBadge({ priority }: { priority?: string }) {
  const isHigh = priority === 'high' || priority === 'critical';
  return (
    <div className={`inline-flex items-center gap-1 mt-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium ${
      isHigh
        ? 'bg-amber-500/10 text-amber-500 border border-amber-500/20'
        : 'bg-brand-500/10 text-brand-400 border border-brand-500/20'
    }`}>
      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      </svg>
      <span>Notification{priority && priority !== 'normal' ? ` · ${priority}` : ''}</span>
    </div>
  );
}

// ─── ChatAgentLink ────────────────────────────────────────────────────────────

export function ChatAgentLink({ name, agentId, agents, onViewProfile }: {
  name: string;
  agentId?: string;
  agents: AgentInfo[];
  onViewProfile?: (agentId: string) => void;
}) {
  const { t } = useTranslation(['team', 'common']);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const agent = agentId ? agents.find(a => a.id === agentId) : agents.find(a => a.name === name);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  if (!agent) return <span>{name}</span>;

  return (
    <span ref={ref} className="relative inline-block">
      <button onClick={() => setOpen(!open)} className="text-fg-tertiary hover:text-brand-500 cursor-pointer transition-colors">
        {name}
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1.5 bg-surface-secondary border border-border-default rounded-xl shadow-2xl z-40 w-56 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <Avatar name={agent.name} avatarUrl={agent.avatarUrl} size={28} bgClass="bg-brand-500/15 text-brand-600" />
            <div className="flex-1 min-w-0">
              <div className="text-xs text-fg-primary font-medium truncate">{agent.name}</div>
              <div className="text-[10px] text-fg-tertiary">{agent.role} · {agent.agentRole ?? t('page.workerRole')}</div>
            </div>
            <span className={`w-2 h-2 rounded-full shrink-0 ${
              agent.status === 'working' ? 'bg-blue-400 animate-pulse'
              : agent.status === 'error' ? 'bg-red-400'
              : (agent.lastError && agent.lastErrorAt && (Date.now() - new Date(agent.lastErrorAt).getTime()) < 30 * 60 * 1000) ? 'bg-amber-400'
              : 'bg-green-400'
            }`} />
          </div>
          <button
            onClick={() => { setOpen(false); onViewProfile?.(agent.id); }}
            className="w-full text-center text-[10px] text-brand-500 hover:text-brand-500 border border-border-default hover:border-gray-600 rounded-lg py-1 transition-colors"
          >
            {t('page.viewProfileArrow')}
          </button>
        </div>
      )}
    </span>
  );
}

// ─── AvatarPopover ────────────────────────────────────────────────────────────

export function AvatarPopover({ agent, anchorRect, onClose, onViewProfile }: {
  agent: AgentInfo;
  anchorRect: { top: number; left: number };
  onClose: () => void;
  onViewProfile: (agentId: string) => void;
}) {
  const { t } = useTranslation(['common', 'team']);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const hasRecentError = agent.status !== 'error' && !!agent.lastError && !!agent.lastErrorAt
    && (Date.now() - new Date(agent.lastErrorAt).getTime()) < 30 * 60 * 1000;
  const statusColor = agent.status === 'idle' && !hasRecentError ? 'bg-green-400'
    : agent.status === 'working' && !hasRecentError ? 'bg-blue-400 animate-pulse'
    : agent.status === 'error' ? 'bg-red-400'
    : hasRecentError ? 'bg-amber-400'
    : 'bg-gray-500';
  const statusLabel = agent.status === 'idle' ? t('common:status.online') : agent.status === 'working' ? t('common:status.working') : agent.status === 'error' ? t('common:status.error') : t('common:status.offline');

  const adjustRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    (ref as React.MutableRefObject<HTMLDivElement | null>).current = el;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = 8;
    if (rect.right > vw - pad) el.style.left = `${Math.max(pad, vw - rect.width - pad)}px`;
    if (rect.left < pad) el.style.left = `${pad}px`;
    if (rect.bottom > vh - pad) el.style.top = `${Math.max(pad, vh - rect.height - pad)}px`;
  }, []);

  return (
    <div
      ref={adjustRef}
      className="fixed z-50 w-64 max-w-[calc(100vw-1rem)] bg-surface-secondary border border-border-default rounded-xl shadow-2xl p-4 space-y-3"
      style={{ top: anchorRect.top + 40, left: anchorRect.left }}
    >
      <div className="flex items-center gap-3">
        <Avatar name={agent.name} avatarUrl={agent.avatarUrl} size={40} bgClass="bg-brand-500/15 text-brand-600" />
        <div className="flex-1 min-w-0">
          <div className="text-sm text-fg-primary font-medium truncate">{agent.name}</div>
          <div className="text-[11px] text-fg-tertiary">{agent.role}</div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className={`w-1.5 h-1.5 rounded-full ${statusColor}`} />
            <span className="text-[10px] text-fg-secondary">{statusLabel}</span>
            {agent.agentRole && <span className="text-[10px] text-fg-tertiary">· {agent.agentRole}</span>}
          </div>
        </div>
      </div>
      <button
        onClick={() => { onClose(); onViewProfile(agent.id); }}
        className="w-full py-1.5 text-xs text-brand-500 hover:text-brand-500 border border-border-default hover:border-gray-600 rounded-lg transition-colors text-center"
      >
        {t('team:page.viewProfileArrow')}
      </button>
    </div>
  );
}

// ─── friendlyAgentError ───────────────────────────────────────────────────────

export function friendlyAgentError(err: unknown, t: TFunction): string {
  const raw = String(err);

  if (raw.includes('AbortError') || raw.includes('abort'))
    return '';

  let detail = '';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { error?: { message?: string }; message?: string };
      detail = parsed.error?.message ?? parsed.message ?? '';
    } catch { /* ignore */ }
  }
  if (!detail) {
    const colonIdx = raw.lastIndexOf(': ');
    if (colonIdx >= 0) detail = raw.slice(colonIdx + 2).trim();
  }

  if (raw.includes('402') || /insufficient.?balance/i.test(raw))
    return t('errors.ai402', { detail: detail || t('errors.defaultInsufficientCredits') });
  if (raw.includes('401') || /unauthorized|invalid.?api.?key/i.test(raw))
    return t('errors.ai401', { detail: detail || t('errors.defaultInvalidApiKey') });
  if (raw.includes('429') || /rate.?limit/i.test(raw))
    return t('errors.ai429', { detail: detail || t('errors.defaultTooManyRequests') });
  if (raw.includes('503') || /service.?unavailable/i.test(raw))
    return t('errors.ai503', { detail: detail || t('errors.defaultServiceDown') });

  return t('errors.aiGeneric', { detail: detail || raw.slice(0, 120) });
}

// ─── MessageActions ───────────────────────────────────────────────────────────

export function MessageActions({
  msg, onCopy, onRetry, onResume, onReply, isCopied, isLastAgentMsg,
}: {
  msg: ChatMsg;
  onCopy: (msg: ChatMsg) => void;
  onRetry?: (msg: ChatMsg) => void;
  onResume?: (msg: ChatMsg) => void;
  onReply?: (msg: ChatMsg) => void;
  isCopied: boolean;
  isLastAgentMsg?: boolean;
}) {
  const { t } = useTranslation(['team', 'common']);
  const isError = msg.isError || (msg.sender === 'agent' && msg.text.startsWith('⚠'));
  const isStopped = msg.isStopped;
  const canRetry = isLastAgentMsg !== false;
  return (
    <div className="flex items-center gap-0.5 mt-1">
      <button onClick={() => onCopy(msg)} className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-fg-tertiary hover:text-fg-primary hover:bg-surface-overlay/60 transition-colors" title={t('copy')}>
        {isCopied
          ? <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12" /></svg>
          : <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
        }
        {isCopied ? t('copied') : t('copy')}
      </button>
      {canRetry && onResume && (
        <button onClick={() => onResume(msg)} className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-green-500 hover:text-green-400 hover:bg-green-500/10 transition-colors" title={t('page.messageActions.resumeTitle')}>
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3" /></svg>
          {t('page.messageActions.resumeTitle')}
        </button>
      )}
      {canRetry && isStopped && onRetry && (
        <button onClick={() => onRetry(msg)} className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-brand-500 hover:text-brand-500 hover:bg-brand-500/10 transition-colors" title={t('page.messageActions.reaskTitle')}>
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" /></svg>
          {t('page.messageActions.reaskTitle')}
        </button>
      )}
      {canRetry && isError && !isStopped && onRetry && (
        <button onClick={() => onRetry(msg)} className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-amber-600 hover:text-amber-600 hover:bg-amber-500/10 transition-colors" title={t('page.messageActions.retryTitle')}>
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" /></svg>
          {t('page.messageActions.retryTitle')}
        </button>
      )}
      {canRetry && !isError && !isStopped && msg.sender === 'agent' && onRetry && (
        <button onClick={() => onRetry(msg)} className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-fg-tertiary hover:text-fg-primary hover:bg-surface-overlay/60 transition-colors" title={t('page.messageActions.retryTitle')}>
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" /></svg>
          {t('page.messageActions.retryTitle')}
        </button>
      )}
      {onReply && (
        <button onClick={() => onReply(msg)} className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-fg-tertiary hover:text-fg-primary hover:bg-surface-overlay/60 transition-colors" title={t('page.messageActions.replyTitle')}>
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 17 4 12 9 7" /><path d="M20 18v-2a4 4 0 00-4-4H4" /></svg>
          {t('page.messageActions.replyTitle')}
        </button>
      )}
    </div>
  );
}

// ─── segmentsToStreamEntries ──────────────────────────────────────────────────

export function segmentsToStreamEntries(segments: ChatMsg['segments'], agentId?: string, msgTime?: string): ExecutionStreamEntryUI[] {
  if (!segments) return [];
  const entries: ExecutionStreamEntryUI[] = [];
  let seq = 0;
  const aid = agentId ?? '';

  const baseMs = msgTime ? new Date(msgTime).getTime() : Date.now();
  let cursorMs = baseMs;
  const hasRealTimestamps = segments.some(s => s.createdAt);

  const getTimestamp = (seg: MsgSegment): string => {
    if (seg.createdAt) return seg.createdAt;
    if (hasRealTimestamps) return new Date(cursorMs).toISOString();
    const ts = new Date(cursorMs).toISOString();
    if (seg.type === 'tool' && seg.durationMs) {
      cursorMs += seg.durationMs;
    } else {
      cursorMs += 1000;
    }
    return ts;
  };

  let insideThink = false;
  let thinkBuf = '';
  let textBuf = '';
  let currentSegTimestamp = '';

  const emitThinking = () => {
    const t = thinkBuf.trim();
    if (t) {
      entries.push({
        id: `cseg_${seq}`, sourceType: 'chat', sourceId: '', agentId: aid,
        seq: seq++, type: 'text', content: t, createdAt: currentSegTimestamp,
        metadata: { isThinking: true },
      });
    }
    thinkBuf = '';
  };

  const emitText = () => {
    const t = textBuf.trim();
    if (t) {
      entries.push({
        id: `cseg_${seq}`, sourceType: 'chat', sourceId: '', agentId: aid,
        seq: seq++, type: 'text', content: t, createdAt: currentSegTimestamp,
      });
    }
    textBuf = '';
  };

  const OPEN_TAG = '<think>';
  const CLOSE_TAG = '</think>';

  const processText = (content: string) => {
    let pos = 0;
    while (pos < content.length) {
      if (insideThink) {
        const closeIdx = content.indexOf(CLOSE_TAG, pos);
        if (closeIdx === -1) {
          thinkBuf += content.slice(pos);
          pos = content.length;
        } else {
          thinkBuf += content.slice(pos, closeIdx);
          insideThink = false;
          emitThinking();
          pos = closeIdx + CLOSE_TAG.length;
        }
      } else {
        const openIdx = content.indexOf(OPEN_TAG, pos);
        if (openIdx === -1) {
          textBuf += content.slice(pos);
          pos = content.length;
        } else {
          textBuf += content.slice(pos, openIdx);
          emitText();
          insideThink = true;
          pos = openIdx + OPEN_TAG.length;
        }
      }
    }
  };

  for (const seg of segments) {
    currentSegTimestamp = getTimestamp(seg);

    if (seg.type === 'tool') {
      if (!insideThink) emitText();

      const toolStartTs = seg.createdAt && seg.durationMs
        ? new Date(new Date(seg.createdAt).getTime() - seg.durationMs).toISOString()
        : currentSegTimestamp;

      entries.push({
        id: `cseg_${seq}`, sourceType: 'chat', sourceId: '', agentId: aid,
        seq: seq++, type: 'tool_start', content: seg.tool, metadata: { arguments: seg.args }, createdAt: toolStartTs,
      });
      if (seg.status !== 'running') {
        entries.push({
          id: `cseg_${seq}`, sourceType: 'chat', sourceId: '', agentId: aid,
          seq: seq++, type: 'tool_end', content: seg.tool,
          metadata: {
            arguments: seg.args, result: seg.result, error: seg.error, durationMs: seg.durationMs,
            success: seg.status !== 'error',
            ...(seg.subagentLogs?.length ? { subagentLogs: seg.subagentLogs } : {}),
          },
          createdAt: currentSegTimestamp,
        });
      }
    } else {
      if (seg.thinking) {
        if (!insideThink) emitText();
        thinkBuf += seg.thinking;
        emitThinking();
      }
      processText(seg.content);
    }
  }

  if (insideThink) {
    emitThinking();
  } else {
    emitText();
  }
  return entries;
}

// ─── AgentMessageBody ─────────────────────────────────────────────────────────

export function AgentMessageBody({
  msg, isStreaming, liveActivities, onViewModeChange,
  onMentionClick,
  knownNames,
}: {
  msg: ChatMsg;
  isStreaming: boolean;
  liveActivities: ActivityStep[];
  onViewModeChange?: (mode: 'compact' | 'full') => void;
  onMentionClick?: (name: string, event: ReactMouseEvent) => void;
  knownNames?: string[];
}) {
  const { t } = useTranslation(['team', 'common']);
  const segments = msg.segments;
  const isStopped = msg.isStopped;
  const [viewMode, setViewModeState] = useState<'compact' | 'full'>('compact');
  const setViewMode = useCallback((m: 'compact' | 'full') => { setViewModeState(m); onViewModeChange?.(m); }, [onViewModeChange]);

  if (segments !== undefined && segments.length > 0) {
    const hasTools = segments.some(s => s.type === 'tool');
    const streamEntries = segmentsToStreamEntries(segments, msg.agentId, msg.rawCreatedAt);
    const streamingText = isStreaming
      ? (() => {
          const raw = segments.filter(s => s.type === 'text').map(s => s.content).join('');
          const cleaned = raw
            .replace(/<think>[\s\S]*?(<\/think>|$)/g, '')
            .replace(/<(invoke|function_calls|antml:\w+)\b[\s\S]*?(<\/\1>|$)/g, '')
            .trim();
          return cleaned ? cleaned.slice(-200) : undefined;
        })()
      : undefined;
    const textSegments = segments.filter(s => s.type === 'text');
    const allText = !isStreaming ? textSegments.map(s => s.content).join('') : null;
    const stripMarkup = (t: string) => t
      .replace(/<think>[\s\S]*?(<\/think>|$)/g, '')
      .replace(/<(invoke|function_calls|antml:\w+)\b[\s\S]*?(<\/\1>|$)/g, '')
      .replace(/<\/?(invoke|function_calls|antml:\w+)[^>]*>/g, '')
      .trim() || null;
    const segmentText = allText ? stripMarkup(allText) : null;
    const displayText = segmentText
      || (!isStreaming && msg.text ? stripMarkup(msg.text) : null);

    const committed = msg.committedSegments;
    const fullLogEntries = committed && committed.length > 0
      ? segmentsToStreamEntries(committed, msg.agentId, msg.rawCreatedAt)
      : streamEntries;

    const inlineCards: Array<{ key: string } & ({ kind: 'task'; info: TaskApprovalInfo } | { kind: 'req'; info: RequirementApprovalInfo })> = [];
    if (viewMode === 'compact') {
      for (const seg of segments) {
        if (seg.type !== 'tool') continue;
        const ta = parseTaskApprovalFromResult(seg.tool, seg.result);
        if (ta) { inlineCards.push({ key: `task-${ta.taskId}`, kind: 'task', info: ta }); continue; }
        const ra = parseRequirementApprovalFromResult(seg.tool, seg.result);
        if (ra) { inlineCards.push({ key: `req-${ra.requirementId}`, kind: 'req', info: ra }); }
      }
    }

    return (
      <div className="space-y-2 min-h-[1em] min-w-0 overflow-x-hidden">
        {(hasTools || isStreaming) && (
          viewMode === 'compact' ? (
            <CompactExecutionCard
              entries={streamEntries}
              streamingText={streamingText}
              isActive={isStreaming}
              onExpand={() => setViewMode('full')}
              embedded
            />
          ) : (
            <FullExecutionLog
              entries={fullLogEntries}
              isActive={isStreaming}
              onCollapse={() => setViewMode('compact')}
              embedded
            />
          )
        )}

        {viewMode === 'compact' && inlineCards.map(c => c.kind === 'task'
          ? <TaskApprovalCard key={c.key} info={c.info} />
          : <RequirementApprovalCard key={c.key} info={c.info} />
        )}

        {viewMode === 'compact' && displayText && (
          <MarkdownMessage content={displayText} onMentionClick={onMentionClick} knownNames={knownNames} />
        )}

        {isStopped && (
          <div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-fg-tertiary">
            <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>
            <span>{t('page.stopped')}</span>
          </div>
        )}
      </div>
    );
  }

  const hasActivities = (msg.activities?.length ?? 0) > 0;
  const legacyText = msg.text
    ? msg.text
        .replace(/<think>[\s\S]*?(<\/think>|$)/g, '')
        .replace(/<(invoke|function_calls|antml:\w+)\b[\s\S]*?(<\/\1>|$)/g, '')
        .replace(/<\/?(invoke|function_calls|antml:\w+)[^>]*>/g, '')
        .trim()
    : '';
  return (
    <>
      {(isStreaming || hasActivities) && (
        <ActivityIndicator
          activities={isStreaming ? liveActivities : (msg.activities ?? [])}
          isActive={isStreaming}
          persistent={!isStreaming && hasActivities}
        />
      )}
      {legacyText ? <MarkdownMessage content={legacyText} onMentionClick={onMentionClick} knownNames={knownNames} /> : null}
      {isStopped && (
        <div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-fg-tertiary">
          <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>
          <span>{t('page.stopped')}</span>
        </div>
      )}
    </>
  );
}
