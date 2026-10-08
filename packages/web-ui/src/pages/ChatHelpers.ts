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
  /**
   * True while the SSE transport dropped mid-turn and we are re-attaching.
   * The turn is STILL running server-side — the bubble must keep its live
   * "working" feedback (never look finished) until a terminal event arrives.
   * See the attach supervisor in useChatStream (2026-10-01 half-rendered-reply fix).
   */
  reconnecting?: boolean;
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
 *
 * `agentMsgId` is OPTIONAL and id lookup is only the fast path, because the id
 * the caller passed in can stop existing before this runs: the done handler
 * RENAMES the optimistic bubble to the server-persisted `messageId` (see the
 * identity-alignment block in useChatStream). A pure id lookup then misses,
 * returns the array untouched, and the bubble keeps isStreaming: true forever —
 * which is exactly the reported "border stays lit after the reply finished, and
 * the chat header keeps saying 工作中 while the L1 sidebar says 空闲". The id was
 * never the identity of the stream; the terminal signal must land regardless.
 */
export function finalizeStreamEnd(msgs: ChatMsg[], agentMsgId?: string): ChatMsg[] {
  if (agentMsgId) {
    const idx = msgs.findIndex(m => m.id === agentMsgId);
    if (idx >= 0) {
      const msg = msgs[idx]!;
      const segs = stopRunningTools(msg.segments);
      if (!msg.isStreaming && segs === msg.segments) return msgs;
      const u = [...msgs];
      u[idx] = { ...msg, isStreaming: false, segments: segs };
      return u;
    }
  }
  // Id gone (renamed to the server messageId, or replaced by the DB heal) — the
  // stream is still over, so every in-flight agent bubble must land.
  return clearGhostStreaming(msgs);
}

/**
 * Clear the display-level stream flag on every in-flight agent bubble, keeping
 * their content (the empty-reply rule belongs to callers that own the outcome,
 * i.e. finalizeAgentMessage).
 *
 * ONLY a fallback for callers that have ALREADY established that the turn is
 * over from the server authority (see `finalizeStreamEnd`, which is reached only
 * after `decideOnStreamEnd` returned 'finalize'). Never call it speculatively:
 * in-flight-ness is not knowable from client-local signals, and buying the flag
 * early costs the animated border while the backend keeps generating
 * (2026-10-08 incident — reading the client's own bookkeeping as authority).
 *
 * Landing a bubble means more than dropping the flag: one whose last tool
 * segment is still `running` keeps ITS OWN activity affordance alive (the
 * execution card spinner), so the "still working" signal would survive the fix
 * on a second surface. When the stream is over nothing can still be running, so
 * the leftover segment status is landed together with the flag.
 *
 * Returns the same array ref when nothing changed so React can skip re-render.
 */
export function clearGhostStreaming(msgs: ChatMsg[]): ChatMsg[] {
  if (!hasStreamingTail(msgs)) return msgs;
  return msgs.map(m => {
    if (m.sender !== 'agent' || !m.isStreaming || m.isStopped) return m;
    return { ...m, isStreaming: false, segments: stopRunningTools(m.segments) };
  });
}

/**
 * Converge a locally-streamed agent bubble's SYNTHETIC id to the server-persisted
 * `messageId`, so any later DB load can deduplicate it BY ID (the cache merge
 * keys on identity equality).
 *
 * A streamed turn has TWO identities until this runs: the client mints an
 * optimistic id (`a_…` / `reattach_…`) at send time while the DB row uses the
 * persisted messageId. If the two never converge, the next DB load keeps BOTH —
 * the local synthetic row and the authoritative DB row — and the reply renders
 * twice. This is the ONE place that bridging happens; every terminal path
 * (done, reattach terminal, poll recovery) routes through it.
 *
 * If the DB version is already present under the persisted id, the local copy is
 * DROPPED instead of renamed (renaming would produce two rows sharing one id).
 * Returns the same array ref when nothing changed, so React can skip a re-render.
 */
