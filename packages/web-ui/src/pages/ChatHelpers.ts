import type { ChatMessageInfo, ChannelMessageInfo, ChannelMsgMetadata, StoredSegment, SubagentProgressEvent } from '../api.ts';
import type { ActivityStep } from '../components/ActivityIndicator.tsx';

// ─── Types ────────────────────────────────────────────────────────────────────

export type MsgSegment =
  | { type: 'text'; content: string; thinking?: string; createdAt?: string }
  | { type: 'tool'; key: string; tool: string; status: 'running' | 'done' | 'error' | 'stopped'; args?: unknown; result?: string; error?: string; durationMs?: number; liveOutput?: string; subagentLogs?: SubagentProgressEvent[]; createdAt?: string };

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
  /** True when the assistant turn finished with no content (survives refresh). */
  emptyReply?: boolean;
  /** True when the assistant turn is still generating (survives refresh via reattach). */
  isStreaming?: boolean;
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

/** Remember is only for user↔agent personal DM (`showRemember` from ChatPanel / chatMode=direct). */
export function isRememberActionVisible(showRemember: boolean | undefined, sender: ChatMsg['sender']): boolean {
  return !!showRemember && sender === 'agent';
}

export type ChatMode = 'channel' | 'direct' | 'dm';

// ─── Stream payload caps (keep React state + DOM from unbounded growth) ───────

/** Keep only the trailing window of shell/live tool stdout in UI state. */
export const MAX_LIVE_OUTPUT_CHARS = 24_000;
/** Cap nested sub-agent progress rows kept on a tool segment. */
export const MAX_SUBAGENT_LOGS = 200;

/** Append a live-output chunk, retaining only the newest window. */
export function appendLiveOutput(prev: string | undefined, chunk: string, max = MAX_LIVE_OUTPUT_CHARS): string {
  const next = (prev ?? '') + chunk;
  return next.length <= max ? next : next.slice(next.length - max);
}

