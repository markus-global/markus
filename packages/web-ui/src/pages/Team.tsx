import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  api, wsClient,
  type AgentInfo, type AgentToolEvent, type StreamCommitEvent, type HumanUserInfo, type ExternalAgentInfo,
  type ChatMessageInfo, type ChatSessionInfo, type ChannelMessageInfo, type ChannelMsgMetadata,
  type TaskInfo, type TeamInfo, type AuthUser, type StoredSegment,
} from '../api.ts';
import { MarkdownMessage } from '../components/MarkdownMessage.tsx';
import { ActivityIndicator, type ActivityStep } from '../components/ActivityIndicator.tsx';
import {
  ToolCallRow, ExecEntryRow, ThinkingDots,
  taskLogToEntry, activityLogToEntry, filterCompletedStarts, attachSubagentLogsToEntries,
  CompactExecutionCard, FullExecutionLog,
  TaskApprovalCard, RequirementApprovalCard,
  parseTaskApprovalFromResult, parseRequirementApprovalFromResult,
  type ExecEntry, type ExecutionStreamEntryUI,
  type TaskApprovalInfo, type RequirementApprovalInfo,
} from '../components/ExecutionTimeline.tsx';
import { navBus } from '../navBus.ts';
import { PAGE, resolvePageId, hashPath } from '../routes.ts';
import { parseMentionNames, renderMentionText } from '../components/CommentInput.tsx';
import { ChatTeamSidebar } from '../components/ChatTeamSidebar.tsx';
import { AgentProfile } from './AgentProfile.tsx';
import { TeamProfile } from './TeamProfile.tsx';
import { useResizablePanel } from '../hooks/useResizablePanel.ts';
import { useIsMobile } from '../hooks/useIsMobile.ts';
import { useSwipeTabs } from '../hooks/useSwipeTabs.ts';
import { Avatar } from '../components/Avatar.tsx';

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single interleaved segment: either text or a tool call */
export type MsgSegment =
  | { type: 'text'; content: string; thinking?: string; createdAt?: string }
  | { type: 'tool'; key: string; tool: string; status: 'running' | 'done' | 'error' | 'stopped'; args?: unknown; result?: string; error?: string; durationMs?: number; liveOutput?: string; subagentLogs?: import('../api.ts').SubagentProgressEvent[]; createdAt?: string };

interface ChatMsg {
  id: string;
  sender: 'user' | 'agent';
  text: string;
  /** Server-committed clean per-turn segments (thinking/text/tools), populated from thinking_commit/text_commit SSE events */
  committedSegments?: MsgSegment[];
  time: string;
  /** Raw ISO timestamp from DB */
  rawCreatedAt?: string;
  agentName?: string;
  agentId?: string;
  /** Chronologically interleaved segments (text + tool calls) — built during streaming */
  segments?: MsgSegment[];
  /** Legacy frozen activities for DB-loaded messages that predate the segments field */
  activities?: ActivityStep[];
  /** True when this message represents a failed AI response */
  isError?: boolean;
  /** True when this message was stopped by the user mid-stream */
  isStopped?: boolean;
  /** Attached image data URLs */
  images?: string[];
  /** Reply quote */
  replyToId?: string;
  replyToSender?: string;
  replyToText?: string;
  /** Activity log metadata — compact system card instead of bubble */
  isActivityLog?: boolean;
  activityType?: string;
  outcome?: string;
  mailboxItemId?: string;
  taskId?: string;
  requirementId?: string;
}

type ChatMode = 'channel' | 'direct' | 'dm';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dbMsgToChat(m: ChatMessageInfo): ChatMsg {
  const base: ChatMsg = {
    id: m.id,
    sender: m.role === 'user' ? 'user' : 'agent',
    text: m.content,
    time: new Date(m.createdAt).toLocaleTimeString(),
    rawCreatedAt: m.createdAt,
    agentId: m.role !== 'user' ? m.agentId : undefined,
  };
  if (m.role !== 'user' && m.metadata?.segments && m.metadata.segments.length > 0) {
    base.segments = m.metadata.segments.map((s: StoredSegment, i: number) =>
      s.type === 'tool'
        ? { type: 'tool' as const, key: `${s.tool}_${i}`, tool: s.tool, status: s.status, args: s.arguments, result: s.result, error: s.error, durationMs: s.durationMs, createdAt: s.createdAt }
        : { type: 'text' as const, content: s.content, thinking: s.thinking, createdAt: s.createdAt }
    );
  }
  if (m.metadata?.isError || (m.role === 'assistant' && m.content.startsWith('⚠'))) {
    base.isError = true;
  }
  if (m.metadata?.isStopped) {
    base.isStopped = true;
  }
  if (m.metadata?.images?.length) {
    base.images = m.metadata.images;
  }
  if (m.metadata?.activityLog) {
    base.isActivityLog = true;
    base.activityType = m.metadata.activityType;
    base.outcome = m.metadata.outcome;
    base.mailboxItemId = m.metadata.mailboxItemId;
    base.taskId = m.metadata.taskId;
    base.requirementId = m.metadata.requirementId;
    // Legacy compat: old rows have [ACTIVITY: type] prefix and outcome baked into content
    if (!base.outcome && base.text.startsWith('[ACTIVITY:')) {
      const arrowIdx = base.text.lastIndexOf(' → ');
      if (arrowIdx !== -1) base.outcome = base.text.slice(arrowIdx + 3);
      base.text = base.text.replace(/^\[ACTIVITY:\s*\w+\]\s*/, '');
    }
  }
  return base;
}

function channelMsgToChat(m: ChannelMessageInfo, authUserId?: string): ChatMsg {
  const isError = m.senderType === 'system' || (m.senderType === 'agent' && m.text.startsWith('⚠'));
  const isSelf = m.senderType === 'human' && (!authUserId || m.senderId === authUserId);
  const base: ChatMsg = {
    id: m.id,
    sender: isSelf ? 'user' : 'agent',
    text: m.text,
    time: new Date(m.createdAt).toLocaleTimeString(),
    rawCreatedAt: m.createdAt,
    agentName: isSelf ? undefined : m.senderName,
    agentId: isSelf ? undefined : m.senderId,
    isError,
    replyToId: m.replyToId,
    replyToSender: m.replyToSender,
    replyToText: m.replyToText,
  };
  // Build segments from metadata (thinking + tool calls)
  if (m.metadata && m.senderType === 'agent') {
    const segments: MsgSegment[] = [];
    const meta = m.metadata as ChannelMsgMetadata;
    if (meta.thinking?.length) {
      segments.push({ type: 'text', content: '', thinking: meta.thinking.join('\n\n') });
    }
    if (meta.toolCalls?.length) {
      for (let i = 0; i < meta.toolCalls.length; i++) {
        const tc = meta.toolCalls[i]!;
        segments.push({
          type: 'tool',
          key: `${tc.tool}_${i}`,
          tool: tc.tool,
          status: tc.status === 'error' ? 'error' : 'done',
          args: tc.arguments,
          result: tc.result,
          durationMs: tc.durationMs,
        });
      }
    }
    if (segments.length > 0) {
      segments.push({ type: 'text', content: m.text });
      base.segments = segments;
    }
  }
  return base;
}