export function alignStreamedAgentId(
  msgs: ChatMsg[],
  syntheticId: string | undefined,
  persistedId: string | undefined,
): ChatMsg[] {
  if (!syntheticId || !persistedId || syntheticId === persistedId) return msgs;
  if (msgs.some(m => m.id === persistedId)) return msgs.filter(m => m.id !== syntheticId);
  return msgs.map(m => (m.id === syntheticId ? { ...m, id: persistedId } : m));
}

// `shouldSweepGhostStreaming` 已删除（2026-10-08）。
//
// 它用**客户端本地的派生副本**（sending / streamingVisual / chatStore 所有权集合 /
// buffer phase）回答「这轮结束了没有」，而这些副本恰好在**传输断开**时全部变成"没流"
// —— 服务端此时仍在生成。于是它把活着的回合当幽灵就地正法（不可逆地抹掉
// isStreaming、动态边框与 running 工具段），且挂在 `[messages]` 上每次 delta 都跑，
// 边框永远亮不回来。它有 9 条测试且当时全绿 —— 那些用例固化的是**错误的**不变量。
// 终止判据已收敛为单一权威：`lib/streamLiveness.ts#decideOnStreamEnd`（其回归护栏在
// `src/lib/streamLiveness.test.ts`）。详见 docs/records/team-chat-stream-transport-vs-turn-2026-10-08.md。

/**
 * 发送消息时是否应当"打断并重发"。
 *
 * 判据必须是「**我这次要发的那个会话**是否真有流在跑」，而不是
 * 「当前 tab 有没有真实 session id」/「这个 agent 有没有在 sending」。
 *
 * 旧实现用的是后者（`isSameSession = activeSessionId && activeSessionId !== NEW_CHAT`），
 * 而 `sending` 与 convKey 都是 **Agent 级**的——同一个 agent 的所有 session tab
 * 共用它们。于是「在 tab B 发消息」会被判成「打断当前流」，把**正在输出的 tab A**
 * 连同它的 SSE 一起 abort 掉（见 `cancelProcessing` 的定向取消）。
 *
 * 正确语义：只有你要发的那个会话自身有在途流时，才谈得上"打断它"；
 * 否则交给后端 mailbox 排队/合并，一个字节都不要动别人的流。
 */
export function shouldInterruptForSend(input: {
  /** convKey 维度当前登记的在途会话（含 NEW_CHAT 占位）。 */
  liveSessions: ReadonlySet<string> | undefined | null;
  /** 本次发送所属的会话（新 tab 时为 NEW_CHAT 占位 id）。 */
  sendSessionId: string | undefined | null;
}): boolean {
  if (!input.sendSessionId) return false;
  const live = input.liveSessions;
  if (!live || live.size === 0) return false;
  return live.has(input.sendSessionId);
}

/**
 * 断线重连（reattach）判定"这条流确实已经脱离"时，是否应当就地收尾。
 *
 * 判据必须是「**这个会话**是否还有在途流」，而不是「该 Agent 下**任意**会话是否有流」。
 * 旧实现用后者（`owned.size > 0` → return），于是当其它 tab 正在输出时，
 * 针对本 tab 的收尾会被跳过；反过来一旦别的 tab 的流结束把 Agent 级标记清掉，
 * 本 tab 的收尾又会误触发。两者都是"用别人的状态回答我的问题"。
 */