/** Append a sub-agent log entry, retaining only the newest N rows. */
export function appendSubagentLog<T>(logs: T[] | undefined, entry: T, max = MAX_SUBAGENT_LOGS): T[] {
  const next = [...(logs ?? []), entry];
  return next.length <= max ? next : next.slice(next.length - max);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Insert a chat message by `rawCreatedAt` (bubble start time). Falls back to append
 * when timestamps are missing. Used for proactive/notify WS so late delivery still
 * lands before an in-flight reply that started later.
 */
// ─── Message finalization helpers ───────────────────────────────────────────
// Converge the repeated hand-written transforms (isStopped / isError / tool
// running→stopped) that previously appeared at ~12 sites in Team.tsx with
// subtly different variants. Single source of truth for "how a message looks
// when a stream ends".

/** True when a ChatMsg carries any visible content (text or segments). */
export function msgHasContent(msg: ChatMsg): boolean {
  return !!msg.text?.trim()
    || (msg.segments ?? []).some(s =>
      (s.type === 'text' && ((s as { content: string }).content || (s as { thinking?: string }).thinking)) || s.type === 'tool'
    );
}

/**
 * True when the TARGET conversation still has a live (non-stopped) streaming
 * bubble in its tail. This is the authoritative "agent is still generating"
 * check for the header badge — covers the reattach window where `sending`
 * has already ended but the resumed stream is still flushing deltas.
 * Scanning only the tail is safe: streaming bubbles are always recent.
 */
export function hasStreamingTail(msgs: ChatMsg[], lookback = 8): boolean {
  for (let i = msgs.length - 1; i >= Math.max(0, msgs.length - lookback); i--) {
    const m = msgs[i]!;
    if (m.isStreaming && !m.isStopped) return true;
  }
  return false;
}

/** Mark any still-running tool segments as stopped. Returns same ref when no change. */
export function stopRunningTools(segs: MsgSegment[] | undefined): MsgSegment[] | undefined {
  if (!segs || segs.length === 0) return segs;
  let changed = false;
  const next = segs.map(s =>
    s.type === 'tool' && s.status === 'running'
      ? (changed = true, { ...s, status: 'stopped' as const })
      : s,
  );
  return changed ? next : segs;
}

/** Terminal outcome of a stream for a single agent message. */
export type StreamOutcome = 'done' | 'stopped' | 'error';

/**
 * Finalize one agent message with a single outcome. Returns null when the
 * message has no visible content and the outcome is not 'done' — the caller
 * should drop the empty bubble (this is the "empty reply" rule).
 */
export function finalizeAgentMessage(msg: ChatMsg, outcome: StreamOutcome): ChatMsg | null {
  const hasContent = msgHasContent(msg);
  if (!hasContent && outcome !== 'done') return null;
  const base = { ...msg, isStreaming: false, segments: stopRunningTools(msg.segments) };
  switch (outcome) {
    case 'done':
      return { ...base, isStopped: false, isError: false };
    case 'stopped':
      return { ...base, isStopped: true, isError: false };
    case 'error':
      return { ...base, isStopped: true, isError: true };
  }
}

/**
 * Finalize the LAST in-flight agent message in an array (used when a turn is
 * interrupted by user send/stop). Mirrors the old copy-pasted loops: find the
 * last agent bubble that isn't already stopped/errored; if it has no content,
 * splice it out; otherwise mark it stopped (tools also stopped).
 */
export function finalizeLastInterruptedAgent(msgs: ChatMsg[]): ChatMsg[] {
  const u = [...msgs];
  for (let i = u.length - 1; i >= 0; i--) {
    if (u[i]!.sender === 'agent' && !u[i]!.isStopped && !u[i]!.isError) {
      const finalized = finalizeAgentMessage(u[i]!, 'stopped');
      if (finalized === null) {
        u.splice(i, 1);
      } else {
        u[i] = finalized;
      }
      break;
    }
  }
  return u;
}

/**
 * Terminal cleanup for the message of a finished direct stream (the single
 * convergence point every terminal path of send() passes through: done with or
 * without server segments, stream error, soft-disconnect without reattach, SSE
 * drop + poll recovery). Stops running tools and lands isStreaming: false.
 *
 * The optimistic placeholder is created with isStreaming: true and nothing in
 * the streaming pipeline resets it — if this step ever regresses, the bubble
 * renders as a perpetual "thinking…" (isStreamingMsg = ... || !!msg.isStreaming)
 * and the sidebar busy mark holds via hasStreamingTail. Returns the same array
 * ref when nothing changed so React can skip the re-render.
 */
export function finalizeStreamEnd(msgs: ChatMsg[], agentMsgId: string): ChatMsg[] {
  const idx = msgs.findIndex(m => m.id === agentMsgId);
  if (idx < 0) return msgs;
  const msg = msgs[idx]!;
  const segs = stopRunningTools(msg.segments);
  if (!msg.isStreaming && segs === msg.segments) return msgs;
  const u = [...msgs];
  u[idx] = { ...msg, isStreaming: false, segments: segs };
  return u;
}

/**
 * Finalize the last in-flight agent bubble (agent && isStreaming && !isStopped)
 * — used when a reattach stream dies/aborts while feeding an existing bubble.
 * Unlike finalizeLastInterruptedAgent this never touches a completed reply:
 * a message that is NOT streaming is not this stream's bubble. Empty bubbles
 * are spliced out (empty-reply rule).
 */
export function finalizeLastStreamingBubble(msgs: ChatMsg[], outcome: StreamOutcome = 'stopped'): ChatMsg[] {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.sender === 'agent' && m.isStreaming && !m.isStopped) {
      const finalized = finalizeAgentMessage(m, outcome);
      if (finalized === null) {
        return msgs.filter((_, j) => j !== i);
      }
      const u = [...msgs];
      u[i] = finalized;
      return u;
    }
  }
  return msgs;
}

export function insertChatMsgByCreatedAt(msgs: ChatMsg[], msg: ChatMsg): ChatMsg[] {
  if (msgs.some((m) => m.id === msg.id)) return msgs;
  const t = msg.rawCreatedAt ? Date.parse(msg.rawCreatedAt) : NaN;
  if (!Number.isFinite(t) || msgs.length === 0) return [...msgs, msg];
  let i = msgs.length;
  while (i > 0) {
    const prev = msgs[i - 1]!;
    const pt = prev.rawCreatedAt ? Date.parse(prev.rawCreatedAt) : NaN;
    // Missing timestamps stay at the end (append-like); only shift past newer known times.
    if (!Number.isFinite(pt) || pt <= t) break;
    i--;
  }
  if (i === msgs.length) return [...msgs, msg];
  const next = msgs.slice();
  next.splice(i, 0, msg);
  return next;
}

