import type { ChatMessageInfo, ChannelMessageInfo, ChannelMsgMetadata, StoredSegment } from '../api.ts';
import type { ActivityStep } from '../components/ActivityIndicator.tsx';

// ─── Types ────────────────────────────────────────────────────────────────────

export type MsgSegment =
  | { type: 'text'; content: string; thinking?: string; createdAt?: string }
  | { type: 'tool'; key: string; tool: string; status: 'running' | 'done' | 'error' | 'stopped'; args?: unknown; result?: string; error?: string; durationMs?: number; liveOutput?: string; subagentLogs?: import('../api.ts').SubagentProgressEvent[]; createdAt?: string };

export interface ChatMsg {
  id: string;
  sender: 'user' | 'agent';
  text: string;
  committedSegments?: MsgSegment[];
  time: string;
  rawCreatedAt?: string;
  agentName?: string;
  agentId?: string;
  segments?: MsgSegment[];
  activities?: ActivityStep[];
  isError?: boolean;
  isStopped?: boolean;
  images?: string[];
  replyToId?: string;
  replyToSender?: string;
  replyToText?: string;
  isActivityLog?: boolean;
  activityType?: string;
  outcome?: string;
  mailboxItemId?: string;
  taskId?: string;
  requirementId?: string;
  isNotification?: boolean;
  notifyPriority?: string;
}

export type ChatMode = 'channel' | 'direct' | 'dm';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const NOTIFY_CONTEXT_RE = /\n*<!-- notify_context:.*?-->/g;

export function stripNotifyContext(text: string): { cleaned: string; priority?: string } {
  const match = text.match(/<!-- notify_context:([^>]*?)-->/);
  let priority: string | undefined;
  if (match) {
    const priMatch = match[1].match(/priority=(\w+)/);
    if (priMatch) priority = priMatch[1];
  }
  return { cleaned: text.replace(NOTIFY_CONTEXT_RE, '').trimEnd(), priority };
}

export function dbMsgToChat(m: ChatMessageInfo): ChatMsg {
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
  if (m.role === 'assistant' && (m.content === '[cancelled]' || m.content === '[Stream cancelled]')) {
    base.text = '';
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
  if (m.metadata?.notifyUser) {
    base.isNotification = true;
    base.notifyPriority = (m.metadata as Record<string, unknown>).priority as string | undefined;
    if (m.metadata.taskId) base.taskId = m.metadata.taskId;
    if (m.metadata.requirementId) base.requirementId = m.metadata.requirementId;
  }
  if (base.text.includes('<!-- notify_context:')) {
    const { cleaned, priority } = stripNotifyContext(base.text);
    base.text = cleaned;
    if (priority && !base.notifyPriority) base.notifyPriority = priority;
    base.isNotification = true;
  }
  if (m.metadata?.activityLog) {
    base.isActivityLog = true;
    base.activityType = m.metadata.activityType;
    base.outcome = m.metadata.outcome;
    base.mailboxItemId = m.metadata.mailboxItemId;
    base.taskId = m.metadata.taskId;
    base.requirementId = m.metadata.requirementId;
    if (!base.outcome && base.text.startsWith('[ACTIVITY:')) {
      const arrowIdx = base.text.lastIndexOf(' → ');
      if (arrowIdx !== -1) base.outcome = base.text.slice(arrowIdx + 3);
      base.text = base.text.replace(/^\[ACTIVITY:\s*\w+\]\s*/, '');
    }
  }
  return base;
}

export function channelMsgToChat(m: ChannelMessageInfo, authUserId?: string): ChatMsg {
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

export function formatSmartTime(isoOrLocale: string, rawCreatedAt?: string, labels?: { yesterday?: string }): string {
  const d = rawCreatedAt ? new Date(rawCreatedAt) : new Date();
  if (isNaN(d.getTime())) return isoOrLocale;
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const ts = d.getTime();
  const hhmm = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (ts >= todayStart) return hhmm;
  if (ts >= todayStart - 86400000) return `${labels?.yesterday ?? 'Yesterday'} ${hhmm}`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + hhmm;
}

export function getDateKey(rawCreatedAt?: string): string {
  if (!rawCreatedAt) return '';
  const d = new Date(rawCreatedAt);
  if (isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export function formatDateLabel(rawCreatedAt: string, labels?: { today?: string; yesterday?: string }): string {
  const d = new Date(rawCreatedAt);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const ts = d.getTime();
  if (ts >= todayStart) return labels?.today ?? 'Today';
  if (ts >= todayStart - 86400000) return labels?.yesterday ?? 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

export function throttle<T extends (...args: unknown[]) => unknown>(fn: T, ms: number): T {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return ((...args: unknown[]) => {
    const now = Date.now();
    const remaining = ms - (now - last);
    if (remaining <= 0) {
      if (timer) { clearTimeout(timer); timer = null; }
      last = now;
      return fn(...args);
    }
    if (!timer) {
      timer = setTimeout(() => {
        last = Date.now();
        timer = null;
        fn(...args);
      }, remaining);
    }
  }) as T;
}