export function shouldSettleDetachedSession(input: {
  liveSessions: ReadonlySet<string> | undefined | null;
  /** 本次 reattach 的目标会话。 */
  sessionId: string | undefined | null;
  /** 未解析的新流占位 id（可能尚未提升为真实 id）。 */
  placeholderId: string;
}): boolean {
  const live = input.liveSessions;
  if (!live || live.size === 0) return true;
  if (!input.sessionId) return true;
  return !live.has(input.sessionId) && !live.has(input.placeholderId);
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

/**
 * Append a reasoning chunk to the in-flight segment stream.
 *
 * Reasoning lives in the segment's `thinking` field — never as inline markup in
 * `content` — so provider interleaving of reasoning and answer prose cannot make
 * either one leak into the other's display path.
 */
export function appendThinkingToSegments(segments: MsgSegment[], thinking: string): MsgSegment[] {
  if (!thinking) return segments;
  const last = segments[segments.length - 1];
  if (last?.type === 'text') {
    return [...segments.slice(0, -1), { ...last, thinking: (last.thinking ?? '') + thinking }];
  }
  return [...segments, { type: 'text', content: '', thinking, createdAt: new Date().toISOString() }];
}

/** Append answer prose to the in-flight segment stream (merges into the trailing text segment). */
export function appendTextToSegments(segments: MsgSegment[], content: string): MsgSegment[] {
  if (!content) return segments;
  const last = segments[segments.length - 1];
  if (last?.type === 'text') {
    return [...segments.slice(0, -1), { ...last, content: last.content + content }];
  }
  return [...segments, { type: 'text', content, createdAt: new Date().toISOString() }];
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

/**
 * `Date#toLocaleTimeString` is an ICU round-trip and one of the most expensive calls in V8.
 * The chat list formats a timestamp for EVERY message on EVERY render — a production CPU
 * profile showed it as the single hottest JS function (6–15% self time, plus the GC churn
 * from its throwaway temporaries). The same instant always formats to the same string, so
 * memoize it. Bounded so a long session cannot grow without limit.
 */
const _localeTimeCache = new Map<string, string>();
const LOCALE_TIME_CACHE_MAX = 2000;
export function cachedLocaleTime(iso?: string): string {
  if (!iso) return '';
  const hit = _localeTimeCache.get(iso);
  if (hit !== undefined) return hit;
  const d = new Date(iso);
  const out = isNaN(d.getTime()) ? '' : d.toLocaleTimeString();
  if (_localeTimeCache.size >= LOCALE_TIME_CACHE_MAX) _localeTimeCache.clear();
  _localeTimeCache.set(iso, out);
  return out;
}

export function dbMsgToChat(m: ChatMessageInfo): ChatMsg {
  const base: ChatMsg = {
    id: m.id,
    sender: m.role === 'user' ? 'user' : 'agent',
    text: m.content,
    time: cachedLocaleTime(m.createdAt),
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

export interface ReattachTargetOptions {
  /**
   * Persisted id of the assistant message the server is currently generating
   * (from `/agents/:id/sessions/:sid/stream/status`). An exact match is the
   * authoritative "this IS the in-flight message" signal.
   */
  expectedMessageId?: string;
  /**
   * True while the server still reports the turn as streaming.
   *
   * Required to recognise the CURRENT turn's partially-persisted reply: after a
   * page refresh (or a soft-disconnect persist) the current turn's bubble is
   * loaded from the DB, so it has text/segments but `isStreaming === false` —
   * indistinguishable, on its own, from a previous turn's finished reply. Only
   * the server's streaming status plus turn ordering can tell them apart.
   */
  allowCurrentTurnPartial?: boolean;
}

/**
 * Pick the agent bubble a stream-reattach should (re)attach into.
 *
 * MUST only ever return the in-flight bubble:
 *   - the message whose id the server reports as in flight, or
 *   - a message still marked `isStreaming`, or
 *   - an empty placeholder (no text / no content segments) that is still mid-turn, or
 *   - the CURRENT turn's partially-persisted reply (content present but not
 *     `isStreaming`, appearing AFTER the last user message) — but only when the
 *     caller confirms the server is still streaming for this session.
 *
 * It MUST NEVER return a *previous* turn's completed reply. Reusing one caused a
 * real regression: after a user clicked "stop" on a new turn that had no content
 * yet (empty bubble removed), the reattach logic fell back to the LAST agent
 * message in the list — the *previous* turn's reply — streamed the new reply into
 * it, and pushed the user's own question below it (history became [A, D, C]).
 *
 * Symmetrically, treating a partially-persisted CURRENT-turn reply as "finished"
 * created a *duplicate* bubble on every refresh: the DB bubble kept the prefix
 * while a brand-new bubble streamed the tail. Turn ordering fixes both directions.
 */
export function pickStreamReattachTarget(
  msgs: ChatMsg[],
  opts: ReattachTargetOptions = {},
): ChatMsg | undefined {
  // (1) Exact id match — the server named the in-flight assistant message.
  if (opts.expectedMessageId) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]!;
      if (m.id === opts.expectedMessageId && m.sender === 'agent' && !m.isError) return m;
    }
  }

  // (2) Turn-aware tail scan: only the most recent agent message can be in-flight.
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]!.sender === 'user') { lastUserIdx = i; break; }
  }
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.sender !== 'agent') continue;
    if (m.isStreaming) return m; // live streaming bubble
    if (m.isError) return undefined; // error replies are terminal — never reused
    const hasContent = m.text?.trim()
      || (m.segments ?? []).some(s =>
        (s.type === 'text' && (((s as { content?: string }).content ?? '').trim() || (s as { thinking?: string }).thinking))
        || s.type === 'tool',
      );
    if (!hasContent) return m; // empty in-flight placeholder
    // Content-bearing and not streaming: either the CURRENT turn's partial reply
    // (continue in place) or the PREVIOUS turn's finished reply (never reuse).
    // A message appearing AFTER the last user message belongs to this turn.
    if (opts.allowCurrentTurnPartial && lastUserIdx >= 0 && i > lastUserIdx) return m;
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
    time: cachedLocaleTime(m.createdAt),
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