/** Matches `<!-- notify_context: ... -->` including optional surrounding newlines. */
const NOTIFY_CONTEXT_RE = /\n*<!--\s*notify_context:\s*([\s\S]*?)-->/g;

export function stripNotifyContext(text: string): { cleaned: string; priority?: string } {
  if (!text.includes('notify_context')) {
    return { cleaned: text };
  }
  let priority: string | undefined;
  const match = text.match(/<!--\s*notify_context:\s*([\s\S]*?)-->/);
  if (match?.[1]) {
    const priMatch = match[1].match(/priority\s*=\s*(\w+)/i);
    if (priMatch) priority = priMatch[1];
  }
  return { cleaned: text.replace(NOTIFY_CONTEXT_RE, '').trimEnd(), priority };
}

/**
 * Remove complete <thinking>…</thinking> blocks from display/persist text.
 *
 * CRITICAL: the matcher REQUIRES a closing tag. Earlier defensive regexes used
 * `(<\/think>|$)` as the terminator — whenever plain prose contained the word
 * " thinking" (extremely common in English replies) WITHOUT a closing tag, the
 * regex deleted everything from that word to the END of the string. The result
 * looked exactly like "the final reply text is truncated / incomplete".
 *
 * With a closing tag required, bare " thinking" in normal text is left intact,
 * and only true (legacy/raw) thinking blocks are stripped.
 */
const THINK_BLOCK_RE = /(?:<thinking>| thinking)[\s\S]*?<\/thinking>/g;
const THINK_BLOCK_RE_LEGACY = /(?:<thinking>| thinking| thinking| think)[\s\S]*?<\/think>/g;

export function stripThinkingBlocks(text: string): string {
  return text.replace(THINK_BLOCK_RE, '').replace(THINK_BLOCK_RE_LEGACY, '');
}

/** Map a persisted/SSE segment into chat UI shape, keeping nested sub-agent logs. */
export function storedSegmentToMsgSegment(
  s: StoredSegment,
  index: number,
  live?: MsgSegment,
): MsgSegment {
  if (s.type !== 'tool') {
    const { cleaned } = stripNotifyContext(s.content ?? '');
    return { type: 'text' as const, content: cleaned, thinking: s.thinking, createdAt: s.createdAt };
  }
  const liveTool = live?.type === 'tool' && live.tool === s.tool ? live : undefined;
  const serverLen = s.subagentLogs?.length ?? 0;
  const liveLen = liveTool?.subagentLogs?.length ?? 0;
  const logs = serverLen >= liveLen ? s.subagentLogs : liveTool?.subagentLogs;
  return {
    type: 'tool' as const,
    key: `${s.tool}_${index}`,
    tool: s.tool,
    status: s.status,
    args: s.arguments,
    result: s.result,
    error: s.error,
    durationMs: s.durationMs,
    createdAt: s.createdAt,
    ...(logs?.length ? { subagentLogs: logs } : {}),
  };
}

export function storedSegmentsToMsgSegments(
  segments: StoredSegment[],
  liveSegments?: MsgSegment[],
): MsgSegment[] {
  const liveTools = (liveSegments ?? []).filter((s): s is Extract<MsgSegment, { type: 'tool' }> => s.type === 'tool');
  let liveToolIdx = 0;
  return segments.map((s, i) => {
    const live = s.type === 'tool' ? liveTools[liveToolIdx++] : undefined;
    return storedSegmentToMsgSegment(s, i, live);
  });
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
    base.segments = storedSegmentsToMsgSegments(m.metadata.segments);
  }
  if (m.role === 'assistant' && (m.content === '[cancelled]' || m.content === '[Stream cancelled]')) {
    base.text = '';
  }
  if (m.metadata?.isError || (m.role === 'assistant' && m.content.startsWith('⚠'))) {
    base.isError = true;
  }
  if (m.metadata?.emptyReply || (m.role === 'assistant' && !m.content && !m.metadata?.segments?.length && (m.metadata?.isError || m.metadata?.isStopped))) {
    base.emptyReply = true;
    // Surface as error so Retry is always visible (not hover-only).
    if (!base.isStopped) base.isError = true;
  }
  if (m.metadata?.isStreaming) {
    base.isStreaming = true;
  }
  // Soft-disconnect snapshots used to set isStopped; prefer isStreaming when both present.
  if (m.metadata?.isStopped && !m.metadata?.isStreaming) {
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
  if (m.metadata?.replyToId) {
    base.replyToId = m.metadata.replyToId as string;
    base.replyToSender = m.metadata.replyToSender as string;
    base.replyToText = m.metadata.replyToText as string;
    // Heal legacy rows that embedded the quote into content before reply metadata existed.
    base.text = stripEmbeddedReplyQuote(base.text, base.replyToSender, base.replyToText);
  }
  return base;
}