function agentInitials(name: string) {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

function ChatAgentLink({ name, agentId, agents, onViewProfile }: { name: string; agentId?: string; agents: AgentInfo[]; onViewProfile?: (agentId: string) => void }) {
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
            <span className={`w-2 h-2 rounded-full shrink-0 ${agent.status === 'working' ? 'bg-blue-400 animate-pulse' : agent.status === 'error' ? 'bg-red-400' : 'bg-green-400'}`} />
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

/** Agent avatar popover — shown when clicking an agent avatar in chat messages */
function AvatarPopover({ agent, anchorRect, onClose, onViewProfile }: {
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

  const statusColor = agent.status === 'idle' ? 'bg-green-400' : agent.status === 'working' ? 'bg-blue-400 animate-pulse' : agent.status === 'error' ? 'bg-red-400' : 'bg-gray-500';
  const statusLabel = agent.status === 'idle' ? t('common:status.online') : agent.status === 'working' ? t('common:status.working') : agent.status === 'error' ? t('common:status.error') : agent.status === 'paused' ? t('common:status.paused') : t('common:status.offline');

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
        {t('page.viewProfileArrow')}
      </button>
    </div>
  );
}

/** Convert a raw LLM/network error into a user-friendly message with the actual reason */
function friendlyAgentError(err: unknown, t: TFunction): string {
  const raw = String(err);

  if (raw.includes('AbortError') || raw.includes('abort'))
    return '';  // user cancelled — show nothing

  // Try to extract a clean message from JSON payloads like:
  // Error: OpenAI API error 402: {"error":{"message":"Insufficient Balance",...}}
  let detail = '';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { error?: { message?: string }; message?: string };
      detail = parsed.error?.message ?? parsed.message ?? '';
    } catch { /* ignore */ }
  }
  if (!detail) {
    // Fall back to the text after the last colon (e.g. "OpenAI API error 402: Unauthorized")
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

// ─── AgentMessageBody ──────────────────────────────────────────────────────────
// Renders an agent message with tool calls and text interleaved in chronological order.

/** Action toolbar shown on hover below a message bubble */
function MessageActions({
  msg, onCopy, onRetry, onResume, onReply, isCopied, isLastAgentMsg,
}: {
  msg: ChatMsg;
  onCopy: (msg: ChatMsg) => void;
  onRetry?: (msg: ChatMsg) => void;
  onResume?: (msg: ChatMsg) => void;
  onReply?: (msg: ChatMsg) => void;
  isCopied: boolean;
  /** Only the most recent agent message should offer Retry/Resume/Re-ask */
  isLastAgentMsg?: boolean;
}) {
  const { t } = useTranslation(['team', 'common']);
  const isError = msg.isError || (msg.sender === 'agent' && msg.text.startsWith('⚠'));
  const isStopped = msg.isStopped;
  const canRetry = isLastAgentMsg !== false;
  return (
    <div className="flex items-center gap-0.5 mt-1">
      {/* Copy */}
      <button
        onClick={() => onCopy(msg)}
        className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-fg-tertiary hover:text-fg-primary hover:bg-surface-overlay/60 transition-colors"
        title={t('copy')}
      >
        {isCopied ? (
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12" /></svg>
        ) : (
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
        )}
        {isCopied ? t('copied') : t('copy')}
      </button>
      {/* Resume — for the last agent message (continue from where it left off) */}
      {canRetry && onResume && (
        <button
          onClick={() => onResume(msg)}
          className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-green-500 hover:text-green-400 hover:bg-green-500/10 transition-colors"
          title={t('page.messageActions.resumeTitle')}
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3" /></svg>
          {t('page.messageActions.resumeTitle')}
        </button>
      )}
      {/* Re-ask — for stopped messages (only on latest agent msg) */}
      {canRetry && isStopped && onRetry && (
        <button
          onClick={() => onRetry(msg)}
          className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-brand-500 hover:text-brand-500 hover:bg-brand-500/10 transition-colors"
          title={t('page.messageActions.reaskTitle')}
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" /></svg>
          {t('page.messageActions.reaskTitle')}
        </button>
      )}
      {/* Retry — for error messages (only on latest agent msg) */}
      {canRetry && isError && !isStopped && onRetry && (
        <button
          onClick={() => onRetry(msg)}
          className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-amber-600 hover:text-amber-600 hover:bg-amber-500/10 transition-colors"
          title={t('page.messageActions.retryTitle')}
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" /></svg>
          {t('page.messageActions.retryTitle')}
        </button>
      )}
      {/* Retry — for normal agent messages (only on latest agent msg) */}
      {canRetry && !isError && !isStopped && msg.sender === 'agent' && onRetry && (
        <button
          onClick={() => onRetry(msg)}
          className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-fg-tertiary hover:text-fg-primary hover:bg-surface-overlay/60 transition-colors"
          title={t('page.messageActions.retryTitle')}
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" /></svg>
          {t('page.messageActions.retryTitle')}
        </button>
      )}
      {/* Reply */}
      {onReply && (
        <button
          onClick={() => onReply(msg)}
          className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-fg-tertiary hover:text-fg-primary hover:bg-surface-overlay/60 transition-colors"
          title={t('page.messageActions.replyTitle')}
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 17 4 12 9 7" /><path d="M20 18v-2a4 4 0 00-4-4H4" /></svg>
          {t('page.messageActions.replyTitle')}
        </button>
      )}
    </div>
  );
}

/**
 * Convert message segments to execution stream entries for the timeline.
 *
 * Uses a stateful parser that tracks whether we are inside a `<think>` block
 * across segment and tool-call boundaries. This ensures:
 * - `<think>` blocks that span multiple segments are properly merged
 * - Real (non-thinking) text between tool calls is shown at its natural position
 * - Thinking content that spans a tool call is preserved across the gap
 */
function segmentsToStreamEntries(segments: ChatMsg['segments'], agentId?: string, msgTime?: string): ExecutionStreamEntryUI[] {
  if (!segments) return [];
  const entries: ExecutionStreamEntryUI[] = [];
  let seq = 0;
  const aid = agentId ?? '';

  // For old segments without per-segment createdAt, build incremental timestamps
  // starting from the message creation time.
  const baseMs = msgTime ? new Date(msgTime).getTime() : Date.now();
  let cursorMs = baseMs;
  const hasRealTimestamps = segments.some(s => s.createdAt);

  const getTimestamp = (seg: MsgSegment): string => {
    if (seg.createdAt) return seg.createdAt;
    if (hasRealTimestamps) return new Date(cursorMs).toISOString();
    // For legacy data, advance cursor by 1s for text, or use durationMs for tools
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


function AgentMessageBody({
  msg, isStreaming, liveActivities, onViewModeChange,
}: {
  msg: ChatMsg;
  isStreaming: boolean;
  liveActivities: import('../components/ActivityIndicator.tsx').ActivityStep[];
  onViewModeChange?: (mode: 'compact' | 'full') => void;
}) {
  const { t } = useTranslation(['team', 'common']);
  const segments = msg.segments;
  const isStopped = msg.isStopped;
  const [viewMode, setViewModeState] = useState<'compact' | 'full'>('compact');
  const setViewMode = useCallback((m: 'compact' | 'full') => { setViewModeState(m); onViewModeChange?.(m); }, [onViewModeChange]);

  // Messages with segment data: render compact card / full log + final text
  // If segments is defined but empty, fall through to legacy path using msg.text
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
    const displayText = allText
      ? allText
          .replace(/<think>[\s\S]*?(<\/think>|$)/g, '')
          .replace(/<(invoke|function_calls|antml:\w+)\b[\s\S]*?(<\/\1>|$)/g, '')
          .replace(/<\/?(invoke|function_calls|antml:\w+)[^>]*>/g, '')
          .trim() || null
      : null;

    // For the full execution log, prefer server-committed clean segments
    // (populated from thinking_commit/text_commit SSE events) over fragmented
    // delta-built segments.
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
      <div className="space-y-2 min-h-[1em] min-w-0 overflow-hidden">
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
          <MarkdownMessage content={displayText} />
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

  // Fallback: old messages from DB (no segments) — use legacy ActivityIndicator + text
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
      {legacyText ? <MarkdownMessage content={legacyText} /> : null}
      {isStopped && (
        <div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-fg-tertiary">
          <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>
          <span>{t('page.stopped')}</span>
        </div>
      )}
    </>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

type MainTab = 'chat' | 'profile';

// ── Hash-based store: the URL is the single source of truth for mobile nav ────
const _hashSubs = new Set<() => void>();
function _getHash() { return window.location.hash; }
function _subHash(cb: () => void) { _hashSubs.add(cb); return () => { _hashSubs.delete(cb); }; }
if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => _hashSubs.forEach(fn => fn()));
}

export function TeamPage({ initialAgentId, authUser }: { initialAgentId?: string; authUser?: AuthUser } = {}) {
  const { t, i18n } = useTranslation(['team', 'common']);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [humans, setHumans] = useState<HumanUserInfo[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const isMobile = useIsMobile();

  // Mobile: URL hash is the single source of truth (#chat = list, #chat/d = detail)
  const hash = useSyncExternalStore(_subHash, _getHash);
  const mobileShowChat = isMobile && (hash.startsWith(`#${PAGE.TEAM}/`) || hash.startsWith('#chat/'));

  const enterMobileDetail = useCallback(() => {
    window.location.hash = `${PAGE.TEAM}/d`;
  }, []);

  // Profile tab: still uses pushState for back navigation
  useEffect(() => {
    if (!isMobile) return;
    const onPop = () => {
      if (mainTabRef.current === 'profile') setMainTab('chat');
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [isMobile]);

  // Tab system: Chat vs Agent Profile
  const [mainTab, setMainTab] = useState<MainTab>('chat');
  const mainTabRef = useRef<MainTab>('chat');
  mainTabRef.current = mainTab;

  // Resizable chat left sidebar
  const chatSidebar = useResizablePanel({
    side: 'left',
    defaultWidth: 224,
    minWidth: 160,
    maxWidth: 360,
    storageKey: 'markus_chat_sidebar',
  });

  // Avatar popover in chat messages
  const [avatarPopover, setAvatarPopover] = useState<{ agentId: string; top: number; left: number } | null>(null);

  const [profileDefaultTab, setProfileDefaultTab] = useState<'overview' | 'mind' | undefined>();
  const [profileHighlightMailboxId, setProfileHighlightMailboxId] = useState<string | undefined>();

  const switchToProfile = useCallback((defaultTab?: 'overview' | 'mind', highlightMailboxId?: string) => {
    setProfileDefaultTab(defaultTab);
    setProfileHighlightMailboxId(highlightMailboxId);
    setMainTab('profile');
    if (isMobile) history.pushState({ mobileProfile: true }, '', window.location.hash);
  }, [isMobile]);

  const mainTabsList = [{ id: 'chat' as const }, { id: 'profile' as const }];
  const handleMainTabSwipe = useCallback((tab: MainTab) => {
    if (tab === 'profile') switchToProfile();
    else { if (mainTabRef.current === 'profile') history.back(); else setMainTab('chat'); }
  }, [switchToProfile]);
  const mainTabSwipe = useSwipeTabs(mainTabsList, mainTab, handleMainTabSwipe);

  const handleViewProfile = useCallback((agentId: string, opts?: { tab?: 'mind'; highlightMailboxId?: string }) => {
    setChatMode('direct');
    setSelectedAgent(agentId);
    if (isMobile) enterMobileDetail();
    switchToProfile(opts?.tab, opts?.highlightMailboxId);
    setAvatarPopover(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile, enterMobileDetail, switchToProfile]);

  // Mode & target
  const [chatMode, setChatMode] = useState<ChatMode>(
    () => initialAgentId ? 'direct' : ((localStorage.getItem('markus_chat_mode') as ChatMode | null) ?? 'direct')
  );
  const [selectedAgent, setSelectedAgent] = useState(
    () => initialAgentId ?? localStorage.getItem('markus_chat_agent') ?? ''
  );
  const [activeChannel, setActiveChannel] = useState(
    () => localStorage.getItem('markus_chat_channel') ?? '#general'
  );
  const [activeDmUserId, setActiveDmUserId] = useState<string>('');

  // ── Per-conversation buffers ──────────────────────────────────────────────────
  // Each conversation (agentId / channelName) stores its own message array
  // so that switching away never destroys in-progress streaming content.
  const msgBuffers    = useRef<Map<string, ChatMsg[]>>(new Map());
  const actBuffers    = useRef<Map<string, ActivityStep[]>>(new Map());
  const sendingConvs  = useRef<Set<string>>(new Set());
  // Which conv key the user is currently viewing (used inside async callbacks)
  const currentConvKeyRef = useRef<string>('');

  // Displayed state — always mirrors the current conv's buffer
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [chatReplyTo, setChatReplyTo] = useState<{ id: string; sender: string; text: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [streamingVisual, setStreamingVisual] = useState(false);
  const streamingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const STREAMING_MIN_DISPLAY_MS = 1500;
  useEffect(() => {
    if (sending) {
      if (streamingTimerRef.current) { clearTimeout(streamingTimerRef.current); streamingTimerRef.current = null; }
      setStreamingVisual(true);
    } else if (streamingVisual) {
      streamingTimerRef.current = setTimeout(() => { setStreamingVisual(false); streamingTimerRef.current = null; }, STREAMING_MIN_DISPLAY_MS);
    }
    return () => { if (streamingTimerRef.current) clearTimeout(streamingTimerRef.current); };
  }, [sending]); // eslint-disable-line react-hooks/exhaustive-deps
  const [activities, setActivities] = useState<ActivityStep[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Image attachments
  const [pendingImages, setPendingImages] = useState<Array<{ id: string; dataUrl: string; name: string }>>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Session management (direct mode)
  const NEW_CHAT_PLACEHOLDER_ID = '__new_chat__';
  const [sessions, setSessions] = useState<ChatSessionInfo[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [showSessions, setShowSessions] = useState(false);
  const [openSessionTabs, setOpenSessionTabs] = useState<ChatSessionInfo[]>([]);
  const sessionTabsBuffer = useRef<Map<string, ChatSessionInfo[]>>(new Map());
  const activeSessionBuffer = useRef<Map<string, string | null>>(new Map());
  const historyBtnRef = useRef<HTMLButtonElement>(null);
  const historyPanelRef = useRef<HTMLDivElement>(null);
  const oldestMsgId = useRef<string | null>(null);
  const loadingSessionRef = useRef<string | null>(null);

  // Group chats
  const [groupChats, setGroupChats] = useState<Array<{ id: string; name: string; type: string; channelKey: string; memberCount?: number; teamId?: string; creatorId?: string; creatorName?: string; members?: Array<{ id: string; name: string; type: 'human' | 'agent' }> }>>([]);
  const [showMemberPanel, setShowMemberPanel] = useState(false);

  // Teams
  const [teams, setTeams] = useState<TeamInfo[]>([]);

  // External agents (OpenClaw etc.)
  const [externalAgents, setExternalAgents] = useState<ExternalAgentInfo[]>([]);

  // Task context
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [linkedTaskId, setLinkedTaskId] = useState<string | null>(null);
  const [showTaskPicker, setShowTaskPicker] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');

  // Channel @mention
  const [mentionDropdown, setMentionDropdown] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);

  const activeTeamId = chatMode === 'channel'
    ? groupChats.find(gc => gc.channelKey === activeChannel)?.teamId
    : undefined;

  const messagesEnd = useRef<HTMLDivElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const sendRef = useRef<(text?: string) => Promise<void>>(undefined);
  /** When true, the next scroll-to-bottom effect is suppressed (used by loadMore) */
  const skipScrollRef = useRef(false);
  /** Tracks whether user is at/near the bottom of the chat scroll container */
  const userAtBottomRef = useRef(true);
  /** Stable ref to loadMore for use in IntersectionObserver callback */
  const loadMoreRef = useRef<() => Promise<void>>(undefined);

  // Close history panel on click outside
  useEffect(() => {
    if (!showSessions) return;
    const handler = (e: MouseEvent) => {
      if (
        historyPanelRef.current && !historyPanelRef.current.contains(e.target as Node) &&
        historyBtnRef.current && !historyBtnRef.current.contains(e.target as Node)
      ) {
        setShowSessions(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showSessions]);

  // ── Conv-buffer helpers ───────────────────────────────────────────────────────
  const makeDmChannel = (myId: string, otherId: string) => {
    // Self-notes use a single-user channel; two-user DMs use sorted IDs for symmetry
    if (!otherId || myId === otherId) return `notes:${myId}`;
    const [a, b] = [myId, otherId].sort();
    return `dm:${a}:${b}`;
  };

  const makeConvKey = (mode: ChatMode, agent: string, channel: string, dmUserId?: string) =>
    mode === 'channel' ? `ch:${channel}` :
    mode === 'dm'      ? `dm:${dmUserId ?? ''}` :
    (agent || '_direct');

  /** Write to a conversation's message buffer and refresh display if currently viewing it */
  const updateConvMsgs = useCallback((key: string, updater: (prev: ChatMsg[]) => ChatMsg[]) => {
    const next = updater(msgBuffers.current.get(key) ?? []);
    msgBuffers.current.set(key, next);
    if (currentConvKeyRef.current === key) setMessages(next);
  }, []);

  /** Append an activity step to a conversation's activity buffer */
  const appendConvActivity = (key: string, step: ActivityStep) => {
    const next = [...(actBuffers.current.get(key) ?? []), step];
    actBuffers.current.set(key, next);
    if (currentConvKeyRef.current === key) setActivities(next);
  };

  // ── Persistence ─────────────────────────────────────────────────────────────
  useEffect(() => { localStorage.setItem('markus_chat_mode', chatMode); }, [chatMode]);
  useEffect(() => { localStorage.setItem('markus_chat_agent', selectedAgent); }, [selectedAgent]);
  useEffect(() => { localStorage.setItem('markus_chat_channel', activeChannel); }, [activeChannel]);

  // ── Data loading ─────────────────────────────────────────────────────────────
  const refreshAgents = useCallback(() => api.agents.list().then(d => setAgents(d.agents)).catch(() => {}), []);
  const refreshTeams = useCallback(() => api.teams.list().then(d => setTeams(d.teams)).catch(() => {}), []);
  const refreshGroupChats = useCallback(() => api.groupChats.list().then(d => setGroupChats(d.chats)).catch(() => {}), []);
  const refreshHumans = useCallback(() => {
    api.users.list(authUser?.orgId).then(d => setHumans(d.users)).catch(() => {});
  }, [authUser?.orgId]);

  useEffect(() => {
    Promise.all([
      refreshAgents(),
      refreshTeams(),
    ]).finally(() => setInitialLoading(false));
    refreshHumans();
    api.tasks.list().then(d => setTasks(d.tasks)).catch(() => {});
    api.externalAgents.list().then(d => setExternalAgents(d.agents)).catch(() => {});
    refreshGroupChats();

    const timer = setInterval(refreshAgents, 8000);
    const teamTimer = setInterval(refreshTeams, 15000);
    const unsub = wsClient.on('agent:update', refreshAgents);
    const unsubTeam = wsClient.on('*', refreshTeams);
    const unsubGroup = wsClient.on('chat:group_created', refreshGroupChats);
    const unsubGroupUpdate = wsClient.on('chat:group_updated', refreshGroupChats);
    const unsubGroupDelete = wsClient.on('chat:group_deleted', refreshGroupChats);
    const onDataChanged = () => { refreshAgents(); refreshTeams(); refreshHumans(); };
    window.addEventListener('markus:data-changed', onDataChanged);
    return () => { clearInterval(timer); clearInterval(teamTimer); unsub(); unsubTeam(); unsubGroup(); unsubGroupUpdate(); unsubGroupDelete(); window.removeEventListener('markus:data-changed', onDataChanged); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshHumans]);

  // Check for nav params (e.g., navigated here from AgentProfile or Team redirect)
  useEffect(() => {
    const handleNav = (e: Event) => {
      const detail = (e as CustomEvent<{ page: string; params?: Record<string, string> }>).detail;
      if (resolvePageId(detail.page) === PAGE.TEAM) {
        if (detail.params?.agentId) {
          if (detail.params.profileTab) {
            handleViewProfile(detail.params.agentId, { tab: detail.params.profileTab as 'mind' });
          } else {
            setChatMode('direct');
            setSelectedAgent(detail.params.agentId);
            if (detail.params.sessionId) {
              const targetSessionId = detail.params.sessionId;
              setTimeout(async () => {
                try {
                  const { sessions: s } = await api.sessions.listByAgent(detail.params!.agentId, 20);
                  const target = s.find((ss: ChatSessionInfo) => ss.id === targetSessionId);
                  if (target) void switchSession(target);
                } catch { /* session will load normally */ }
              }, 300);
            }
          }
        }
        if (detail.params?.selectAgent) {
          handleViewProfile(detail.params.selectAgent);
        }
        if (detail.params?.prefillMessage) {
          setInput(detail.params.prefillMessage);
          setTimeout(() => textareaRef.current?.focus(), 100);
        }
        if (detail.params?.dm) {
          setChatMode('dm');
          setActiveDmUserId(detail.params.dm);
          setMainTab('chat');
        }
        if (detail.params?.channel) {
          setChatMode('channel');
          setActiveChannel(detail.params.channel);
          setMainTab('chat');
        }
        if (detail.params?.openHire === 'true') {
          // handled by ChatTeamSidebar via nav events
        }
      }
    };
    const navAgent = localStorage.getItem('markus_nav_agentId');
    if (navAgent) {
      localStorage.removeItem('markus_nav_agentId');
      const pTab = localStorage.getItem('markus_nav_profileTab');
      if (pTab) { localStorage.removeItem('markus_nav_profileTab'); handleViewProfile(navAgent, { tab: pTab as 'mind' }); }
      else { setChatMode('direct'); setSelectedAgent(navAgent); }
    }
    const navDm = localStorage.getItem('markus_nav_dm');
    if (navDm) {
      localStorage.removeItem('markus_nav_dm');
      setChatMode('dm'); setActiveDmUserId(navDm); setMainTab('chat');
    }
    const navChannel = localStorage.getItem('markus_nav_channel');
    if (navChannel) {
      localStorage.removeItem('markus_nav_channel');
      setChatMode('channel'); setActiveChannel(navChannel); setMainTab('chat');
    }
    const selectAgent = localStorage.getItem('markus_nav_selectAgent');
    if (selectAgent) {
      localStorage.removeItem('markus_nav_selectAgent');
      handleViewProfile(selectAgent);
    }
    window.addEventListener('markus:navigate', handleNav);
    return () => window.removeEventListener('markus:navigate', handleNav);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-select secretary agent when no valid agent is selected.
  // Also handles stale IDs from localStorage (e.g. deleted agents).
  useEffect(() => {
    if (agents.length === 0) return;
    if (selectedAgent && agents.some(a => a.id === selectedAgent)) return;
    const secretary = agents.find(a => a.role === 'secretary')
      ?? agents.find(a => a.name?.toLowerCase().includes('secretary'));
    if (secretary) {
      setChatMode('direct');
      setSelectedAgent(secretary.id);
      setMainTab('chat');
    } else if (agents.length > 0) {
      setChatMode('direct');
      setSelectedAgent(agents[0]!.id);
      setMainTab('chat');
    }
  }, [agents, selectedAgent]);

  // Track whether the user is at the bottom of the chat scroll container.
  // Uses wheel/touch events to detect genuine user interaction (not programmatic scrolls),
  // and the scroll event to detect when the user scrolls back to the bottom.
  const userManuallyScrolledRef = useRef(false);
  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const isAtBottom = () => el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    const onUserScroll = () => { userManuallyScrolledRef.current = true; };
    const onScroll = () => {
      if (userManuallyScrolledRef.current && isAtBottom()) {
        userManuallyScrolledRef.current = false;
        userAtBottomRef.current = true;
      } else if (userManuallyScrolledRef.current) {
        userAtBottomRef.current = false;
      }
    };
    el.addEventListener('wheel', onUserScroll, { passive: true });
    el.addEventListener('touchmove', onUserScroll, { passive: true });
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('wheel', onUserScroll);
      el.removeEventListener('touchmove', onUserScroll);
      el.removeEventListener('scroll', onScroll);
    };
  }, []);

  // Snap to bottom after DOM updates, but only if user hasn't scrolled up.
  useLayoutEffect(() => {
    if (skipScrollRef.current) {
      skipScrollRef.current = false;
      return;
    }
    if (!userAtBottomRef.current) return;
    messagesEnd.current?.scrollIntoView({ behavior: 'instant' });
  }, [messages, activities]);

  useEffect(() => {
    if (mainTab === 'chat') {
      requestAnimationFrame(() => {
        messagesEnd.current?.scrollIntoView({ behavior: 'instant' });
        userAtBottomRef.current = true;
      });
    }
  }, [mainTab]);

  useEffect(() => {
    const scrollToLatest = () => {
      if (resolvePageId(window.location.hash.slice(1).split('/')[0]) !== PAGE.TEAM) return;
      if (mainTabRef.current !== 'chat') return;
      requestAnimationFrame(() => {
        messagesEnd.current?.scrollIntoView({ behavior: 'instant' });
      });
    };
    window.addEventListener('hashchange', scrollToLatest);
    window.addEventListener('markus:navigate', scrollToLatest);
    return () => {
      window.removeEventListener('hashchange', scrollToLatest);
      window.removeEventListener('markus:navigate', scrollToLatest);
    };
  }, []);

  // Load channel messages from DB → store in buffer + update display
  const loadChannelMessages = useCallback(async (channel: string, bufferKey?: string) => {
    const key = bufferKey ?? `ch:${channel}`;
    try {
      const result = await api.channels.getMessages(channel, 50);
      const msgs = result.messages.map(m => channelMsgToChat(m, authUser?.id));
      msgBuffers.current.set(key, msgs);
      if (currentConvKeyRef.current === key) {
        setMessages(msgs);
        setHasMore(result.hasMore);
        oldestMsgId.current = result.messages[0] ? new Date(result.messages[0].createdAt).toISOString() : null;
      }
    } catch {
      if (currentConvKeyRef.current === key) { setMessages([]); setHasMore(false); }
    }
  }, []);

  // Load session messages from DB → store in buffer + update display
  const loadSessionMessages = useCallback(async (sessionId: string, convKey: string) => {
    loadingSessionRef.current = sessionId;
    try {
      const result = await api.sessions.getMessages(sessionId, 50);
      const msgs = result.messages.map(dbMsgToChat);
      msgBuffers.current.set(convKey, msgs);
      if (currentConvKeyRef.current === convKey && loadingSessionRef.current === sessionId) {
        setMessages(msgs);
        setHasMore(result.hasMore);
        oldestMsgId.current = result.messages[0] ? new Date(result.messages[0].createdAt).toISOString() : null;
      }
    } catch {
      if (currentConvKeyRef.current === convKey && loadingSessionRef.current === sessionId) { setMessages([]); setHasMore(false); oldestMsgId.current = null; }
    }
  }, []);

  // Load sessions list for agent
  const loadSessions = useCallback(async (agentId: string) => {
    if (!agentId) { setSessions([]); return []; }
    try {
      const { sessions: s } = await api.sessions.listByAgent(agentId, 10);
      setSessions(s);
      return s;
    } catch { setSessions([]); return []; }
  }, []);

  // Load more (pagination) — preserves scroll position after prepending
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || !oldestMsgId.current) return;
    setLoadingMore(true);
    const scrollEl = chatScrollRef.current;
    const prevScrollHeight = scrollEl?.scrollHeight ?? 0;
    try {
      const convKey = currentConvKeyRef.current;
      if (chatMode === 'channel' || chatMode === 'dm') {
        const channelName = chatMode === 'dm' ? makeDmChannel(authUser?.id ?? '', activeDmUserId) : activeChannel;
        const result = await api.channels.getMessages(channelName, 50, oldestMsgId.current);
        const newMsgs = result.messages.map(m => channelMsgToChat(m, authUser?.id));
        skipScrollRef.current = true;
        setMessages(prev => {
          const combined = [...newMsgs, ...prev];
          msgBuffers.current.set(convKey, combined);
          return combined;
        });
        setHasMore(result.hasMore);
        if (result.messages[0]) oldestMsgId.current = new Date(result.messages[0].createdAt).toISOString();
      } else if (activeSessionId) {
        const result = await api.sessions.getMessages(activeSessionId, 50, oldestMsgId.current);
        const newMsgs = result.messages.map(dbMsgToChat);
        skipScrollRef.current = true;
        setMessages(prev => {
          const combined = [...newMsgs, ...prev];
          msgBuffers.current.set(convKey, combined);
          return combined;
        });
        setHasMore(result.hasMore);
        if (result.messages[0]) oldestMsgId.current = new Date(result.messages[0].createdAt).toISOString();
      }
    } catch { /* ignore */ } finally {
      setLoadingMore(false);
      // Restore scroll position after React re-render
      requestAnimationFrame(() => {
        if (scrollEl) {
          const newScrollHeight = scrollEl.scrollHeight;
          scrollEl.scrollTop += newScrollHeight - prevScrollHeight;
        }
      });
    }
  }, [loadingMore, hasMore, chatMode, activeChannel, activeSessionId, authUser?.id, activeDmUserId]);

  loadMoreRef.current = loadMore;

  // Auto-load earlier messages when user scrolls near the top.
  // Uses a React onScroll handler instead of addEventListener so it works
  // on mobile where the chat container is conditionally mounted.
  const scrollTickingRef = useRef(false);
  const handleChatScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (scrollTickingRef.current) return;
    scrollTickingRef.current = true;
    requestAnimationFrame(() => {
      scrollTickingRef.current = false;
      if ((e.target as HTMLDivElement).scrollTop < 100) {
        loadMoreRef.current?.();
      }
    });
  }, []);

  // When mode/target changes: switch to the new conversation's buffer.
  // If the new conv is already streaming or has buffered messages, show them immediately.
  // Otherwise load from DB.
  useEffect(() => {
    const newKey = makeConvKey(chatMode, selectedAgent, activeChannel, activeDmUserId);
    const prevKey = currentConvKeyRef.current;
    currentConvKeyRef.current = newKey;

    // Save current session tabs & active session before switching away
    if (prevKey && prevKey !== newKey) {
      sessionTabsBuffer.current.set(prevKey, openSessionTabs);
      activeSessionBuffer.current.set(prevKey, activeSessionId);
    }

    // Restore displayed state from this conv's buffer
    const bufferedMsgs = msgBuffers.current.get(newKey);
    const bufferedActs = actBuffers.current.get(newKey) ?? [];
    const isSending = sendingConvs.current.has(newKey);

    setActivities(bufferedActs);
    setSending(isSending);

    // Always reload sessions list for direct mode so History panel stays accurate
    if (chatMode === 'direct' && selectedAgent) {
      loadSessions(selectedAgent);
    }
    // Restore or reset session tabs for the new agent
    const savedTabs = sessionTabsBuffer.current.get(newKey);
    const savedActiveSession = activeSessionBuffer.current.get(newKey);
    if (savedTabs && savedTabs.length > 0) {
      setOpenSessionTabs(savedTabs);
    }
    // If no saved tabs, we'll populate from DB below for direct mode
    setShowSessions(false);

    if (bufferedMsgs !== undefined) {
      // Already have content (possibly mid-stream) — show immediately
      setMessages(bufferedMsgs);
      setHasMore(false);
      if (savedActiveSession !== undefined) {
        setActiveSessionId(savedActiveSession);
      }
      if (!savedTabs || savedTabs.length === 0) setOpenSessionTabs([]);
      // For channel/dm modes, refresh from server in background to catch anything we missed
      if (chatMode === 'channel' || chatMode === 'dm') {
        const channelName = chatMode === 'dm'
          ? makeDmChannel(authUser?.id ?? '', activeDmUserId)
          : activeChannel;
        loadChannelMessages(channelName, newKey);
      }
    } else {
      // First visit for this conversation — load from DB
      setMessages([]);
      setHasMore(false);
      oldestMsgId.current = null;

      if (chatMode === 'channel' || chatMode === 'dm') {
        const channelName = chatMode === 'dm'
          ? makeDmChannel(authUser?.id ?? '', activeDmUserId)
          : activeChannel;
        loadChannelMessages(channelName, newKey);
        if (!savedTabs || savedTabs.length === 0) setOpenSessionTabs([]);
      } else if (chatMode === 'direct' && selectedAgent) {
        loadSessions(selectedAgent).then(s => {
          if (currentConvKeyRef.current !== newKey) return;
          if (s.length > 0) {
            // Ensure main session is always first in the default tab list
            const mainSession = s.find(ss => ss.isMain);
            const defaultTabs = mainSession
              ? [mainSession, ...s.filter(ss => !ss.isMain).slice(0, 4)]
              : s.slice(0, 5);
            const initialTabs = (savedTabs && savedTabs.length > 0) ? savedTabs : defaultTabs;
            const restoreId = savedActiveSession !== undefined ? savedActiveSession : (mainSession?.id ?? initialTabs[0]!.id);
            const validId = restoreId && initialTabs.some(t => t.id === restoreId) ? restoreId : initialTabs[0]!.id;
            setActiveSessionId(validId);
            setOpenSessionTabs(initialTabs);
            loadSessionMessages(validId!, newKey);
          } else {
            setActiveSessionId(null);
            if (!savedTabs || savedTabs.length === 0) setOpenSessionTabs([]);
            // First-time conversation: auto-send intro request (locale from app language, fallback en)
            const introBase = (i18n.language || 'en').split('-')[0]?.toLowerCase() ?? 'en';
            const introKey = ['zh', 'ja', 'ko', 'fr', 'de', 'es', 'pt', 'ru'].includes(introBase) ? introBase : 'en';
            const introMsg = t(`intro.${introKey}`);
            setTimeout(() => sendRef.current?.(introMsg), 150);
          }
        });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatMode, selectedAgent, activeChannel, activeDmUserId, i18n.language, t]);

  // WS live updates for channel mode — buffer messages for ALL channels, not just the active one
  useEffect(() => {
    const unsub = wsClient.on('chat:message', (event) => {
      const p = event.payload;
      const msgChannel = (p['channel'] as string) ?? '';
      if (!msgChannel) return;
      const senderType = (p['senderType'] as string) ?? 'agent';
      const wsText = (p['text'] as string) ?? (p['message'] as string) ?? '';
      const wsSenderId = (p['senderId'] as string) ?? (p['agentId'] as string) ?? '';
      const wsSenderName = (p['senderName'] as string) ?? (p['agentId'] as string) ?? t('page.fallbackAgent');
      const wsMeta = p['metadata'] as ChannelMsgMetadata | undefined;

      const isSelf = senderType === 'human' && wsSenderId === (authUser?.id ?? '');
      const newMsg: ChatMsg = {
        id: `ws_${Date.now()}_${wsSenderId}`,
        sender: isSelf ? 'user' : 'agent',
        text: wsText,
        time: new Date().toLocaleTimeString(),
        agentName: isSelf ? undefined : wsSenderName,
        agentId: isSelf ? undefined : wsSenderId,
        replyToId: (p['replyToId'] as string) ?? undefined,
        replyToSender: (p['replyToSender'] as string) ?? undefined,
        replyToText: (p['replyToText'] as string) ?? undefined,
      };

      if (wsMeta && senderType === 'agent') {
        const segs: MsgSegment[] = [];
        if (wsMeta.thinking?.length) {
          segs.push({ type: 'text', content: '', thinking: wsMeta.thinking.join('\n\n') });
        }
        if (wsMeta.toolCalls?.length) {
          for (let i = 0; i < wsMeta.toolCalls.length; i++) {
            const tc = wsMeta.toolCalls[i]!;
            segs.push({
              type: 'tool', key: `${tc.tool}_${i}`, tool: tc.tool,
              status: tc.status === 'error' ? 'error' : 'done',
              args: tc.arguments, result: tc.result, durationMs: tc.durationMs,
            });
          }
        }
        if (segs.length > 0) {
          segs.push({ type: 'text', content: wsText });
          newMsg.segments = segs;
        }
      }

      let key: string;
      if (msgChannel.startsWith('notes:')) {
        key = `dm:${msgChannel.slice(6)}`;
      } else if (msgChannel.startsWith('dm:')) {
        const parts = msgChannel.slice(3).split(':');
        const otherId = parts.find(id => id !== (authUser?.id ?? '')) ?? parts[0] ?? '';
        key = `dm:${otherId}`;
      } else {
        key = `ch:${msgChannel}`;
      }
      updateConvMsgs(key, prev => [...prev, newMsg]);
    });
    return unsub;
  }, [updateConvMsgs, authUser?.id]);

  // WS live updates for proactive agent messages (direct mode)
  useEffect(() => {
    const unsub = wsClient.on('chat:proactive_message', (event) => {
      const p = event.payload;
      const targetUserId = p['targetUserId'] as string | undefined;
      if (targetUserId && targetUserId !== authUser?.id) return;
      const agentId = (p['agentId'] as string) ?? '';
      const agentName = (p['agentName'] as string) ?? t('page.fallbackAgent');
      const message = (p['message'] as string) ?? '';
      const sessionId = (p['sessionId'] as string) ?? '';
      const meta = (p['metadata'] as Record<string, unknown>) ?? {};
      if (!agentId || !message) return;

      const isActivity = !!meta.activityLog || message.startsWith('[ACTIVITY:');

      // Append to display if we're viewing this agent's direct chat
      if (chatMode === 'direct' && selectedAgent === agentId) {
        const newMsg: ChatMsg = {
          id: `proactive_${Date.now()}`,
          sender: 'agent',
          text: message,
          time: new Date().toLocaleTimeString(),
          agentName,
          agentId,
          ...(isActivity ? {
            isActivityLog: true,
            activityType: meta.activityType as string | undefined,
            outcome: meta.outcome as string | undefined,
            mailboxItemId: meta.mailboxItemId as string | undefined,
            taskId: meta.taskId as string | undefined,
            requirementId: meta.requirementId as string | undefined,
          } : {}),
        };
        const key = makeConvKey('direct', agentId, activeChannel, activeDmUserId);
        updateConvMsgs(key, prev => [...prev, newMsg]);
      }
    });
    return unsub;
  }, [chatMode, selectedAgent, activeChannel, activeDmUserId, activeSessionId, updateConvMsgs, t]);

  // ── Task helpers ─────────────────────────────────────────────────────────────
  const linkedTask = tasks.find(t => t.id === linkedTaskId);

  const createAndLinkTask = async () => {
    if (!selectedAgent) return;
    const title = newTaskTitle.trim() || (messages[0]?.text.slice(0, 60) ?? t('page.newTaskTitle'));
    try {
      await api.tasks.create(title, t('page.taskFromChat', { name: currentAgent?.name ?? t('page.fallbackAgent') }), selectedAgent, selectedAgent, 'medium');
      setNewTaskTitle('');
      setShowTaskPicker(false);
      // Reload tasks to get new ID
      const { tasks: updated } = await api.tasks.list();
      setTasks(updated);
      const newest = updated.find(t => t.title === title);
      if (newest) setLinkedTaskId(newest.id);
    } catch { /* ignore */ }
  };

  // Reset linked task when switching agents
  useEffect(() => { setLinkedTaskId(null); }, [selectedAgent]);

  // ── Sending ──────────────────────────────────────────────────────────────────
  const parseMentions = (text: string) => parseMentionNames(text);

  const stopSending = () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    // Immediately unblock the UI — don't wait for the async send() to catch the abort
    const sendKey = currentConvKeyRef.current;
    sendingConvs.current.delete(sendKey);
    actBuffers.current.delete(sendKey);
    setSending(false);
    setActivities([]);
  };

  const send = async (retryText?: string, options?: { isRetry?: boolean; isResume?: boolean }) => {
    const text = (retryText ?? input).trim();
    if (!text && pendingImages.length === 0) return;
    if (chatMode === 'direct' && !selectedAgent) return;
    userAtBottomRef.current = true;
    userManuallyScrolledRef.current = false;

    // If agent is currently streaming, interrupt it first then proceed
    if (sending) {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      const prevKey = currentConvKeyRef.current;
      sendingConvs.current.delete(prevKey);
      actBuffers.current.delete(prevKey);
      // Mark the current agent message as stopped
      updateConvMsgs(prevKey, prev => {
        const u = [...prev];
        for (let i = u.length - 1; i >= 0; i--) {
          if (u[i]!.sender === 'agent' && !u[i]!.isStopped && !u[i]!.isError) {
            const msg = u[i]!;
            const segs = (msg.segments ?? []).map(s =>
              s.type === 'tool' && s.status === 'running' ? { ...s, status: 'stopped' as const } : s
            );
            u[i] = { ...msg, isStopped: true, segments: segs };
            break;
          }
        }
        return u;
      });
      setSending(false);
      setActivities([]);
      // Small delay to let abort propagate before starting new stream
      await new Promise(r => setTimeout(r, 50));
    }

    const imagesToSend = pendingImages.length > 0 ? pendingImages.map(img => img.dataUrl) : undefined;
    const fileNamesToSend = pendingImages.length > 0 ? pendingImages.map(img => img.name) : undefined;
    const sendKey = makeConvKey(chatMode, selectedAgent, activeChannel, activeDmUserId);
    const replyCtx = chatReplyTo;

    if (!retryText) {
      setInput('');
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
    }
    setPendingImages([]);
    setMentionDropdown(false);
    setChatReplyTo(null);

    // Mark this conv as sending (skip for DM — instant DB write, no LLM wait)
    const isDm = chatMode === 'dm';
    sendingConvs.current.add(sendKey);
    actBuffers.current.set(sendKey, []);
    if (currentConvKeyRef.current === sendKey && !isDm) {
      setSending(true);
      setActivities([]);
    }

    if (chatMode === 'dm') {
      // Human-to-human DM or personal notepad — no agent routing
      const dmChannel = makeDmChannel(authUser?.id ?? '', activeDmUserId);
      const optId = `opt_${Date.now()}`;
      const userMsgDm: ChatMsg = { id: optId, sender: 'user', text, time: new Date().toLocaleTimeString() };
      if (replyCtx) { userMsgDm.replyToId = replyCtx.id; userMsgDm.replyToSender = replyCtx.sender; userMsgDm.replyToText = replyCtx.text; }
      updateConvMsgs(sendKey, prev => [...prev, userMsgDm]);
      try {
        const result = await api.channels.sendMessage(dmChannel, {
          text, senderName: authUser?.name ?? t('page.fallbackYou'),
          senderId: authUser?.id,
          mentions: [], orgId: 'default',
          humanOnly: true, // never route to agents
        });
        updateConvMsgs(sendKey, prev => {
          const without = prev.filter(m => m.id !== optId);
          const newMsgs: ChatMsg[] = [];
          if (result.userMessage) newMsgs.push(channelMsgToChat(result.userMessage, authUser?.id));
          return newMsgs.length > 0 ? [...without, ...newMsgs] : prev;
        });
      } catch (e) {
        updateConvMsgs(sendKey, prev => [...prev, {
          id: `err_${Date.now()}`, sender: 'agent', text: t('page.errorWithMessage', { message: String(e) }),
          time: new Date().toLocaleTimeString(), agentName: t('page.systemName'), isError: true,
        }]);
      }
      sendingConvs.current.delete(sendKey);
      if (currentConvKeyRef.current === sendKey) setSending(false);
    } else if (chatMode === 'channel') {
      const optId = `opt_${Date.now()}`;
      const userMsgCh: ChatMsg = { id: optId, sender: 'user', text, time: new Date().toLocaleTimeString() };
      if (replyCtx) { userMsgCh.replyToId = replyCtx.id; userMsgCh.replyToSender = replyCtx.sender; userMsgCh.replyToText = replyCtx.text; }
      updateConvMsgs(sendKey, prev => [...prev, userMsgCh]);
      try {
        const mentions = parseMentions(text);
        const result = await api.channels.sendMessage(activeChannel, {
          text, senderName: authUser?.name ?? t('page.fallbackYou'), mentions,
          senderId: authUser?.id,
          orgId: 'default',
          replyToId: replyCtx?.id,
        });
        updateConvMsgs(sendKey, prev => {
          const without = prev.filter(m => m.id !== optId);
          const newMsgs: ChatMsg[] = [];
          if (result.userMessage) newMsgs.push(channelMsgToChat(result.userMessage, authUser?.id));
          if (result.agentMessage) newMsgs.push(channelMsgToChat(result.agentMessage, authUser?.id));
          return newMsgs.length > 0 ? [...without, ...newMsgs] : prev;
        });
      } catch (e) {
        const friendly = friendlyAgentError(e, t) || t('page.errorWithMessage', { message: String(e) });
        updateConvMsgs(sendKey, prev => [...prev, {
          id: `err_${Date.now()}`, sender: 'agent', text: friendly,
          time: new Date().toLocaleTimeString(), agentName: t('page.systemName'), isError: true,
        }]);
      }
      sendingConvs.current.delete(sendKey);
      if (currentConvKeyRef.current === sendKey) setSending(false);
    } else {
      // direct — build an interleaved segment stream
      const agentMsgId = `a_${Date.now()}`;
      if (options?.isResume) {
        // Resume: don't add a duplicate user message — just append the
        // agent continuation placeholder after the existing partial response.
        const agentCreatedAt = new Date().toISOString();
        updateConvMsgs(sendKey, prev => [
          ...prev,
          { id: agentMsgId, sender: 'agent', text: '', time: new Date().toLocaleTimeString(), rawCreatedAt: agentCreatedAt, segments: [] },
        ]);
      } else {
        const agentCreatedAt = new Date().toISOString();
        const userMsg: ChatMsg = { id: `u_${Date.now()}`, sender: 'user', text, time: new Date().toLocaleTimeString() };
        if (imagesToSend?.length) userMsg.images = imagesToSend;
        if (replyCtx) { userMsg.replyToId = replyCtx.id; userMsg.replyToSender = replyCtx.sender; userMsg.replyToText = replyCtx.text; }
        updateConvMsgs(sendKey, prev => [
          ...prev,
          userMsg,
          { id: agentMsgId, sender: 'agent', text: '', time: new Date().toLocaleTimeString(), rawCreatedAt: agentCreatedAt, segments: [] },
        ]);
      }

      /** Track whether we're inside a <think> block across streaming chunks */
      let insideThink = false;

      /** Append a text chunk to the segment stream */
      const appendTextChunk = (chunk: string) => {
        updateConvMsgs(sendKey, prev => {
          const u = [...prev];
          const idx = u.findIndex(m => m.id === agentMsgId);
          if (idx < 0) return prev;
          const segs = u[idx]!.segments ?? [];
          const last = segs[segs.length - 1];
          const prevThinking = last?.type === 'text' ? (last as { thinking?: string }).thinking ?? '' : '';

          let thinking = '';
          let content = '';
          let remaining = chunk;

          // Process the chunk character-by-character tracking think state.
          // Handles <think>...</think> that may span across multiple chunks.
          while (remaining.length > 0) {
            if (insideThink) {
              const closeIdx = remaining.indexOf('</think>');
              if (closeIdx >= 0) {
                thinking += remaining.slice(0, closeIdx);
                remaining = remaining.slice(closeIdx + '</think>'.length);
                insideThink = false;
              } else {
                thinking += remaining;
                remaining = '';
              }
            } else {
              const openIdx = remaining.indexOf('<think>');
              if (openIdx >= 0) {
                content += remaining.slice(0, openIdx);
                remaining = remaining.slice(openIdx + '<think>'.length);
                insideThink = true;
              } else {
                content += remaining;
                remaining = '';
              }
            }
          }

          const mergedThinking = (prevThinking + thinking) || undefined;

          const newSegs: MsgSegment[] = last?.type === 'text'
            ? [...segs.slice(0, -1), { type: 'text', content: last.content + content, thinking: mergedThinking, createdAt: last.createdAt }]
            : [...segs, { type: 'text', content, thinking: mergedThinking, createdAt: new Date().toISOString() }];
          u[idx] = { ...u[idx]!, text: u[idx]!.text + content, segments: newSegs };
          return u;
        });
      };

      /** Handle server-committed per-turn text/thinking entries (clean, non-fragmented) */
      const handleCommitEvent = (event: StreamCommitEvent) => {
        updateConvMsgs(sendKey, prev => {
          const u = [...prev];
          const idx = u.findIndex(m => m.id === agentMsgId);
          if (idx < 0) return prev;
          const committed = [...(u[idx]!.committedSegments ?? [])];
          if (event.type === 'thinking_commit') {
            committed.push({ type: 'text', content: '', thinking: event.content, createdAt: event.createdAt });
          } else {
            committed.push({ type: 'text', content: event.content, createdAt: event.createdAt });
          }
          u[idx] = { ...u[idx]!, committedSegments: committed };
          return u;
        });
      };

      /** Handle a tool event: start adds a 'running' segment, end updates it, output appends live text */
      const handleToolEvent = (event: AgentToolEvent) => {
        if (event.phase === 'start' || event.phase === 'end') {
          appendConvActivity(sendKey, { ...event, phase: event.phase, ts: Date.now() });
        }
        if (event.phase === 'start') {
          updateConvMsgs(sendKey, prev => {
            const u = [...prev];
            const idx = u.findIndex(m => m.id === agentMsgId);
            if (idx < 0) return prev;
            const segs = [...(u[idx]!.segments ?? [])];
            let updated = false;
            if (event.arguments) {
              for (let i = segs.length - 1; i >= 0; i--) {
                const s = segs[i]!;
                if (s.type === 'tool' && s.tool === event.tool && s.status === 'running') {
                  segs[i] = { ...s, args: event.arguments };
                  updated = true;
                  break;
                }
              }
            }
            const toolKey = `${event.tool}_${Date.now()}`;
            const now = new Date().toISOString();
            if (!updated) {
              segs.push({ type: 'tool', key: toolKey, tool: event.tool, status: 'running', args: event.arguments, createdAt: now });
            }
            // Only add to committedSegments from agent_tool start (has arguments,
            // arrives AFTER thinking_commit/text_commit) — NOT from tool_call_start
            // (no arguments, arrives before commits, would cause wrong ordering).
            const committed = [...(u[idx]!.committedSegments ?? [])];
            if (event.arguments !== undefined) {
              committed.push({ type: 'tool', key: toolKey, tool: event.tool, status: 'running', args: event.arguments, createdAt: now });
            }
            u[idx] = { ...u[idx]!, segments: segs, committedSegments: committed };
            return u;
          });
        } else if (event.phase === 'output') {
          updateConvMsgs(sendKey, prev => {
            const u = [...prev];
            const idx = u.findIndex(m => m.id === agentMsgId);
            if (idx < 0) return prev;
            const segs = [...(u[idx]!.segments ?? [])];
            for (let i = segs.length - 1; i >= 0; i--) {
              const s = segs[i]!;
              if (s.type === 'tool' && s.tool === event.tool && s.status === 'running') {
                segs[i] = { ...s, liveOutput: (s.liveOutput ?? '') + (event.output ?? '') };
                break;
              }
            }
            u[idx] = { ...u[idx]!, segments: segs };
            return u;
          });
        } else if (event.phase === 'subagent_progress' && event.subagentEvent) {
          updateConvMsgs(sendKey, prev => {
            const u = [...prev];
            const idx = u.findIndex(m => m.id === agentMsgId);
            if (idx < 0) return prev;
            const segs = [...(u[idx]!.segments ?? [])];
            for (let i = segs.length - 1; i >= 0; i--) {
              const s = segs[i]!;
              if (s.type === 'tool' && (s.tool === 'spawn_subagent' || s.tool === 'spawn_subagents') && s.status === 'running') {
                segs[i] = { ...s, subagentLogs: [...(s.subagentLogs ?? []), event.subagentEvent!] };
                break;
              }
            }
            u[idx] = { ...u[idx]!, segments: segs };
            return u;
          });
        } else {
          updateConvMsgs(sendKey, prev => {
            const u = [...prev];
            const idx = u.findIndex(m => m.id === agentMsgId);
            if (idx < 0) return prev;
            const now = new Date().toISOString();
            const segs = [...(u[idx]!.segments ?? [])];
            for (let i = segs.length - 1; i >= 0; i--) {
              const s = segs[i]!;
              if (s.type === 'tool' && s.tool === event.tool && s.status === 'running') {
                segs[i] = { ...s, status: event.success === false ? 'error' : 'done', args: event.arguments, result: event.result, error: event.error, durationMs: event.durationMs, liveOutput: undefined, createdAt: now };
                break;
              }
            }
            const committed = [...(u[idx]!.committedSegments ?? [])];
            for (let i = committed.length - 1; i >= 0; i--) {
              const s = committed[i]!;
              if (s.type === 'tool' && s.tool === event.tool && s.status === 'running') {
                committed[i] = { ...s, status: event.success === false ? 'error' : 'done', args: event.arguments, result: event.result, error: event.error, durationMs: event.durationMs, liveOutput: undefined, createdAt: now };
                break;
              }
            }
            u[idx] = { ...u[idx]!, segments: segs, committedSegments: committed };
            return u;
          });
        }
      };

      const abortCtrl = new AbortController();
      abortControllerRef.current = abortCtrl;

      try {
        const effectiveSessionId = activeSessionId === NEW_CHAT_PLACEHOLDER_ID ? null : activeSessionId;
        const streamResult = await api.agents.messageStream(
          selectedAgent, text,
          appendTextChunk,
          handleToolEvent,
          abortCtrl.signal,
          imagesToSend,
          effectiveSessionId,
          options?.isRetry,
          options?.isResume,
          handleCommitEvent,
          fileNamesToSend,
        );
        if (currentConvKeyRef.current === sendKey) {
          // Apply server's authoritative final segments and content so the
          // rendered state matches the DB-persisted data.  This prevents a
          // blank bubble when delta-built segments have empty content (e.g.
          // thinking-only responses before text_delta arrives).
          if (streamResult.segments?.length) {
            updateConvMsgs(sendKey, prev => {
              const u = [...prev];
              const idx = u.findIndex(m => m.id === agentMsgId);
              if (idx < 0) return prev;
              const finalSegs: MsgSegment[] = streamResult.segments!.map((s, i) =>
                s.type === 'tool'
                  ? { type: 'tool' as const, key: `${s.tool}_${i}`, tool: s.tool, status: s.status, args: s.arguments, result: s.result, error: s.error, durationMs: s.durationMs, createdAt: s.createdAt }
                  : { type: 'text' as const, content: s.content, thinking: s.thinking, createdAt: s.createdAt }
              );
              const finalText = streamResult.content || u[idx]!.text;
              u[idx] = { ...u[idx]!, text: finalText, segments: finalSegs, committedSegments: finalSegs };
              return u;
            });
          }

          if (streamResult.sessionId) {
            setActiveSessionId(streamResult.sessionId);
            setOpenSessionTabs(prev =>
              prev.map(t => t.id === NEW_CHAT_PLACEHOLDER_ID ? { ...t, id: streamResult.sessionId! } : t)
            );
          }
          loadSessions(selectedAgent).then(s => {
            if (currentConvKeyRef.current !== sendKey) return;
            setSessions(s);
            if (streamResult.sessionId) {
              const newSess = s.find(ss => ss.id === streamResult.sessionId);
              if (newSess) {
                setOpenSessionTabs(prev => {
                  const exists = prev.some(t => t.id === newSess.id);
                  if (exists) return prev.map(t => t.id === newSess.id ? newSess : t);
                  return [newSess, ...prev.filter(t => t.id !== NEW_CHAT_PLACEHOLDER_ID)];
                });
              }
            }
          });
        }
      } catch (e) {
        // Preserve sessionId from error so subsequent messages stay in the same session
        const errSessionId = (e as Error & { sessionId?: string })?.sessionId;
        if (errSessionId && chatMode === 'direct' && currentConvKeyRef.current === sendKey) {
          setActiveSessionId(errSessionId);
          setOpenSessionTabs(prev =>
            prev.map(t => t.id === NEW_CHAT_PLACEHOLDER_ID ? { ...t, id: errSessionId } : t)
          );
          loadSessions(selectedAgent!).then(s => {
            if (currentConvKeyRef.current !== sendKey) return;
            setSessions(s);
            const newSess = s.find(ss => ss.id === errSessionId);
            if (newSess) {
              setOpenSessionTabs(prev => {
                const exists = prev.some(t => t.id === newSess.id);
                if (exists) return prev.map(t => t.id === newSess.id ? newSess : t);
                return [newSess, ...prev];
              });
            }
          });
        }

        const errText = friendlyAgentError(e, t);
        if (errText) {
          updateConvMsgs(sendKey, prev => {
            const u = [...prev];
            const idx = u.findIndex(m => m.id === agentMsgId);
            if (idx >= 0) {
              const segs = u[idx]!.segments ?? [];
              u[idx] = { ...u[idx]!, text: errText, isError: true,
                segments: [...segs, { type: 'text', content: errText }] };
            }
            return u;
          });
        } else {
          // User cancelled — keep partial content and mark as stopped
          updateConvMsgs(sendKey, prev => {
            const u = [...prev];
            const idx = u.findIndex(m => m.id === agentMsgId);
            if (idx >= 0) {
              const msg = u[idx]!;
              const hasContent = msg.text
                || (msg.segments && msg.segments.length > 0 && msg.segments.some(s =>
                  (s.type === 'text' && (s as { content: string }).content) || s.type === 'tool'
                ));
              if (!hasContent) {
                return prev.filter(m => m.id !== agentMsgId);
              }
              u[idx] = { ...msg, isStopped: true };
            }
            return u;
          });
        }
      }

      // Mark any still-running tool segments as stopped (stream ended due to cancellation or disconnect)
      updateConvMsgs(sendKey, prev => {
        const u = [...prev];
        const idx = u.findIndex(m => m.id === agentMsgId);
        if (idx >= 0) {
          const segs = (u[idx]!.segments ?? []).map(s =>
            s.type === 'tool' && s.status === 'running' ? { ...s, status: 'stopped' as const } : s
          );
          u[idx] = { ...u[idx]!, segments: segs };
        }
        return u;
      });

      // If stream was aborted by user (api resolves rather than rejects on abort) —
      // keep partial content and mark as stopped. The catch block handles the rejection path.
      if (abortCtrl.signal.aborted) {
        updateConvMsgs(sendKey, prev => {
          const u = [...prev];
          const idx = u.findIndex(m => m.id === agentMsgId);
          if (idx >= 0) {
            const msg = u[idx]!;
            const hasContent = msg.text
              || (msg.segments && msg.segments.length > 0 && msg.segments.some(s =>
                (s.type === 'text' && (s as { content: string }).content) || s.type === 'tool'
              ));
            if (!hasContent) {
              return prev.filter(m => m.id !== agentMsgId);
            }
            u[idx] = { ...msg, isStopped: true };
          }
          return u;
        });
      }

      // Fallback: if the agent message is empty (SSE connection may have dropped),
      // poll the session messages to recover the persisted reply.
      // Use the actual session ID from the stream result (or activeSessionId) instead
      // of blindly fetching the "latest" session which could be a different conversation.
      const currentMsgs = msgBuffers.current.get(sendKey) ?? [];
      const agentMsg = currentMsgs.find(m => m.id === agentMsgId);
      const pollSessionId = activeSessionId && activeSessionId !== NEW_CHAT_PLACEHOLDER_ID ? activeSessionId : null;
      if (agentMsg && !agentMsg.text && chatMode === 'direct' && pollSessionId && !abortCtrl.signal.aborted) {
        const pollForReply = async (retries: number, delayMs: number) => {
          for (let i = 0; i < retries; i++) {
            await new Promise(r => setTimeout(r, delayMs));
            try {
              const result = await api.sessions.getMessages(pollSessionId, 2);
              const assistantMsg = result.messages.find(m => m.role === 'assistant');
              if (assistantMsg?.content) {
                const recovered = dbMsgToChat(assistantMsg);
                updateConvMsgs(sendKey, prev => {
                  const u = [...prev];
                  const idx = u.findIndex(m => m.id === agentMsgId);
                  if (idx >= 0) {
                    u[idx] = {
                      ...u[idx]!,
                      text: recovered.text,
                      segments: recovered.segments,
                    };
                  }
                  return u;
                });
                return;
              }
            } catch { /* retry */ }
          }
        };
        // Await polling so `sending` stays true (and the streaming animation
        // remains visible) while we recover the reply from the DB.
        await pollForReply(5, 3000);
      }
    }

    // Clear abort controller and sending state for this conv
    abortControllerRef.current = null;
    sendingConvs.current.delete(sendKey);
    actBuffers.current.delete(sendKey);
    if (currentConvKeyRef.current === sendKey) {
      setSending(false);
      setActivities([]);
    }
  };
  sendRef.current = send;

  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [, setExpandedMsgIds] = useState<Set<string>>(new Set());

  const lastAgentMsgId = useMemo(() => {
    for (let j = messages.length - 1; j >= 0; j--) {
      if (messages[j]?.sender === 'agent' && !messages[j]?.isActivityLog) return messages[j]!.id;
    }
    return null;
  }, [messages]);

  const handleCopy = useCallback((msg: ChatMsg) => {
    const text = msg.segments
      ? msg.segments.filter(s => s.type === 'text').map(s => (s as { content: string }).content).join('\n')
      : msg.text;
    void navigator.clipboard.writeText(text);
    setCopiedMsgId(msg.id);
    setTimeout(() => setCopiedMsgId(prev => prev === msg.id ? null : prev), 2000);
  }, []);

  const handleRetry = useCallback((retryMsg: ChatMsg) => {
    const convKey = currentConvKeyRef.current;
    const currentMsgs = msgBuffers.current.get(convKey) ?? messages;
    const retryIdx = currentMsgs.findIndex(m => m.id === retryMsg.id);
    if (retryIdx < 0) return;
    // Search backwards for the nearest user message
    let userMsg: ChatMsg | null = null;
    for (let i = retryIdx - 1; i >= 0; i--) {
      if (currentMsgs[i]?.sender === 'user') { userMsg = currentMsgs[i]!; break; }
    }
    const retryText = userMsg?.text ?? '';
    if (!retryText) return;

    const hasFollowingMsgs = retryIdx < currentMsgs.length - 1;
    if (hasFollowingMsgs) {
      const followCount = currentMsgs.length - 1 - retryIdx;
      if (!window.confirm(followCount === 1 ? t('page.retryConfirmSingular') : t('page.retryConfirmPlural', { count: followCount }))) return;
    }

    // Remove the agent bubble, all messages after it, and (if immediately preceding) the user message
    const removeUserToo = userMsg && retryIdx > 0 && currentMsgs[retryIdx - 1]?.id === userMsg.id;
    updateConvMsgs(convKey, prev => {
      const idx = prev.findIndex(m => m.id === (removeUserToo ? userMsg!.id : retryMsg.id));
      return idx >= 0 ? prev.slice(0, idx) : prev;
    });
    void send(retryText, { isRetry: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, updateConvMsgs, t]);

  const handleResume = useCallback((resumeMsg: ChatMsg) => {
    const convKey = currentConvKeyRef.current;
    const currentMsgs = msgBuffers.current.get(convKey) ?? messages;
    const resumeIdx = currentMsgs.findIndex(m => m.id === resumeMsg.id);
    if (resumeIdx < 0) return;

    // Trim the last incomplete segment from the agent bubble (stopped tools,
    // trailing empty text) but keep all completed content.
    updateConvMsgs(convKey, prev => {
      const u = [...prev];
      const idx = u.findIndex(m => m.id === resumeMsg.id);
      if (idx < 0) return prev;
      const msg = u[idx]!;
      const segs = [...(msg.segments ?? [])];
      while (segs.length > 0) {
        const last = segs[segs.length - 1]!;
        if (last.type === 'tool' && (last.status === 'stopped' || last.status === 'running')) {
          segs.pop();
        } else if (last.type === 'text' && !(last as { content: string }).content) {
          segs.pop();
        } else {
          break;
        }
      }
      u[idx] = { ...msg, segments: segs, isStopped: false, isError: false };
      return u;
    });

    // Send a hidden continuation prompt — the backend will keep the existing
    // session context and let the LLM pick up where it left off.
    void send('[Continue from where you left off. Do not repeat content already generated.]', { isResume: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, updateConvMsgs]);

  const handleReplyMsg = useCallback((msg: ChatMsg) => {
    const senderName = msg.sender === 'user' ? (authUser?.name ?? t('page.fallbackYou')) : (msg.agentName ?? t('page.fallbackAgent'));
    setChatReplyTo({ id: msg.id, sender: senderName, text: msg.text.slice(0, 120) });
    // Auto-insert @mention when replying to an agent in a group channel
    if (chatMode === 'channel' && msg.sender === 'agent' && msg.agentName) {
      const mention = `@${msg.agentName} `;
      setInput(prev => prev.startsWith(mention) ? prev : mention + prev);
    }
    textareaRef.current?.focus();
  }, [authUser?.name, chatMode, t]);

  const switchSession = async (s: ChatSessionInfo) => {
    setActiveSessionId(s.id);
    setShowSessions(false);
    setHasMore(false);
    oldestMsgId.current = null;
    const key = currentConvKeyRef.current;
    msgBuffers.current.delete(key);
    setMessages([]);
    // Add to open tabs if not already there
    setOpenSessionTabs(prev => prev.some(t => t.id === s.id) ? prev : [...prev, s]);
    await loadSessionMessages(s.id, key);
  };

  const closeSessionTab = (sessionId: string) => {
    setOpenSessionTabs(prev => prev.filter(t => t.id !== sessionId));
    if (activeSessionId === sessionId) {
      // Switch to another open tab, or new conversation
      const remaining = openSessionTabs.filter(t => t.id !== sessionId);
      if (remaining.length > 0) {
        void switchSession(remaining[remaining.length - 1]!);
      } else {
        newConversation();
      }
    }
  };

  const newConversation = () => {
    setActiveSessionId(NEW_CHAT_PLACEHOLDER_ID);
    const key = currentConvKeyRef.current;
    msgBuffers.current.delete(key);
    setMessages([]);
    setHasMore(false);
    oldestMsgId.current = null;
    setShowSessions(false);
    // Add a placeholder "New Chat" tab
    setOpenSessionTabs(prev => {
      const without = prev.filter(t => t.id !== NEW_CHAT_PLACEHOLDER_ID);
      return [{
        id: NEW_CHAT_PLACEHOLDER_ID,
        agentId: selectedAgent ?? '',
        userId: null,
        title: t('page.newChat'),
        createdAt: new Date().toISOString(),
        lastMessageAt: new Date().toISOString(),
      }, ...without];
    });
  };

  const handleInputChange = (val: string) => {
    setInput(val);
    if (chatMode !== 'channel') { setMentionDropdown(false); return; }

    const cursorPos = textareaRef.current?.selectionStart ?? val.length;
    const textBeforeCursor = val.slice(0, cursorPos);

    // Search backwards from cursor for the nearest unfinished @mention
    const atIdx = textBeforeCursor.lastIndexOf('@');
    if (atIdx >= 0) {
      const charBefore = atIdx === 0 ? '' : textBeforeCursor[atIdx - 1]!;
      const isValidPosition = atIdx === 0 || /[\s\n,，。！？!?;；:：、（）()\[\]【】]/.test(charBefore);
      if (isValidPosition) {
        const fragment = textBeforeCursor.slice(atIdx + 1);
        // Fragment between @ and cursor must be a contiguous token (no space/newline)
        if (!fragment.includes(' ') && !fragment.includes('\n')) {
          setMentionDropdown(true);
          setMentionFilter(fragment.toLowerCase());
          setMentionSelectedIndex(0);
          return;
        }
      }
    }
    setMentionDropdown(false);
  };

  const insertMention = (name: string) => {
    const cursorPos = textareaRef.current?.selectionStart ?? input.length;
    const before = input.slice(0, cursorPos);
    const atIdx = before.lastIndexOf('@');
    const after = input.slice(cursorPos);
    const mention = name.includes(' ') ? `@[${name}]` : `@${name}`;
    const newVal = input.slice(0, atIdx) + mention + ' ' + after;
    setInput(newVal);
    setMentionDropdown(false);
    setMentionSelectedIndex(0);
    // Restore cursor position after the inserted mention
    const newCursor = atIdx + mention.length + 1;
    requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(newCursor, newCursor);
    });
  };

  // ── File attachment handling ─────────────────────────────────────────────────
  const MAX_FILE_SIZE = 10 * 1024 * 1024;
  const MAX_FILES = 5;
  const SUPPORTED_DOC_TYPES = new Set([
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.ms-excel',
    'application/msword',
    'text/csv',
    'text/html',
    'application/json',
    'application/xml',
    'text/xml',
    'application/epub+zip',
  ]);

  const isFileSupported = useCallback((f: File) => {
    return f.type.startsWith('image/') || SUPPORTED_DOC_TYPES.has(f.type);
  }, []);

  const isImageFile = (f: { name: string; dataUrl: string }) => {
    return f.dataUrl.startsWith('data:image/');
  };

  const getFileIcon = (name: string, dataUrl: string) => {
    if (isImageFile({ name, dataUrl })) return null;
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    const iconMap: Record<string, string> = {
      pdf: '📄', docx: '📝', doc: '📝', xlsx: '📊', xls: '📊',
      pptx: '📎', csv: '📊', json: '🔧', xml: '🔧', html: '🌐', epub: '📚',
    };
    return iconMap[ext] ?? '📁';
  };

  const addFiles = useCallback((files: FileList | File[]) => {
    const fileArr = Array.from(files).filter(isFileSupported);
    if (fileArr.length === 0) return;
    for (const file of fileArr) {
      if (file.size > MAX_FILE_SIZE) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        setPendingImages(p => {
          if (p.length >= MAX_FILES) return p;
          if (p.some(img => img.dataUrl === dataUrl)) return p;
          return [...p, { id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, dataUrl, name: file.name }];
        });
      };
      reader.readAsDataURL(file);
    }
  }, [isFileSupported]);

  const removeImage = useCallback((id: string) => {
    setPendingImages(prev => prev.filter(img => img.id !== id));
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      const supported = Array.from(files).filter(isFileSupported);
      if (supported.length > 0) {
        e.preventDefault();
        addFiles(supported);
      }
    }
  }, [addFiles, isFileSupported]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      addFiles(Array.from(files).filter(isFileSupported));
    }
  }, [addFiles, isFileSupported]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  // ── Derived ───────────────────────────────────────────────────────────────────
  const currentAgent = agents.find(a => a.id === selectedAgent);
  const currentUserName = authUser?.name ?? t('page.fallbackYou');
  const lastMsg = messages[messages.length - 1];
  const isLastPending = sending && lastMsg?.sender === 'agent';
  const isLastVisualStreaming = streamingVisual && lastMsg?.sender === 'agent';
  const channelTeamMemberIds = useMemo(() => {
    if (chatMode !== 'channel') return null;
    if (activeChannel.startsWith('group:custom:')) {
      const gc = groupChats.find(g => g.channelKey === activeChannel);
      if (gc?.members) return new Set(gc.members.filter(m => m.type === 'agent').map(m => m.id));
      return null;
    }
    if (!activeTeamId) return null;
    const team = teams.find(t => t.id === activeTeamId);
    if (!team) return null;
    return new Set(team.members.filter(m => m.type === 'agent').map(m => m.id));
  }, [chatMode, activeChannel, activeTeamId, teams, groupChats]);
  const filteredAgents = agents
    .filter(a => channelTeamMemberIds ? channelTeamMemberIds.has(a.id) : true)
    .filter(a => a.name.toLowerCase().includes(mentionFilter));

  const activeDmUser = humans.find(h => h.id === activeDmUserId);
  const isSelfDm = activeDmUserId === authUser?.id || !activeDmUserId;

  const activeGroupChat = groupChats.find(gc => gc.channelKey === activeChannel);

  // Fetch custom group chat details (with member list) when selected
  useEffect(() => {
    if (!activeChannel.startsWith('group:custom:')) return;
    const gc = groupChats.find(g => g.channelKey === activeChannel);
    if (!gc || gc.members) return;
    api.groupChats.getById(gc.id).then(d => {
      if (d.chat.members) {
        setGroupChats(prev => prev.map(g => g.id === gc.id ? { ...g, members: d.chat.members } : g));
      }
    }).catch(() => {});
  }, [activeChannel, groupChats]);

  const modeTitle =
    chatMode === 'channel' ? (activeGroupChat?.name ?? activeChannel) :
    chatMode === 'direct'  ? (currentAgent?.name ?? t('page.selectAgent')) :
    chatMode === 'dm'      ? (isSelfDm ? t('chat.myNotes') : (activeDmUser?.name ?? t('page.directMessage'))) :
    t('page.chatTitle');

  const placeholder =
    chatMode === 'channel' ? (activeGroupChat ? t('page.placeholder.channel', { name: activeGroupChat.name }) : t('page.placeholder.channelWithMention', { name: activeChannel })) :
    chatMode === 'dm'      ? (isSelfDm ? t('page.placeholder.dmSelf') : t('page.placeholder.dmOther', { name: activeDmUser?.name ?? '' })) :
    selectedAgent ? t('page.placeholder.direct') : t('page.placeholder.noAgent');

  // ── Render ────────────────────────────────────────────────────────────────────
  const showChatOnMobile = isMobile && mobileShowChat;

  return (
    <div className="flex-1 overflow-hidden flex">
      {/* ── Left sidebar (ChatTeamSidebar) — always mounted to preserve scroll ── */}
      <ChatTeamSidebar
        authUser={authUser}
        agents={agents}
        teams={teams}
        humans={humans}
        tasks={tasks}
        externalAgents={externalAgents}
        groupChats={groupChats}
        chatMode={chatMode}
        selectedAgent={selectedAgent}
        activeChannel={activeChannel}
        activeDmUserId={activeDmUserId}
        onSelectAgent={(agentId) => { setChatMode('direct'); setSelectedAgent(agentId); setMainTab('chat'); setShowMemberPanel(false); if (isMobile) enterMobileDetail(); }}
        onSelectChannel={(channelKey) => { setChatMode('channel'); setActiveChannel(channelKey); setMainTab('chat'); setShowMemberPanel(false); if (isMobile) enterMobileDetail(); }}
        onSelectDm={(userId) => { setChatMode('dm'); setActiveDmUserId(userId); setMainTab('chat'); setShowMemberPanel(false); if (isMobile) enterMobileDetail(); }}
        onRefreshTeams={refreshTeams}
        onRefreshAgents={refreshAgents}
        onRefreshHumans={refreshHumans}
        onRefreshGroupChats={refreshGroupChats}
        onViewProfile={handleViewProfile}
        onManageGroupMembers={(channelKey) => { setChatMode('channel'); setActiveChannel(channelKey); setMainTab('chat'); setShowMemberPanel(true); if (isMobile) enterMobileDetail(); }}
        width={isMobile ? undefined : chatSidebar.width}
        onResizeStart={isMobile ? undefined : chatSidebar.onResizeStart}
        hidden={isMobile && mobileShowChat}
        initialLoading={initialLoading}
      />

      {/* ── Main area ── */}
      {(!isMobile || showChatOnMobile) && (
      <div className="flex-1 overflow-hidden flex flex-col min-w-0">
        {/* Header */}
        <div className="border-b border-border-default bg-surface-secondary shrink-0 relative">
          {isMobile ? (
            <>
              {/* Mobile Row 1: back + name + status */}
              <div className="flex items-center px-3 h-11 gap-2">
                <button
                  onClick={() => { window.location.hash = PAGE.TEAM; }}
                  className="text-fg-secondary hover:text-fg-primary transition-colors p-1 -ml-1 shrink-0"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
                </button>
                <span className="font-semibold text-sm truncate min-w-0 flex-1">{modeTitle}</span>
                {chatMode === 'direct' && currentAgent && (
                  <AgentStatusBadge agent={currentAgent} tasks={tasks} onViewProfile={handleViewProfile} />
                )}
              </div>
              {/* Mobile Row 2: tabs + actions */}
              <div className="flex items-center px-3 h-9 gap-1 border-t border-border-default/40">
                <button
                  onClick={() => { if (mainTab === 'profile') history.back(); else setMainTab('chat'); }}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                    mainTab === 'chat' ? 'bg-brand-500/15 text-brand-500' : 'text-fg-tertiary'
                  }`}
                >{t('page.chatTitle')}</button>
                <button
                  onClick={() => { if (mainTab !== 'profile') switchToProfile(); }}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                    mainTab === 'profile' ? 'bg-brand-500/15 text-brand-500' : 'text-fg-tertiary'
                  }`}
                >{chatMode === 'channel' ? t('page.teamTab') : t('page.profileTab')}</button>
                <div className="flex-1" />
                {chatMode === 'channel' && activeGroupChat?.type === 'custom' && (
                  <button
                    onClick={() => setShowMemberPanel(!showMemberPanel)}
                    className={`text-[11px] px-2 py-1 rounded-md font-medium shrink-0 flex items-center gap-1 ${
                      showMemberPanel ? 'bg-brand-500/15 text-brand-500' : 'text-fg-tertiary'
                    }`}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>
                    {activeGroupChat.members?.length ?? activeGroupChat.memberCount ?? 0}
                  </button>
                )}
                {chatMode === 'direct' && mainTab !== 'profile' && (
                  <>
                    <button
                      onClick={newConversation}
                      className="text-[11px] text-brand-500 px-2 py-1 rounded-md bg-brand-500/10 font-medium shrink-0"
                    >{t('page.newChatPlus')}</button>
                    <button
                      ref={historyBtnRef}
                      onClick={() => setShowSessions(!showSessions)}
                      className={`p-1 rounded-md transition-colors shrink-0 ${showSessions ? 'bg-surface-overlay text-fg-primary' : 'text-fg-tertiary'}`}
                      title={t('page.historyTitle')}
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    </button>
                  </>
                )}
              </div>
            </>
          ) : (
          /* Desktop: original single-row header */
          <div className="flex items-center px-6 h-14 gap-3">
            <span className="font-semibold text-sm truncate">{modeTitle}</span>
            {chatMode === 'direct' && currentAgent && (
              <AgentStatusBadge agent={currentAgent} tasks={tasks} onViewProfile={handleViewProfile} />
            )}
            {(chatMode === 'channel' || chatMode === 'dm') && (
              <span className="text-xs text-fg-tertiary">{t('page.messageCount', { count: messages.length })}</span>
            )}
            {chatMode === 'dm' && (
              <span className="text-xs text-fg-tertiary ml-1">
                {isSelfDm ? t('page.privateNotepad') : t('page.dmWith', { name: activeDmUser?.name ?? '' })}
              </span>
            )}

            {((chatMode === 'direct' && selectedAgent) || (chatMode === 'channel' && activeTeamId)) && (
              <div className="flex items-center gap-0.5 ml-4 -mb-px">
                <button
                  onClick={() => setMainTab('chat')}
                  className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
                    mainTab === 'chat'
                      ? 'border-brand-500 text-brand-500'
                      : 'border-transparent text-fg-tertiary hover:text-fg-secondary'
                  }`}
                >
                  {t('page.chatTitle')}
                </button>
                <button
                  onClick={() => setMainTab('profile')}
                  className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
                    mainTab === 'profile'
                      ? 'border-brand-500 text-brand-500'
                      : 'border-transparent text-fg-tertiary hover:text-fg-secondary'
                  }`}
                >
                  {chatMode === 'channel' ? t('page.teamTab') : t('page.profileTab')}
                </button>
              </div>
            )}

            {/* Right side buttons */}
            <div className="ml-auto flex items-center gap-2">
            {chatMode === 'channel' && activeGroupChat?.type === 'custom' && (
              <button
                onClick={() => setShowMemberPanel(!showMemberPanel)}
                className={`text-xs px-2.5 py-1 rounded-md border transition-colors flex items-center gap-1.5 ${
                  showMemberPanel
                    ? 'bg-brand-500/15 text-brand-500 border-brand-500/30'
                    : 'text-fg-secondary hover:text-fg-primary border-border-default hover:bg-surface-elevated'
                }`}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>
                {activeGroupChat.members?.length ?? activeGroupChat.memberCount ?? 0}
              </button>
            )}
            {chatMode === 'direct' && currentAgent && mainTab !== 'profile' && (
              <div className="flex items-center gap-1.5">
                <button
                  onClick={newConversation}
                  className="text-xs text-brand-500 hover:text-brand-500 px-2.5 py-1 rounded-md hover:bg-brand-500/10 border border-brand-500/20 transition-colors flex items-center gap-1"
                >
                  {t('page.newChatButton')}
                </button>
                <button
                  ref={historyBtnRef}
                  onClick={() => setShowSessions(!showSessions)}
                  className={`p-1.5 rounded-md transition-colors ${showSessions ? 'bg-surface-overlay text-fg-primary' : 'text-fg-tertiary hover:text-fg-secondary hover:bg-surface-elevated'}`}
                  title={t('page.historyTitle')}
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </button>
              </div>
            )}
            </div>
          </div>
          )}

          {/* Session tab bar (direct mode, chat tab) */}
          {chatMode === 'direct' && selectedAgent && mainTab === 'chat' && openSessionTabs.length > 0 && (
            <div className="flex items-center gap-0 px-3 overflow-x-auto scrollbar-hide border-t border-border-default/50">
              {openSessionTabs.map(s => (
                <div
                  key={s.id}
                  className={`group flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer border-b-2 transition-colors shrink-0 max-w-[180px] ${
                    s.id === activeSessionId
                      ? 'border-brand-500 text-brand-500 bg-brand-500/5'
                      : 'border-transparent text-fg-tertiary hover:text-fg-secondary hover:bg-surface-elevated/50'
                  }`}
                  onClick={() => {
                    if (s.id === NEW_CHAT_PLACEHOLDER_ID) {
                      setActiveSessionId(NEW_CHAT_PLACEHOLDER_ID);
                      const key = currentConvKeyRef.current;
                      msgBuffers.current.delete(key);
                      setMessages([]);
                    } else {
                      void switchSession(s);
                    }
                  }}
                >
                  {s.isMain && <span className="text-[10px] opacity-50 shrink-0">●</span>}
                  <span className="truncate">{s.id === NEW_CHAT_PLACEHOLDER_ID ? t('page.newChat') : (s.isMain ? t('page.sessionMain') : (s.title || t('page.sessionConversation')))}</span>
                  {!s.isMain && (
                    <button
                      onClick={(e) => { e.stopPropagation(); closeSessionTab(s.id); }}
                      className="opacity-0 group-hover:opacity-100 text-fg-tertiary hover:text-fg-secondary transition-opacity shrink-0"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Group chat member management panel */}
          {chatMode === 'channel' && activeGroupChat?.type === 'custom' && showMemberPanel && (() => {
            const gc = activeGroupChat;
            const currentMembers = gc.members ?? [];
            const allCandidates: Array<{ id: string; name: string; type: 'human' | 'agent'; subtitle: string }> = [];
            for (const a of agents) {
              if (!currentMembers.some(m => m.id === a.id)) {
                allCandidates.push({ id: a.id, name: a.name, type: 'agent', subtitle: a.role || 'Agent' });
              }
            }
            for (const h of humans) {
              if (!currentMembers.some(m => m.id === h.id)) {
                allCandidates.push({ id: h.id, name: h.name, type: 'human', subtitle: h.email || h.role || '' });
              }
            }
            return (
              <div className="border-b border-border-default bg-surface-secondary/80 px-4 py-3 flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-fg-secondary">{t('page.members')} ({currentMembers.length})</span>
                  <button onClick={() => setShowMemberPanel(false)} className="text-fg-tertiary hover:text-fg-secondary text-xs">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {currentMembers.map(m => (
                    <span key={m.id} className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] font-medium ${
                      m.type === 'agent' ? 'bg-brand-500/10 text-brand-500' : 'bg-green-500/10 text-green-600'
                    }`}>
                      <Avatar name={m.name} size={16} bgClass={m.type === 'agent' ? 'bg-brand-500/15 text-brand-500' : 'bg-green-500/15 text-green-600'} />
                      {m.name}
                      {m.id !== authUser?.id && (
                        <button
                          onClick={async () => {
                            try {
                              await api.groupChats.removeMember(gc.id, m.id);
                              setGroupChats(prev => prev.map(g => g.id === gc.id ? { ...g, members: (g.members ?? []).filter(x => x.id !== m.id), memberCount: (g.memberCount ?? 1) - 1 } : g));
                            } catch { /* ignore */ }
                          }}
                          className="ml-0.5 hover:text-red-500 transition-colors"
                          title={t('common:remove')}
                        >
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                        </button>
                      )}
                    </span>
                  ))}
                </div>
                {allCandidates.length > 0 && (
                  <div className="mt-1">
                    <select
                      className="w-full bg-surface-primary border border-border-default rounded-lg px-2.5 py-1.5 text-xs text-fg-primary outline-none focus:ring-1 focus:ring-brand-500/50"
                      value=""
                      onChange={async (e) => {
                        const id = e.target.value;
                        if (!id) return;
                        const c = allCandidates.find(x => x.id === id);
                        if (!c) return;
                        try {
                          await api.groupChats.addMember(gc.id, c.id, c.type, c.name);
                          setGroupChats(prev => prev.map(g => g.id === gc.id ? {
                            ...g,
                            members: [...(g.members ?? []), { id: c.id, name: c.name, type: c.type }],
                            memberCount: (g.memberCount ?? 0) + 1,
                          } : g));
                        } catch { /* ignore */ }
                      }}
                    >
                      <option value="">{t('page.addMemberPlaceholder')}</option>
                      {allCandidates.map(c => (
                        <option key={c.id} value={c.id}>[{c.type === 'agent' ? 'Agent' : 'Human'}] {c.name}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            );
          })()}

          {/* Floating history panel */}
          {chatMode === 'direct' && selectedAgent && showSessions && (
            <div
              ref={historyPanelRef}
              className="absolute right-4 top-full mt-1 w-72 max-h-[420px] bg-surface-secondary border border-border-default rounded-xl shadow-2xl shadow-black/40 z-50 flex flex-col overflow-hidden"
            >
              <div className="px-4 py-3 border-b border-border-default flex items-center justify-between">
                <span className="text-xs font-semibold text-fg-secondary uppercase tracking-wider">{t('page.historyTitle')}</span>
                <button onClick={() => setShowSessions(false)} className="text-fg-tertiary hover:text-fg-secondary text-xs">✕</button>
              </div>
              <div className="flex-1 overflow-y-auto p-2">
                {sessions.length === 0 && (
                  <div className="text-xs text-fg-tertiary text-center py-6">{t('page.noConversationsYet')}</div>
                )}
                {(() => {
                  const now = new Date();
                  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
                  const yesterdayStart = todayStart - 86400000;
                  const weekStart = todayStart - 7 * 86400000;
                  const groups: Array<{ label: string; items: ChatSessionInfo[] }> = [];
                  const today: ChatSessionInfo[] = [];
                  const yesterday: ChatSessionInfo[] = [];
                  const week: ChatSessionInfo[] = [];
                  const older: ChatSessionInfo[] = [];
                  for (const s of sessions) {
                    const t = new Date(s.lastMessageAt).getTime();
                    if (t >= todayStart) today.push(s);
                    else if (t >= yesterdayStart) yesterday.push(s);
                    else if (t >= weekStart) week.push(s);
                    else older.push(s);
                  }
                  if (today.length > 0) groups.push({ label: t('page.dateToday'), items: today });
                  if (yesterday.length > 0) groups.push({ label: t('page.dateYesterday'), items: yesterday });
                  if (week.length > 0) groups.push({ label: t('page.datePrevious7Days'), items: week });
                  if (older.length > 0) groups.push({ label: t('page.dateOlder'), items: older });
                  return groups.map(g => (
                    <div key={g.label} className="mb-2">
                      <div className="text-[10px] font-semibold text-fg-tertiary uppercase tracking-wider px-3 py-1.5">{g.label}</div>
                      {g.items.map(s => (
                        <button
                          key={s.id}
                          onClick={() => void switchSession(s)}
                          className={`w-full text-left px-3 py-2.5 rounded-lg text-xs mb-0.5 transition-colors ${
                            s.id === activeSessionId ? 'bg-brand-600/20 text-brand-500' : 'text-fg-secondary hover:bg-surface-elevated'
                          }`}
                        >
                          <div className="truncate font-medium flex items-center gap-1">
                            {s.isMain && <span className="text-[10px] text-brand-500 opacity-80">●</span>}
                            {s.isMain ? t('page.sessionMain') : (s.title || t('page.sessionConversation'))}
                          </div>
                          <div className="text-fg-tertiary text-[10px] mt-0.5">{new Date(s.lastMessageAt).toLocaleString()}</div>
                        </button>
                      ))}
                    </div>
                  ));
                })()}
              </div>
            </div>
          )}
        </div>

        {/* Profile Tab */}
        {mainTab === 'profile' && chatMode === 'direct' && selectedAgent && (
          <div className="flex-1 overflow-y-auto">
            <AgentProfile
              agentId={selectedAgent}
              onBack={() => setMainTab('chat')}
              inline
              defaultTab={profileDefaultTab}
              highlightMailboxId={profileHighlightMailboxId}
              onSwipeBack={() => { if (mainTabRef.current === 'profile') history.back(); else setMainTab('chat'); }}
              authUser={authUser}
            />
          </div>
        )}
        {mainTab === 'profile' && chatMode === 'channel' && activeTeamId && (
          <div className="flex-1 overflow-y-auto" onTouchStart={isMobile ? mainTabSwipe.onTouchStart : undefined} onTouchEnd={isMobile ? mainTabSwipe.onTouchEnd : undefined}>
            <TeamProfile
              teamId={activeTeamId}
              onBack={() => setMainTab('chat')}
              inline
            />
          </div>
        )}

        {/* Chat Tab: Messages */}
        <div className={`flex-1 overflow-hidden flex flex-col relative ${mainTab !== 'chat' ? 'hidden' : ''}`}>
          {loadingMore && (
            <div className="absolute top-0 left-0 right-0 z-10 flex justify-center items-center gap-2 py-2 bg-gradient-to-b from-surface-primary/90 to-transparent pointer-events-none">
              <svg className="animate-spin h-3.5 w-3.5 text-brand-400" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <span className="text-xs text-fg-tertiary">{t('page.loadingEarlierMessages')}</span>
            </div>
          )}
          <div ref={chatScrollRef} className={`flex-1 overflow-y-auto space-y-3 ${isMobile ? 'p-2.5' : 'p-5'}`} onScroll={handleChatScroll} onTouchStart={isMobile ? mainTabSwipe.onTouchStart : undefined} onTouchEnd={isMobile ? mainTabSwipe.onTouchEnd : undefined}>

          {messages.length === 0 && !sending && (
            <div className="flex flex-col items-center justify-center h-full text-fg-tertiary text-sm space-y-2">
              <div className="opacity-40">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  {chatMode === 'channel'
                    ? <><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H6l-4 4V6c0-1.1.9-2 2-2z" /><line x1="8" y1="10" x2="16" y2="10" /><line x1="8" y1="14" x2="13" y2="14" /></>
                    : <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  }
                </svg>
              </div>
              {chatMode === 'channel' && <div>{t('page.emptyChannel', { name: activeGroupChat?.name ?? activeChannel })}</div>}
              {chatMode === 'direct' && !selectedAgent && <div>{t('page.emptySelectAgent')}</div>}
              {chatMode === 'direct' && selectedAgent && <div>{t('page.emptyNewConversation', { name: currentAgent?.name ?? '' })}</div>}
            </div>
          )}

          {chatMode === 'channel'
            ? messages.map(msg => (
                <div key={msg.id} id={`msg-${msg.id}`} className="group/msg flex gap-3 transition-colors rounded-lg">
                  <div
                    className="shrink-0 cursor-pointer"
                    onClick={(e) => {
                      if (msg.sender === 'agent' && msg.agentId) {
                        const rect = e.currentTarget.getBoundingClientRect();
                        setAvatarPopover({ agentId: msg.agentId, top: rect.top, left: rect.right + 8 });
                      }
                    }}
                  >
                    <Avatar
                      name={msg.sender === 'user' ? currentUserName : (msg.agentName ?? t('page.fallbackAgent'))}
                      avatarUrl={msg.sender === 'user' ? authUser?.avatarUrl : agents.find(a => a.id === msg.agentId)?.avatarUrl}
                      size={32}
                      bgClass={msg.sender === 'user' ? 'bg-brand-600' : 'bg-brand-500/15 text-brand-600'}
                      className={msg.sender === 'agent' ? 'hover:ring-1 hover:ring-brand-500/40 rounded-lg' : 'rounded-lg'}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-medium text-fg-primary">
                        {msg.sender === 'user' ? currentUserName : msg.agentName ?? t('page.fallbackAgent')}
                      </span>
                      <span className="text-xs text-fg-tertiary">{msg.time}</span>
                    </div>
                    {msg.replyToId && msg.replyToSender && (
                      <button
                        onClick={() => {
                          const el = document.getElementById(`msg-${msg.replyToId}`);
                          if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('bg-brand-500/10'); setTimeout(() => el.classList.remove('bg-brand-500/10'), 1500); }
                        }}
                        className="flex items-center gap-1.5 mt-0.5 mb-1 pl-2 py-0.5 border-l-2 border-brand-500/40 text-xs text-fg-tertiary hover:text-fg-secondary transition-colors cursor-pointer"
                      >
                        <span className="font-medium text-brand-500">{msg.replyToSender}</span>
                        <span className="truncate max-w-[250px]">{msg.replyToText ?? '...'}</span>
                      </button>
                    )}
                    <div className={msg.isError || (msg.sender === 'agent' && msg.text.startsWith('⚠'))
                      ? 'mt-0.5 px-3 py-2 rounded-lg border-b-2 border-red-500/60'
                      : 'mt-0.5'
                    }>
                      {msg.sender === 'agent'
                        ? <MarkdownMessage content={msg.text} className="text-sm text-fg-secondary" />
                        : <div className="text-sm text-fg-secondary whitespace-pre-wrap">
                            {msg.images && msg.images.length > 0 && (
                              <div className="flex flex-wrap gap-1.5 mb-1">
                                {msg.images.map((src, idx) => (
                                  <img key={idx} src={src} alt="" className="max-w-[200px] max-h-[150px] rounded-lg object-cover cursor-pointer hover:opacity-80 transition-opacity" onClick={() => window.open(src, '_blank')} />
                                ))}
                              </div>
                            )}
                            {renderMentionText(msg.text, agents)}
                          </div>
                      }
                    </div>
                    <div className={`transition-opacity ${isMobile ? 'opacity-100' : 'opacity-0 group-hover/msg:opacity-100'}`}>
                      <MessageActions msg={msg} onCopy={handleCopy} onRetry={handleRetry} onResume={handleResume} onReply={handleReplyMsg} isCopied={copiedMsgId === msg.id} isLastAgentMsg={msg.id === lastAgentMsgId} />
                    </div>
                  </div>
                </div>
              ))
            : messages.map((msg, i) => {
                const isPending = isLastPending && i === messages.length - 1;
                const isStreamingMsg = isPending && sending;
                const showStreamingBubble = (isLastVisualStreaming && i === messages.length - 1) || isStreamingMsg;
                // Always show actions for stopped/error messages, otherwise only when not streaming
                const showActions = !isStreamingMsg || msg.isStopped;

                // Activity log entries are visible in the Agent Profile Mind tab;
                // hide them from the chat to reduce noise.
                if (msg.isActivityLog) return null;

                return (
                  <div key={msg.id} id={`msg-${msg.id}`} className={`group/msg flex transition-colors rounded-lg ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={[
                      isMobile ? 'max-w-[95%]' : 'max-w-[85%]',
                      msg.sender === 'agent' ? (isMobile ? 'min-w-[200px]' : 'min-w-[280px]') : '',
                    ].join(' ')}>
                      <div className="text-xs text-fg-tertiary mb-1">
                        {msg.sender === 'user'
                          ? currentUserName
                          : <ChatAgentLink
                              name={msg.agentName ?? (chatMode === 'direct' ? currentAgent?.name ?? t('page.fallbackAgent') : t('page.fallbackAgent'))}
                              agentId={msg.agentId ?? (chatMode === 'direct' ? currentAgent?.id : undefined)}
                              agents={agents}
                              onViewProfile={handleViewProfile}
                            />
                        } · {msg.time}
                      </div>
                      {msg.replyToId && msg.replyToSender && (
                        <button
                          onClick={() => {
                            const el = document.getElementById(`msg-${msg.replyToId}`);
                            if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('bg-brand-500/10'); setTimeout(() => el.classList.remove('bg-brand-500/10'), 1500); }
                          }}
                          className="flex items-center gap-1.5 mb-1 pl-2 py-0.5 border-l-2 border-brand-500/40 text-[10px] text-fg-tertiary hover:text-fg-secondary transition-colors cursor-pointer"
                        >
                          <span className="font-medium text-brand-500">{msg.replyToSender}</span>
                          <span className="truncate max-w-[200px]">{msg.replyToText ?? '...'}</span>
                        </button>
                      )}
                      <div className={`rounded-2xl text-sm ${isMobile ? 'px-3 py-2' : 'px-4 py-3'} ${
                        msg.sender === 'user'
                          ? 'bg-brand-600 text-white rounded-br-sm'
                          : msg.isError || (msg.sender === 'agent' && msg.text.startsWith('⚠'))
                            ? 'bg-surface-chat-bubble text-fg-primary rounded-bl-sm border-b-2 border-red-500/60'
                            : 'bg-surface-chat-bubble text-fg-primary rounded-bl-sm'
                      } ${showStreamingBubble && msg.sender === 'agent' ? 'streaming-bubble' : ''}`}>
                        {msg.sender === 'user'
                          ? <>
                              {msg.images && msg.images.length > 0 && (
                                <div className="flex flex-wrap gap-1.5 mb-2">
                                  {msg.images.map((src, idx) => (
                                    <img key={idx} src={src} alt="" className="max-w-[200px] max-h-[150px] rounded-lg object-cover cursor-pointer hover:opacity-80 transition-opacity" onClick={() => window.open(src, '_blank')} />
                                  ))}
                                </div>
                              )}
                              {msg.text && <span className="whitespace-pre-wrap leading-relaxed">{renderMentionText(msg.text, agents)}</span>}
                            </>
                          : <AgentMessageBody
                              msg={msg}
                              isStreaming={isStreamingMsg}
                              liveActivities={isStreamingMsg ? activities : []}
                              onViewModeChange={(mode) => setExpandedMsgIds(prev => {
                                const next = new Set(prev);
                                if (mode === 'full') next.add(msg.id); else next.delete(msg.id);
                                return next;
                              })}
                            />
                        }
                      </div>
                      {showActions && (
                        <div className={`transition-opacity ${msg.isStopped || isMobile ? 'opacity-100' : 'opacity-0 group-hover/msg:opacity-100'} ${msg.sender === 'user' ? 'flex justify-end' : ''}`}>
                          <MessageActions msg={msg} onCopy={handleCopy} onRetry={handleRetry} onResume={handleResume} onReply={handleReplyMsg} isCopied={copiedMsgId === msg.id} isLastAgentMsg={msg.id === lastAgentMsgId} />
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
          }
          {chatMode === 'channel' && sending && (
            <div className="text-xs text-fg-tertiary animate-pulse ml-11">{t('page.agentThinking')}</div>
          )}
          <div ref={messagesEnd} />
        </div>
        </div>

        {/* Avatar popover */}
        {avatarPopover && (() => {
          const popAgent = agents.find(a => a.id === avatarPopover.agentId);
          if (!popAgent) return null;
          return (
            <AvatarPopover
              agent={popAgent}
              anchorRect={{ top: avatarPopover.top, left: avatarPopover.left }}
              onClose={() => setAvatarPopover(null)}
              onViewProfile={handleViewProfile}
            />
          );
        })()}

        {/* Input (only in chat tab) */}
        <div className={`p-4 border-t border-border-default bg-surface-secondary relative shrink-0 ${mainTab !== 'chat' ? 'hidden' : ''}`} onDrop={handleDrop} onDragOver={handleDragOver}>
          {mentionDropdown && filteredAgents.length > 0 && (
            <div className="absolute bottom-full left-4 mb-1 bg-surface-elevated border border-border-default rounded-lg shadow-xl overflow-hidden z-10 max-h-48 overflow-y-auto">
              <div className="px-3 py-1.5 text-[10px] text-fg-tertiary font-medium uppercase tracking-wider border-b border-border-default">
                {t('page.mentionAgent')}
              </div>
              {filteredAgents.map((a, i) => (
                <button
                  key={a.id}
                  ref={el => { if (i === mentionSelectedIndex && el) el.scrollIntoView({ block: 'nearest' }); }}
                  onClick={() => insertMention(a.name)}
                  onMouseEnter={() => setMentionSelectedIndex(i)}
                  className={`w-full text-left px-4 py-2 text-sm flex items-center gap-2 transition-colors ${
                    i === mentionSelectedIndex ? 'bg-brand-500/15 text-brand-500' : 'text-fg-secondary hover:bg-surface-overlay'
                  }`}
                >
                  <Avatar name={a.name} avatarUrl={a.avatarUrl} size={24} bgClass="bg-brand-500/20 text-brand-500" />
                  <span className="flex-1 min-w-0">{a.name}</span>
                  <span className="text-xs text-fg-tertiary ml-auto">{a.role}</span>
                </button>
              ))}
            </div>
          )}
          {pendingImages.length > 0 && (
            <div className="flex items-center gap-2 mb-2 overflow-x-auto pb-1">
              {pendingImages.map(img => (
                <div key={img.id} className="relative group/img shrink-0">
                  {isImageFile(img) ? (
                    <img src={img.dataUrl} alt={img.name} className="w-16 h-16 rounded-lg object-cover border border-border-default" />
                  ) : (
                    <div className="w-16 h-16 rounded-lg border border-border-default bg-surface-elevated flex flex-col items-center justify-center gap-0.5" title={img.name}>
                      <span className="text-xl leading-none">{getFileIcon(img.name, img.dataUrl)}</span>
                      <span className="text-[9px] text-fg-tertiary truncate max-w-[56px] px-0.5">{img.name.split('.').pop()?.toUpperCase()}</span>
                    </div>
                  )}
                  <button
                    onClick={() => removeImage(img.id)}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-surface-secondary border border-gray-600 rounded-full flex items-center justify-center text-fg-secondary hover:text-red-500 hover:border-red-500 text-xs opacity-0 group-hover/img:opacity-100 transition-opacity"
                  >
                    ×
                  </button>
                </div>
              ))}
              {pendingImages.length < MAX_FILES && (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="w-16 h-16 rounded-lg border border-dashed border-gray-600 flex items-center justify-center text-fg-tertiary hover:text-fg-secondary hover:border-gray-400 transition-colors shrink-0"
                  title={t('page.addMoreFiles')}
                >
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>
                </button>
              )}
            </div>
          )}
          {pendingImages.length > 0 && pendingImages.some(f => isImageFile(f)) && currentAgent && currentAgent.modelSupportsVision === false && (
            <div className="text-[10px] text-amber-500/80 mb-1.5 flex items-center gap-1">
              <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 9v4m0 4h.01M12 2L2 22h20L12 2z" strokeLinecap="round" strokeLinejoin="round" /></svg>
              {t('page.visionWarning')}
            </div>
          )}
          <input ref={fileInputRef} type="file" accept="image/*,.pdf,.docx,.xlsx,.pptx,.xls,.doc,.csv,.json,.xml,.html,.epub" multiple className="hidden" onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
          {chatReplyTo && (
            <div className="flex items-center gap-2 mb-2 px-3 py-1.5 bg-surface-elevated rounded-lg border border-border-default/50">
              <div className="flex-1 min-w-0 pl-2 border-l-2 border-brand-500/50">
                <span className="text-[11px] font-medium text-brand-500">{chatReplyTo.sender}</span>
                <p className="text-[11px] text-fg-tertiary truncate">{chatReplyTo.text}</p>
              </div>
              <button onClick={() => setChatReplyTo(null)} className="text-fg-tertiary hover:text-fg-secondary shrink-0 p-0.5">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </div>
          )}
          <div className="flex gap-2 items-end">
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={chatMode === 'direct' && !selectedAgent}
              className="px-2.5 py-2.5 text-fg-tertiary hover:text-fg-secondary disabled:opacity-40 transition-colors rounded-xl hover:bg-surface-elevated"
              title={t('page.attachFilesTitle')}
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={e => {
                handleInputChange(e.target.value);
                e.target.style.height = 'auto';
                const h = Math.min(e.target.scrollHeight, 120);
                e.target.style.height = `${h}px`;
                e.target.style.overflowY = h >= 120 ? 'auto' : 'hidden';
              }}
              onKeyDown={e => {
                if (mentionDropdown && filteredAgents.length > 0) {
                  const isUp = e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p');
                  const isDown = e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n');
                  const isSelect = e.key === 'Enter' || e.key === 'Tab';
                  const isClose = e.key === 'Escape';
                  if (isUp) { e.preventDefault(); setMentionSelectedIndex(prev => (prev - 1 + filteredAgents.length) % filteredAgents.length); return; }
                  if (isDown) { e.preventDefault(); setMentionSelectedIndex(prev => (prev + 1) % filteredAgents.length); return; }
                  if (isSelect) { e.preventDefault(); const agent = filteredAgents[mentionSelectedIndex]; if (agent) insertMention(agent.name); return; }
                  if (isClose) { e.preventDefault(); setMentionDropdown(false); return; }
                }
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
              }}
              onPaste={handlePaste}
              placeholder={placeholder}
              disabled={chatMode === 'direct' && !selectedAgent}
              rows={1}
              className="flex-1 px-4 py-2.5 bg-surface-elevated border border-border-default rounded-xl text-sm focus:border-brand-500 outline-none disabled:opacity-40 transition-colors resize-none overflow-hidden leading-5"
              style={{ maxHeight: '120px' }}
            />
            {sending && chatMode !== 'dm' && (
              <button
                onClick={stopSending}
                className="px-3 py-2.5 bg-red-600 hover:bg-red-500 text-white text-sm rounded-xl transition-colors flex items-center gap-1.5"
                title={t('page.stopAgent')}
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                </svg>
              </button>
            )}
            <button
              onClick={() => void send()}
              disabled={(chatMode === 'direct' && !selectedAgent) || (!input.trim() && pendingImages.length === 0)}
              className="px-5 py-2.5 bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white text-sm rounded-xl transition-colors"
            >
              {t('send')}
            </button>
          </div>
        </div>
      </div>
      )}

    </div>
  );
}

function AgentStatusBadge({ agent, tasks, onViewProfile }: { agent: AgentInfo; tasks: TaskInfo[]; onViewProfile?: (agentId: string, opts?: { tab?: 'mind' }) => void }) {
  const { t } = useTranslation(['team', 'common']);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const isWorking = agent.status === 'working';
  const isError = agent.status === 'error';
  const currentTask = isWorking ? tasks.find(t => t.assignedAgentId === agent.id && t.status === 'in_progress') : null;
  const activity = agent.currentActivity;

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !popoverRef.current) return;
    const el = popoverRef.current;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    if (rect.right > vw - 8) {
      el.style.left = 'auto';
      el.style.right = '0';
    }
    if (rect.left < 8) {
      el.style.left = '0';
      el.style.right = 'auto';
    }
    const maxW = vw - 16;
    if (rect.width > maxW) {
      el.style.width = `${maxW}px`;
    }
  }, [open]);

  const dotColor = isError ? 'bg-red-400 animate-pulse' : isWorking ? 'bg-blue-400 animate-pulse' : 'bg-green-400';
  const label = isError ? t('common:status.error') : isWorking ? t('common:status.working') : t('common:status.idle');

  const activityLabel = activity
    ? activity.type === 'heartbeat' ? t('page.activityHeartbeat', { name: activity.heartbeatName ?? activity.label })
    : activity.type === 'chat' ? activity.label
    : activity.type === 'task' ? t('page.activityTask', { label: activity.label })
    : activity.label
    : t('page.processing');

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full transition-colors ${
          isWorking ? 'bg-blue-500/10 border border-blue-500/20 hover:bg-blue-500/20'
          : isError ? 'bg-red-500/10 border border-red-500/20 hover:bg-red-500/20'
          : 'bg-green-500/10 border border-green-500/20 hover:bg-green-500/20'
        }`}
      >
        <span className={`w-2 h-2 rounded-full ${dotColor}`} />
        <span className={`text-xs ${isError ? 'text-red-500' : isWorking ? 'text-blue-500' : 'text-green-600'}`}>{label}</span>
        {agent.mailboxDepth != null && agent.mailboxDepth > 0 && (
          <span className="text-[9px] bg-fg-tertiary/20 text-fg-tertiary rounded-full px-1.5">{agent.mailboxDepth}</span>
        )}
      </button>

      {open && isError && (
        <div ref={popoverRef} className="absolute top-full left-0 mt-1.5 bg-surface-secondary border border-red-500/30 rounded-xl shadow-2xl z-30 w-80 max-w-[calc(100vw-1rem)] p-3 space-y-2">
          <p className="text-[10px] text-red-500 uppercase font-semibold">{t('page.errorDetails')}</p>
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-2.5">
            <pre className="text-[10px] text-red-500/80 leading-relaxed whitespace-pre-wrap break-all font-mono line-clamp-6">
              {agent.lastError || t('page.agentErrorFallback')}
            </pre>
            {agent.lastErrorAt && <div className="text-[9px] text-red-500/50 mt-1.5 border-t border-red-500/10 pt-1">{new Date(agent.lastErrorAt).toLocaleString()}</div>}
          </div>
          <button
            onClick={() => { setOpen(false); onViewProfile?.(agent.id); }}
            className="w-full text-center text-[10px] text-red-500 hover:text-red-500 border border-red-500/30 hover:border-red-500/50 rounded-lg py-1 transition-colors"
          >
            {t('page.viewAgentProfileArrow')}
          </button>
        </div>
      )}

      {open && isWorking && (
        <div ref={popoverRef} className="absolute top-full left-0 mt-1.5 bg-surface-secondary border border-border-default rounded-xl shadow-2xl z-30 w-80 max-w-[calc(100vw-1rem)] p-3 space-y-2">
          <p className="text-[10px] text-fg-tertiary uppercase font-semibold">{t('page.currentActivity')}</p>
          {currentTask ? (
            <div
              className="flex items-center gap-2 p-2 rounded-lg bg-brand-500/10 border border-brand-500/30 cursor-pointer hover:bg-brand-500/10 transition-colors"
              onClick={() => { setOpen(false); navBus.navigate(PAGE.WORK, { openTask: currentTask.id }); }}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-brand-400 animate-pulse shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-xs text-brand-500 truncate">{currentTask.title}</div>
                <div className="text-[10px] text-fg-tertiary">{t('page.workingOnTaskHint')}</div>
              </div>
              <span className="text-[10px] text-fg-tertiary">→</span>
            </div>
          ) : (
            <div className="flex items-center gap-2 p-2 rounded-lg bg-surface-elevated/50">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                activity?.type === 'heartbeat' ? 'bg-blue-400 animate-pulse'
                : activity?.type === 'chat' ? 'bg-blue-400 animate-pulse'
                : 'bg-blue-400 animate-pulse'
              }`} />
              <div className="flex-1 min-w-0">
                <div className="text-xs text-fg-secondary">{activityLabel}</div>
                <div className="text-[10px] text-fg-tertiary">
                  {activity?.type === 'heartbeat' ? t('page.activityDescHeartbeat')
                   : activity?.type === 'chat' ? t('page.activityDescChat')
                   : t('page.activityDescFallback')}
                </div>
              </div>
            </div>
          )}
          <button
            onClick={() => { setOpen(false); onViewProfile?.(agent.id, { tab: 'mind' }); }}
            className="w-full text-center text-[10px] text-brand-500 hover:text-brand-500 border border-border-default hover:border-gray-600 rounded-lg py-1.5 transition-colors"
          >
            {t('page.viewMindArrow')}
          </button>
        </div>
      )}
    </div>
  );
}