const _smartTimeCache = new Map<string, string>();
const SMART_TIME_CACHE_MAX = 2000;
export function formatSmartTime(isoOrLocale: string, rawCreatedAt?: string, labels?: { yesterday?: string }): string {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  // Cacheable only when the caller pins the instant (otherwise the label depends on "now"),
  // and the today/yesterday branch depends on the wall clock — so the day bucket is part of
  // the key. Folding the day bucket in is what makes this safe across midnight.
  const cacheKey = rawCreatedAt
    ? `${rawCreatedAt}|${todayStart}|${isoOrLocale}|${labels?.yesterday ?? ''}`
    : null;
  if (cacheKey) {
    const hit = _smartTimeCache.get(cacheKey);
    if (hit !== undefined) return hit;
  }
  const d = rawCreatedAt ? new Date(rawCreatedAt) : now;
  if (isNaN(d.getTime())) return isoOrLocale;
  const ts = d.getTime();
  // Include seconds so consecutive agent pushes within the same minute stay distinguishable.
  const hhmmss = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  let out: string;
  if (ts >= todayStart) out = hhmmss;
  else if (ts >= todayStart - 86400000) out = `${labels?.yesterday ?? 'Yesterday'} ${hhmmss}`;
  else out = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + hhmmss;
  if (cacheKey) {
    if (_smartTimeCache.size >= SMART_TIME_CACHE_MAX) _smartTimeCache.clear();
    _smartTimeCache.set(cacheKey, out);
  }
  return out;
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

// ─── Team-chat keyboard shortcuts (需求 4+5) ───────────────────────────────────

/** Team-chat shortcut actions resolved from a keydown. */
export type TeamChatShortcut =
  | 'new-conversation'       // Cmd/Ctrl+N
  | 'cycle-session-next'     // Ctrl+Tab
  | 'cycle-session-prev'     // Ctrl+Shift+Tab
  | null;

/**
 * Map a raw keydown to a Team-chat shortcut action.
 * `isMac` selects the platform modifier (⌘ vs Ctrl). Tab cycling always uses
 * Ctrl (even on Mac), mirroring the Work page's Ctrl+Tab board cycling.
 */
export function resolveTeamChatShortcut(
  e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
  isMac: boolean,
): TeamChatShortcut {
  const mod = isMac ? (e.metaKey && !e.ctrlKey) : (e.ctrlKey && !e.metaKey);
  if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'n') return 'new-conversation';
  if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Tab') {
    return e.shiftKey ? 'cycle-session-prev' : 'cycle-session-next';
  }
  return null;
}

/**
 * Next session-tab id when cycling `ids` from `activeId` by `dir` (1 fwd / -1 back).
 * Returns null when there are fewer than 2 tabs (nothing to cycle).
 * Falls back sensibly (fw → first, back → last) when `activeId` is not in the list.
 */