/** Remove legacy `> **sender**: …\n\n` prefix when reply metadata already carries the quote. */
export function stripEmbeddedReplyQuote(
  content: string,
  replyToSender?: string,
  replyToText?: string,
): string {
  if (!content || !replyToSender || !replyToText) return content;
  const prefix = `> **${replyToSender}**: ${replyToText}\n\n`;
  if (content.startsWith(prefix)) return content.slice(prefix.length);
  return content;
}

/**
 * Pick the agent bubble a stream-reattach should (re)attach into.
 *
 * MUST only ever return the in-flight bubble:
 *   - a message still marked `isStreaming`, or
 *   - an empty placeholder (no text / no content segments) that is still mid-turn.
 *
 * It MUST NEVER return a *completed* agent reply. Reusing a previous turn's
 * finished reply caused a real regression: after a user clicked "stop" on a
 * new turn that had no content yet (empty bubble removed), the reattach logic
 * fell back to the LAST agent message in the list — which was the *previous*
 * turn's reply — streamed the new reply into that bubble, and pushed the user's
 * own question below it (history became [A, D-streaming, C]).
 */
export function pickStreamReattachTarget(msgs: ChatMsg[]): ChatMsg | undefined {
  // Scan from the tail: only the most recent agent message can be in-flight.
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.sender !== 'agent') continue;
    if (m.isStreaming) return m; // live streaming bubble
    const hasContent = m.text?.trim()
      || (m.segments ?? []).some(s =>
        (s.type === 'text' && (((s as { content?: string }).content ?? '').trim() || (s as { thinking?: string }).thinking))
        || s.type === 'tool',
      );
    if (!hasContent) return m; // empty in-flight placeholder
    // It has committed content but is not streaming → a finished reply.
    // Never reuse it as a reattach target.
    return undefined;
  }
  return undefined;
}

/**
 * Collapse accidental adjacent duplicate user bubbles (same text, within a short window).
 * Does not touch intentional repeats that have an assistant turn between them.
 */
export function dedupeAdjacentUserMessages(msgs: ChatMsg[], windowMs = 120_000): ChatMsg[] {
  if (msgs.length < 2) return msgs;
  const out: ChatMsg[] = [];
  for (const m of msgs) {
    const prev = out[out.length - 1];
    if (
      m.sender === 'user'
      && prev?.sender === 'user'
      && prev.text === m.text
      && prev.text.length > 0
      && prev.text.length <= 500
    ) {
      const prevTs = prev.rawCreatedAt ? Date.parse(prev.rawCreatedAt) : NaN;
      const curTs = m.rawCreatedAt ? Date.parse(m.rawCreatedAt) : NaN;
      if (!Number.isFinite(prevTs) || !Number.isFinite(curTs) || Math.abs(curTs - prevTs) <= windowMs) {
        continue;
      }
    }
    out.push(m);
  }
  return out;
}

export function channelMsgToChat(m: ChannelMessageInfo, authUserId?: string): ChatMsg {
  const isError = m.senderType === 'system' || (m.senderType === 'agent' && m.text.startsWith('⚠'));
  const isSelf = m.senderType === 'human' && (!authUserId || m.senderId === authUserId);
  let text = m.text;
  if (isSelf && m.replyToId && m.replyToSender && m.replyToText) {
    text = stripEmbeddedReplyQuote(text, m.replyToSender, m.replyToText);
  }
  const base: ChatMsg = {
    id: m.id,
    sender: isSelf ? 'user' : 'agent',
    text,
    time: new Date(m.createdAt).toLocaleTimeString(),
    rawCreatedAt: m.createdAt,
    agentName: isSelf ? undefined : m.senderName,
    agentId: isSelf ? undefined : m.senderId,
    isError,
    replyToId: m.replyToId,
    replyToSender: m.replyToSender,
    replyToText: m.replyToText,
  };
  const meta = m.metadata as ChannelMsgMetadata | null | undefined;
  if (meta?.images?.length) {
    base.images = meta.images;
  }
  if (meta && m.senderType === 'agent') {
    const segments: MsgSegment[] = [];
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