export function cycleSessionTabId(
  ids: readonly string[],
  activeId: string | null,
  dir: 1 | -1,
): string | null {
  if (ids.length <= 1) return null;
  const idx = activeId === null ? -1 : ids.indexOf(activeId);
  const base = idx >= 0 ? idx : (dir === 1 ? -1 : 0);
  const next = (base + dir + ids.length) % ids.length;
  return ids[next] ?? null;
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

// ─── Composer sizing & layout (需求 6+7) ──────────────────────────────────────

/** Composer max height in "lines" (需求 6): allow ~10 lines of long input. */
export const COMPOSER_MAX_LINES = 10;
/** Measured line height of `text-sm` + `leading-relaxed` (14px × 1.625 ≈ 22.75px). */
export const COMPOSER_LINE_HEIGHT_PX = 23;
/** Textarea vertical padding: expanded px-4 py-3 (24px) vs compact py-1.5 (12px). */
const COMPOSER_PADDING_PX = { expanded: 24, compact: 12 } as const;

/**
 * Max composer textarea height for ~10 lines, in px.
 * `compact` mirrors the collapsed composer (messages visible) — tighter padding,
 * `expanded` (new/empty chat & typing) gets the full 10-line budget.
 */
export function composerMaxHeightPx(compact: boolean): number {
  const vPadding = compact ? COMPOSER_PADDING_PX.compact : COMPOSER_PADDING_PX.expanded;
  return COMPOSER_MAX_LINES * COMPOSER_LINE_HEIGHT_PX + vPadding;
}

/**
 * Whether the composer should stack input and controls on separate rows.
 * Mobile always stacks so the model selector never steals textarea width
 * (需求 7: 窄屏下模型选择器不再挤压输入框); desktop stacks once typing/attaching.
 */
export function composerStacked(isMobile: boolean, composing: boolean): boolean {
  return isMobile || composing;
}

/**
 * Alignment class for the composer's control row (model selector + send/stop).
 *
 * Only needed once stacked. Un-stacked, the two rows are merged into a single
 * flex row via `display: contents`, so the control row is content-sized and
 * already rests at the right edge on its own. Stacked, it becomes a full-width
 * block - and a full-width flex container defaults to the START edge, so
 * without `justify-end` the buttons hug the LEFT.
 *
 * Keying this on `composerExpanded` ("has content") was the bug: on mobile the
 * composer is always stacked, so an *empty* input - precisely the case with no
 * content - produced a full-width row with left-aligned model + send buttons
 * instead of the expected bottom-right corner.
 */
export function composerToolbarAlign(stacked: boolean): string {
  return stacked ? 'justify-end' : '';
}

/** Which thing the mobile L2 (team detail) layer should render. */
export type MobileTeamLayerState = 'detail' | 'loading' | 'missing';

/**
 * Resolve what the mobile L2 team-detail layer can actually show.
 *
 * Why this needs to exist: on mobile the Team page is a hash-driven 3-layer
 * machine (`#team` roster / `#team/t/<id>` team detail / `#team/d` chat). The
 * two other layers are mutually exclusive with L2 - the roster is `hidden` and
 * the chat area is not rendered at all whenever `mobileLayer === 'team'`. So if
 * L2 gives up and renders nothing, the ENTIRE page body is blank and the back
 * button (which lived inside the same block) disappears with it. That is the
 * "messages page is empty and then it is stuck" report: no content, no way back.
 *
 * The distinction that makes recovery safe is `teamsLoaded`. Until the team list
 * request has actually SUCCEEDED we cannot tell "not fetched yet" from "does not
 * exist any more", and healing the URL on a transient network failure would kick
 * the user out of a perfectly valid deep link. So:
 *   - team present                     -> 'detail'
 *   - absent, list not loaded yet      -> 'loading'  (show spinner + retry/back)
 *   - absent, list loaded successfully -> 'missing'  (definitively gone)
 *
 * `teamsLoaded` must be set only on a successful fetch, never in a `finally`.
 */
export function resolveMobileTeamLayerState(
  teamId: string | null | undefined,
  teamIds: readonly string[],
  teamsLoaded: boolean,
): MobileTeamLayerState {
  if (!teamId) return 'missing';
  if (teamIds.includes(teamId)) return 'detail';
  return teamsLoaded ? 'missing' : 'loading';
}
