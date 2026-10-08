/**
 * useChatStream — Extracts the core streaming orchestration (send / stop /
 * tryReattachActiveStream / loadSessionMessages) out of the 5700-line Team.tsx
 * into a self-contained hook.
 *
 * Ownership model:
 * - Team.tsx owns ALL application state (React useState/useRef). This hook must
 *   NOT create parallel state that can drift from the source of truth.
 * - `ctx` bundles the STABLE handles (buffer callbacks, mgr maps, setXxx
 *   setters, helper fns, Team-owned refs). Their identity never changes, so
 *   the hook's useCallback deps stay stable and no effect in Team.tsx re-fires
 *   on every render.
 * - `ctx.stateRef.current` holds the VOLATILE read-only values (chatMode,
 *   selectedAgent, input, …). Team.tsx reassigns it every render; the moved
 *   code reads `stateRef.current.*` at CALL time — the same freshness the
 *   original render-closure had, without capturing a stale snapshot.
 * - The hook OWNS the stream-private refs (abort controllers, reattach
 *   cooldown, send guard, SSE liveness) because every mutation site lives
 *   inside the moved functions.
 *
 * Behavior is preserved 1:1 — this is a mechanical relocation, not a rewrite.
 */
import { useCallback, useRef, type RefObject } from 'react';
import {
  api,
  type AgentInfo, type AgentToolEvent, type StreamCommitEvent, type HumanUserInfo,
  type ChatSessionInfo, type AuthUser, type ChannelMessageInfo,
  type GroupChatInfo, type SubagentProgressEvent,
} from '../api.ts';
import type { TFunction } from 'i18next';
import {
  type MsgSegment, type ChatMsg, type ChatMode,
  dbMsgToChat, channelMsgToChat,
  storedSegmentsToMsgSegments, dedupeAdjacentUserMessages, pickStreamReattachTarget, alignStreamedAgentId,
  appendLiveOutput, appendSubagentLog,
  appendTextToSegments, appendThinkingToSegments,
  finalizeAgentMessage, finalizeLastInterruptedAgent, finalizeStreamEnd, finalizeLastStreamingBubble, msgHasContent,
  shouldInterruptForSend,
  shouldSettleDetachedSession,
} from '../pages/ChatHelpers.ts';
import { NEW_CHAT_PLACEHOLDER_ID } from './useConversationBuffers.ts';
import { resolveStopCancelDecision } from '../lib/stopCancelDecision.ts';
import { parseMentionNames } from '../components/CommentInput.tsx';
import { exponentialBackoffDelay } from '../lib/streamResilience.ts';
import { friendlyAgentError, isMarkusCreditError, dispatchCreditNotification } from '../pages/ChatComponents.tsx';
import type { ActivityStep } from '../components/ActivityIndicator.tsx';

/* ── Volatile read-only state snapshot (refreshed every Team render) ───────── */

export interface ChatStreamVolatileState {
  chatContext: Array<{ id: string; label: string; content: string }>;
  input: string;
  pendingImages: Array<{ id: string; dataUrl: string; name: string }>;
  chatMode: ChatMode;
  selectedAgent?: string;
  activeSessionId?: string | null;
  activeDmUserId: string;
  authUser?: AuthUser;
  activeChannel?: string;
  groupChats: Array<{ channelKey: string; members?: Array<{ id: string; name: string; type: string; avatarUrl?: string }> }>;
  agents: AgentInfo[];
  humans: HumanUserInfo[];
  sending: boolean;
  chatReplyTo: { id: string; sender: string; text: string } | null;
}

import type { ActiveSessionView, WindowBounds } from '../lib/ConversationBufferManager.ts';

/** Stable handles/refs passed once from Team.tsx. */
export interface ChatStreamContext {
  stateRef: RefObject<ChatStreamVolatileState>;
  // Buffer mgr accessors (stable)
  actBuffers: Map<string, unknown[]>;
  /** READ-ONLY view pointer. It has exactly one writer (`setActiveSession`), because
   *  that method also performs placeholder promotion — see H4 in
   *  docs/records/platform-hardening-2026-10.md §3. */
  activeSessionBuffer: ActiveSessionView;
  /** Read the messages rendered for a conversation (projection of the view pointer). */
  readConvMsgs: (k: string) => ChatMsg[] | undefined;
  currentConvKeyRef: RefObject<string>;
  // Buffer callbacks (stable useCallback from useConversationBuffers)
  updateConvMsgs: (k: string, u: (p: ChatMsg[]) => ChatMsg[], s?: string | null) => void;
  updateConvMsgsRaf: (k: string, u: (p: ChatMsg[]) => ChatMsg[], s?: string | null) => void;
  appendConvActivity: (k: string, a: ActivityStep, s?: string | null) => void;
  beginStream: (k: string) => void;
  endStream: (k: string) => void;
  abortStream: (k: string, s?: string | null) => void;
  clearStreamSession: (k: string, s?: string) => void;
  setStreamSession: (k: string, s: string) => void;
  getStreamSession: (k: string) => Set<string> | undefined;
  /** Pin the manager's active-session routing gate for a conversation key.
   *  Must be kept in sync with every setActiveSessionId transition so
   *  `updateMessages` can route a background session's stream into its own
   *  cache instead of the shared display buffer (multi-tab direct mode). */
  setActiveSession: (k: string, s: string) => void;
  incrementSending: (k: string) => void;
  decrementSending: (k: string) => number;
  loadAndDisplay: (s: string, k: string, f: () => Promise<{ messages: ChatMsg[]; hasMore: boolean; oldestCursor: string | null }>) => Promise<{ count: number; hasMore: boolean; oldestCursor: string | null }>;
  // Team-owned refs shared with non-stream code
  thinkingTimeoutRef: RefObject<ReturnType<typeof setTimeout> | null>;
  sessionSwitchSeqRef: RefObject<number>;
  // Setters (stable)
  setSending: (b: boolean) => void;
  setActivities: (a: ActivityStep[]) => void;
  setInput: (s: string) => void;
  setChatContext: (s: Array<{ id: string; label: string; content: string }> | ((p: Array<{ id: string; label: string; content: string }>) => Array<{ id: string; label: string; content: string }>)) => void;
  setPendingImages: (a: Array<{ id: string; dataUrl: string; name: string }>) => void;
  setMentionDropdown: (b: boolean) => void;
  setChatReplyTo: (v: { id: string; sender: string; text: string } | null) => void;
  setActiveSessionId: (s: string | null | ((p: string | null) => string | null)) => void;
  setStoredActiveSession: (agentId: string, sessionId: string) => void;
  setOpenSessionTabs: (u: (p: ChatSessionInfo[]) => ChatSessionInfo[]) => void;
  setSessions: (s: ChatSessionInfo[] | ((p: ChatSessionInfo[]) => ChatSessionInfo[])) => void;
  setLoadingChat: (b: boolean) => void;
  setWindowBounds: (bufferId: string, bounds: WindowBounds) => void;
  setThinkingAgents: (a: Array<{ id: string; name: string; avatarUrl?: string }> | ((p: Array<{ id: string; name: string; avatarUrl?: string }>) => Array<{ id: string; name: string; avatarUrl?: string }>)) => void;
  // Helpers
  makeConvKey: (m: ChatMode, a: string, c: string, d?: string) => string;
  makeDmChannel: (userId: string, dmUserId: string) => string;
  addRecentMsgId: (id: string) => void;
  resumeChatScrollFollow: () => void;
  loadSessions: (agentId: string) => Promise<ChatSessionInfo[]>;
  t: TFunction;
}

export interface ChatStreamApi {
  send: (retryText?: string, options?: { isRetry?: boolean; isResume?: boolean; sessionIdOverride?: string }) => Promise<void>;
  stopSending: () => void;
  tryReattachActiveStream: (agentId: string, sessionId: string, convKey: string) => Promise<void>;
  loadSessionMessages: (sessionId: string, convKey: string) => Promise<number>;
}

export function useChatStream(ctx: ChatStreamContext): ChatStreamApi {
  // ── Stream-private refs (every mutation site lives inside the moved fns) ──
  // ── 每会话一份 controller（不再是单槽）────────────────────────────
  // 单槽 ref 表达不了 N 条并发流：abort「那个」流正是兄弟 tab 的 SSE 被误杀的
  // 根源。按会话 id 寻址后，abort 只可能命中目标会话自己的传输。
  const streamCtrlsRef = useRef<Map<string, AbortController>>(new Map());
  const reattachCtrlsRef = useRef<Map<string, AbortController>>(new Map());
  const dropStreamCtl = (ctl: AbortController | null) => {
    if (!ctl) return;
    for (const [k, v] of streamCtrlsRef.current) if (v === ctl) streamCtrlsRef.current.delete(k);
  };
  const dropReattachCtl = (ctl: AbortController | null) => {
    if (!ctl) return;
    for (const [k, v] of reattachCtrlsRef.current) if (v === ctl) reattachCtrlsRef.current.delete(k);
  };
  /** Abort only the stream(s) owned by `sid` — never a sibling tab's. */
  const abortStreamsFor = (sid: string) => {
    const sc = streamCtrlsRef.current.get(sid);
    if (sc) { sc.abort(); streamCtrlsRef.current.delete(sid); }
    const rc = reattachCtrlsRef.current.get(sid);
    if (rc) { rc.abort(); reattachCtrlsRef.current.delete(sid); }
  };
  /**
   * session_start 到达后，把占位键上的 controller 改挂到真实会话键上。
   * 否则之后按真实 id 发起的 interrupt 找不到它（“停不下”）。
   * 仅当占位键下恰好只有这一条时迁移，避免抢走兄弟 tab 的条目。
   */
  const promoteStreamCtl = (realSid: string) => {
    const c = streamCtrlsRef.current.get(NEW_CHAT_PLACEHOLDER_ID);
    if (c && streamCtrlsRef.current.size === 1) {
      streamCtrlsRef.current.delete(NEW_CHAT_PLACEHOLDER_ID);
      streamCtrlsRef.current.set(realSid, c);
    }
  };
  const reattachCooldownRef = useRef<Map<string, number>>(new Map());
  const userStoppedSessionsRef = useRef<Set<string>>(new Set());
  const lastSendGuardRef = useRef<{ text: string; at: number } | null>(null);
  // Guards against duplicate resume requests for the same conversation
  // (double-click / double Enter). `lastSendGuardRef` deliberately exempts
  // retry/resume (identical text must stay repeatable), so without this a
  // double-click fired two concurrent resumes — the backend then raced a
  // restore against a fresh-session creation and the agent ended up with two
  // divergent memory sessions for one DB session.
  const resumeGuardRef = useRef<Map<string, number>>(new Map());
  const lastSseEventTimeRef = useRef<number>(0);

  const { stateRef } = ctx;
  // Stable destructure — deps for useCallback below stay constant.
  const {
    actBuffers, activeSessionBuffer, readConvMsgs, currentConvKeyRef,
    updateConvMsgs, updateConvMsgsRaf, appendConvActivity,
    beginStream, endStream, abortStream,
    clearStreamSession, setStreamSession, getStreamSession, setActiveSession,
    incrementSending, decrementSending, loadAndDisplay,
    thinkingTimeoutRef, sessionSwitchSeqRef,
    setSending, setActivities, setInput, setChatContext, setPendingImages,
    setMentionDropdown, setChatReplyTo, setActiveSessionId, setStoredActiveSession,
    setOpenSessionTabs, setSessions, setLoadingChat, setWindowBounds, setThinkingAgents,
    makeConvKey, makeDmChannel, addRecentMsgId, resumeChatScrollFollow, loadSessions,
  } = ctx;
  const { t } = ctx;

  // Load session messages from DB — phase-aware via ConversationBufferManager.
  // During streaming phase, DB data is written to cache only, never to display.
  const loadSessionMessages = useCallback(async (sessionId: string, convKey: string): Promise<number> => {
    const seqAtStart = sessionSwitchSeqRef.current;
    // Soft-refresh (buffer already has messages) should not flash a full-page spinner.
    const showSpinner = currentConvKeyRef.current === convKey
      && (readConvMsgs(convKey)?.length ?? 0) === 0;
    if (showSpinner) setLoadingChat(true);
    try {
      const { count, hasMore: more, oldestCursor } = await loadAndDisplay(sessionId, convKey, async () => {
        const result = await api.sessions.getMessages(sessionId, 50);
        const msgs = dedupeAdjacentUserMessages(result.messages.map(dbMsgToChat).filter(m =>
          m.sender !== 'agent' || m.text || (m.segments && m.segments.length > 0) || m.isStreaming
        ));
        return {
          messages: msgs,
          hasMore: result.hasMore,
          oldestCursor: result.messages[0] ? new Date(result.messages[0].createdAt).toISOString() : null,
        };
      });
      // 边界写进**这个会话自己的 buffer 槽**（`bufferId = sessionId`），而不是某个全局值 ——
      // 于是别的会话晚到的加载不可能改写这个会话的窗口边界（第六轮报障根因）。
      setWindowBounds(sessionId, { hasMore: more, oldestCursor });
      return count;
    } finally {
      // Only the latest session switch may clear the spinner — an older tab
      // request resolving late otherwise kills the loading state of the tab
      // the user is actually viewing now.
      if (showSpinner && currentConvKeyRef.current === convKey && sessionSwitchSeqRef.current === seqAtStart) setLoadingChat(false);
    }
  }, [loadAndDisplay, readConvMsgs, sessionSwitchSeqRef]);

  // ── Stop (interrupt) ───────────────────────────────────────────────────────
  const stopSending = () => {
    // 1) Tell the backend to stop FIRST. Aborting the SSE alone is a soft
    // disconnect — the agent keeps working for up to SSE_DISCONNECT_FORCE_STOP_MS
    // unless cancel-processing marks userStopped.
    //
    // 【P1 H1 修法：目标限定】只对**既有会话**发 scoped 取消（`none` 不误杀）；
    // 占位/无会话 → `skip`：仅前端 abort + 记 userStopped，不触后端 —— 无 target
    // 的请求会让服务端走 `root` 兼容路径，取消"当前 ALS/根上下文流"，而发送线程
    // 没有 ALS → 落成"取消此刻正在跑的那条流"，误杀别的会话（"两条都处理中 /
    // 第一条没真正处理"的直接成因）。见 lib/stopCancelDecision.ts。
    const agentId = stateRef.current.chatMode === 'direct' ? stateRef.current.selectedAgent : null;
    if (agentId) {
      const decision = resolveStopCancelDecision(stateRef.current.activeSessionId, NEW_CHAT_PLACEHOLDER_ID);
      if (decision.kind === 'cancel') {
        void api.agents.cancelProcessing(agentId, decision.target).catch(() => {});
      }
    }

    // 2) Abort both the live send() stream and any reattachStream consumer.
    // Previously only abortControllerRef was cleared — after refresh/reattach
    // the stop button looked clickable but did nothing to the open SSE.
    abortStreamsFor(stateRef.current.activeSessionId ?? NEW_CHAT_PLACEHOLDER_ID);

    // 3) A user-initiated stop is final for the CURRENT turn. Remember the
    // session so reattach/refresh never resumes it (the agent may still report
    // "streaming" for a moment after cancel, which previously made the stop
    // look like a no-op and let the reply stream into a removed bubble).
    if (agentId && stateRef.current.activeSessionId && stateRef.current.activeSessionId !== NEW_CHAT_PLACEHOLDER_ID) {
      userStoppedSessionsRef.current.add(stateRef.current.activeSessionId);
    }

    // 4) Unblock the UI immediately — single idempotent teardown.
    //    (replaces: resetSending + actBuffers.delete + endStream +
    //     clearStreamSession + setSending + setActivities)
    abortStream(currentConvKeyRef.current, stateRef.current.activeSessionId);
  };

  // ── Reattach after refresh / session switch ───────────────────────────────
  /**
   * After refresh / session switch: if the server still has an active generation
   * for this session, reattach SSE and continue streaming into the last agent bubble.
   * Must consume text + tool + commit events the same way as a live send().
   */
  const tryReattachActiveStream = useCallback(async (agentId: string, sessionId: string, convKey: string) => {
    if (!agentId || !sessionId || sessionId === NEW_CHAT_PLACEHOLDER_ID) return;
    // A user-initiated stop is final for that turn — never reattach/resume it.
    if (userStoppedSessionsRef.current.has(sessionId)) return;
    let abortCtrl: AbortController | null = null;
    try {
      // Live send() still owns this session's SSE — keep consuming there; a second
      // attach would double-apply tool/subagent events. IMPORTANT: do NOT call
      // beginStream here — the owning send() already marked the agent as
      // streaming and will endStream it. Calling it again leaks the refcount
      // and pins the sidebar to "working" after the agent has stopped.
      const sendCtl = streamCtrlsRef.current.get(sessionId);
      if (
        sendCtl
        && !sendCtl.signal.aborted
        && getStreamSession(convKey)?.has(sessionId)
      ) {
        if (currentConvKeyRef.current === convKey) setSending(true);
        return;
      }

      /**
       * P1-15：确定「不 attach」时必须平账，否则调用方留下的 `isStreaming`
       * 气泡会永久「思考中」+ 侧栏 busy 残留。只在本地无任何 stream session
       * 归属该会话时清理（其他路径仍在消费时不得抢拆）。本函数在这两条早退
       * 路径上从未 `beginStream`，故也不调 `endStream`（避免 refcount 下溢）。
       */
      const finalizeIfDetached = () => {
        // 判据是「**这个会话**是否还有在途流」，不是「该 Agent 下任意会话有没有流」——
        // 用别人的状态回答我的问题，正是本类 bug 的共同形状。
        if (!shouldSettleDetachedSession({
          liveSessions: getStreamSession(convKey),
          sessionId,
          placeholderId: NEW_CHAT_PLACEHOLDER_ID,
        })) return;
        clearStreamSession(convKey, sessionId);
        if (currentConvKeyRef.current === convKey) {
          setSending(false);
          updateConvMsgs(convKey, prev => finalizeLastStreamingBubble(prev), sessionId);
        }
      };

      // Prevent attach storms when the browser is out of sockets / soft-disconnect loops.
      const cooldownKey = `${agentId}:${sessionId}`;
      const lastAttempt = reattachCooldownRef.current.get(cooldownKey) ?? 0;
      if (Date.now() - lastAttempt < 1500) {
        finalizeIfDetached();
        return;
      }
      // Throttle EVERY attempt, not only successful attaches. The idle path
      // below (no active server stream) never reached the cooldown write, so a
      // caller that re-invoked on render could hammer streamStatus at render
      // speed — one of the two amplifiers of the idle CPU storm.
      reattachCooldownRef.current.set(cooldownKey, Date.now());

      // 服务端已命名的在途回复 id —— 供 DB-heal 收尾做身份衔接（见 `!result` 分支）。
      let lastMessageId: string | undefined;
      const status = await api.sessions.streamStatus(agentId, sessionId);
      if (status.messageId) lastMessageId = status.messageId;
      const msgs = readConvMsgs(convKey) ?? [];
      const serverStreaming = status.status === 'streaming';
      // Reattach must only ever continue the IN-FLIGHT bubble. Two signals:
      //  · `expectedMessageId` — the server names the in-flight assistant message;
      //  · `allowCurrentTurnPartial` — while streaming, the current turn's reply may
      //    already be persisted (refresh / soft-disconnect persist), so it carries
      //    content but is NOT `isStreaming`. Without this it looked like a finished
      //    reply and reattach spawned a SECOND bubble beside it.
      const last = pickStreamReattachTarget(msgs, {
        expectedMessageId: status.messageId,
        allowCurrentTurnPartial: serverStreaming,
      });
      // `active` stays true for ~90s after done/error so a late refresh can drain
      // the terminal event — only attach when still streaming, or when the UI
      // bubble is still marked in-flight and needs the final `done`.
      const lateTerminal = !!status.active
        && (status.status === 'done' || status.status === 'error')
        && !!last?.isStreaming;
      if (!serverStreaming && !lateTerminal) {
        finalizeIfDetached();
        return;
      }

      reattachCooldownRef.current.set(cooldownKey, Date.now());
      for (const c of reattachCtrlsRef.current.values()) c.abort();
      reattachCtrlsRef.current.clear();
      abortCtrl = new AbortController();
      reattachCtrlsRef.current.set(sessionId, abortCtrl);
      beginStream(convKey);
      setSending(true);
      setStreamSession(convKey, sessionId);

      // Ensure there is an agent bubble to stream into. Keep DB tool segments as
      // an interim view — server `snapshot` (or live tool events) will replace/
      // update them. Do NOT wipe tools here: ring replay alone can miss early
      // tool events once the text_delta ring overflows.
      let agentMsgId = last?.id;
      if (!last || last.isError) {
        agentMsgId = `reattach_${Date.now()}`;
        updateConvMsgs(convKey, prev => [
          ...prev,
          { id: agentMsgId!, sender: 'agent', text: '', time: new Date().toLocaleTimeString(), isStreaming: true, segments: [] },
        ], sessionId);
      } else {
        // Keep tool cards from soft-disconnect DB persist; drop text segments so
        // ring text_delta fallback (no snapshot) does not duplicate DB text.
        const revivedTools = (last.segments ?? [])
          .filter((s): s is Extract<typeof s, { type: 'tool' }> => s.type === 'tool')
          .map(s =>
            s.status === 'stopped' || s.status === 'running'
              ? { ...s, status: 'running' as const }
              : s,
          );
        updateConvMsgs(convKey, prev => prev.map(m =>
          m.id === last.id
            ? {
                ...m,
                text: '',
                isStreaming: true,
                isStopped: false,
                segments: revivedTools,
                committedSegments: undefined,
              }
            : m,
        ), sessionId);
      }

      /**
       * Append a text chunk to the segment stream (RAF-batched to reduce re-renders).
       * `chunk` is answer prose only — reasoning arrives via onThinking.
       */
      const appendTextChunk = (chunk: string) => {
        if (currentConvKeyRef.current !== convKey) return;
        lastSseEventTimeRef.current = Date.now();
        updateConvMsgsRaf(convKey, prev => {
          const u = [...prev];
          const idx = agentMsgId ? u.findIndex(m => m.id === agentMsgId) : -1;
          // Fallback MUST require an in-flight bubble — never stream into a
          // previous turn's completed reply (history-corruption bug).
          const i = idx >= 0 ? idx : u.map((m, j) => ({ m, j })).reverse().find(x => x.m.sender === 'agent' && x.m.isStreaming)?.j ?? -1;
          if (i < 0) return prev;
          const msg = u[i]!;
          u[i] = {
            ...msg,
            text: (msg.text ?? '') + chunk,
            segments: appendTextToSegments(msg.segments ?? [], chunk),
            isStreaming: true,
          };
          return u;
        }, sessionId);
      };

      /** Append a raw reasoning chunk (structured event — no inline tags to parse). */
      const appendThinkingChunk = (chunk: string) => {
        if (currentConvKeyRef.current !== convKey) return;
        lastSseEventTimeRef.current = Date.now();
        updateConvMsgsRaf(convKey, prev => {
          const u = [...prev];
          const idx = agentMsgId ? u.findIndex(m => m.id === agentMsgId) : -1;
          const i = idx >= 0 ? idx : u.map((m, j) => ({ m, j })).reverse().find(x => x.m.sender === 'agent' && x.m.isStreaming)?.j ?? -1;
          if (i < 0) return prev;
          const msg = u[i]!;
          u[i] = { ...msg, segments: appendThinkingToSegments(msg.segments ?? [], chunk), isStreaming: true };
          return u;
        }, sessionId);
      };

      const handleToolEvent = (event: AgentToolEvent) => {
        if (currentConvKeyRef.current !== convKey) return;
        lastSseEventTimeRef.current = Date.now();
        if (event.phase === 'heartbeat') return;
        if (event.phase === 'start' || event.phase === 'end') {
          appendConvActivity(convKey, { ...event, phase: event.phase, ts: Date.now() }, sessionId);
        }
        if (event.phase === 'start') {
          const toolKey = `${event.tool}_${Date.now()}`;
          const now = new Date().toISOString();
          // Revive a soft-disconnect "stopped/running" tool for the same name, else push a new one.
          const reviveOrPush = (list: MsgSegment[]): MsgSegment[] => {
            const arr = [...list];
            for (let i = arr.length - 1; i >= 0; i--) {
              const s = arr[i]!;
              if (s.type === 'tool' && s.tool === event.tool && (s.status === 'running' || s.status === 'stopped')) {
                arr[i] = { ...s, status: 'running', args: event.arguments ?? s.args };
                return arr;
              }
            }
            arr.push({ type: 'tool', key: toolKey, tool: event.tool, status: 'running', args: event.arguments, createdAt: now });
            return arr;
          };
          updateConvMsgs(convKey, prev => {
            const u = [...prev];
            const idx = agentMsgId ? u.findIndex(m => m.id === agentMsgId) : -1;
            if (idx < 0) return prev;
            const segs = reviveOrPush(u[idx]!.segments ?? []);
            // Keep committedSegments (snapshot-seeded) in sync so the always-expanded
            // full log renders tools that arrive live after reattach.
            const prevCommitted = u[idx]!.committedSegments;
            const committed = prevCommitted ? reviveOrPush(prevCommitted) : prevCommitted;
            u[idx] = { ...u[idx]!, segments: segs, committedSegments: committed, isStreaming: true };
            return u;
          }, sessionId);
        } else if (event.phase === 'end') {
          const now = new Date().toISOString();
          const finalize = (list: MsgSegment[]): MsgSegment[] => {
            const arr = [...list];
            for (let i = arr.length - 1; i >= 0; i--) {
              const s = arr[i]!;
              if (s.type === 'tool' && s.tool === event.tool && (s.status === 'running' || s.status === 'stopped')) {
                arr[i] = {
                  ...s,
                  status: event.success === false ? 'error' : 'done',
                  args: event.arguments ?? s.args,
                  result: event.result,
                  error: event.error,
                  durationMs: event.durationMs,
                  liveOutput: undefined,
                  createdAt: now,
                };
                break;
              }
            }
            return arr;
          };
          updateConvMsgs(convKey, prev => {
            const u = [...prev];
            const idx = agentMsgId ? u.findIndex(m => m.id === agentMsgId) : -1;
            if (idx < 0) return prev;
            const segs = finalize(u[idx]!.segments ?? []);
            const prevCommitted = u[idx]!.committedSegments;
            const committed = prevCommitted ? finalize(prevCommitted) : prevCommitted;
            u[idx] = { ...u[idx]!, segments: segs, committedSegments: committed, isStreaming: true };
            return u;
          }, sessionId);
        } else if (event.phase === 'subagent_progress' && event.subagentEvent) {
          const appendLog = (list: MsgSegment[]): MsgSegment[] => {
            const next = [...list];
            for (let i = next.length - 1; i >= 0; i--) {
              const s = next[i]!;
              if (s.type === 'tool' && (s.tool === 'spawn_subagent' || s.tool === 'spawn_subagents') && (s.status === 'running' || s.status === 'stopped')) {
                next[i] = { ...s, status: 'running', subagentLogs: appendSubagentLog(s.subagentLogs, event.subagentEvent!) };
                break;
              }
            }
            return next;
          };
          updateConvMsgsRaf(convKey, prev => {
            const u = [...prev];
            const idx = agentMsgId ? u.findIndex(m => m.id === agentMsgId) : -1;
            if (idx < 0) return prev;
            const segs = appendLog(u[idx]!.segments ?? []);
            const prevCommitted = u[idx]!.committedSegments;
            const committed = prevCommitted ? appendLog(prevCommitted) : prevCommitted;
            u[idx] = { ...u[idx]!, segments: segs, committedSegments: committed, isStreaming: true };
            return u;
          }, sessionId);
        }
      };

      const handleCommitEvent = (event: StreamCommitEvent) => {
        if (currentConvKeyRef.current !== convKey) return;
        lastSseEventTimeRef.current = Date.now();
        updateConvMsgs(convKey, prev => {
          const u = [...prev];
          const idx = agentMsgId ? u.findIndex(m => m.id === agentMsgId) : -1;
          if (idx < 0) return prev;
          const committed = [...(u[idx]!.committedSegments ?? [])];
          if (event.type === 'thinking_commit') {
            committed.push({ type: 'text', content: '', thinking: event.content, createdAt: event.createdAt });
          } else if (event.type === 'text_commit') {
            committed.push({ type: 'text', content: event.content, createdAt: event.createdAt });
          } else {
            return prev;
          }
          u[idx] = { ...u[idx]!, committedSegments: committed, isStreaming: true };
          return u;
        }, sessionId);
      };

      const handleSnapshot = (snapshot: { content: string; segments: Array<{ type: string; content?: string; thinking?: string; tool?: string; status?: string; arguments?: unknown; result?: string; error?: string; durationMs?: number; createdAt?: string; subagentLogs?: SubagentProgressEvent[] }> }) => {
        if (currentConvKeyRef.current !== convKey) return;
        lastSseEventTimeRef.current = Date.now();
        const segs = (snapshot.segments ?? []).map((s, si) =>
          s.type === 'tool'
            ? {
                type: 'tool' as const,
                key: `${s.tool}_${si}`,
                tool: s.tool ?? 'tool',
                status: (s.status === 'error' ? 'error' : s.status === 'running' || s.status === 'stopped' ? 'running' : 'done') as 'running' | 'done' | 'error' | 'stopped',
                args: s.arguments,
                result: s.result,
                error: s.error,
                durationMs: s.durationMs,
                createdAt: s.createdAt,
                ...(s.subagentLogs?.length ? { subagentLogs: s.subagentLogs } : {}),
              }
            : {
                type: 'text' as const,
                content: s.content ?? '',
                thinking: s.thinking,
                createdAt: s.createdAt,
              },
        );
        updateConvMsgs(convKey, prev => {
          const u = [...prev];
          const idx = agentMsgId ? u.findIndex(m => m.id === agentMsgId) : -1;
          if (idx < 0) return prev;
          u[idx] = {
            ...u[idx]!,
            text: snapshot.content || u[idx]!.text,
            segments: segs,
            committedSegments: segs,
            isStreaming: true,
            isStopped: false,
          };
          return u;
        }, sessionId);
        // Rebuild activity chips from restored tool segments.
        for (const s of segs) {
          if (s.type !== 'tool') continue;
          appendConvActivity(convKey, {
            tool: s.tool,
            phase: s.status === 'running' || s.status === 'stopped' ? 'start' : 'end',
            success: s.status !== 'error',
            arguments: s.args,
            result: s.result,
            error: s.error,
            durationMs: s.durationMs,
            ts: Date.now(),
          }, sessionId);
        }
      };

      // ── Attach supervisor ─────────────────────────────────────────────────
      // 结构性修复（2026-10-01 报告）：**传输结束 ≠ 回合结束**。
      //
      // 旧实现只 attach 一次，并把 `attached: true` 无条件当成「回合完成」去定型气泡。
      // 于是 socket 再次被切断时（页面 teardown / 代理抖动 / 看门狗触发），气泡会被
      // 定型成「已结束」，而服务端其实仍在跑 —— 用户刷新才又看到流式输出。
      //
      // 现在：只有真正的终态（terminal=done）才允许定型；任何非终态结束都按退避重连，
      // 并保持气泡处于「进行中」。服务端确认无活跃流后，以 DB 里的完整回复重建气泡，
      // 绝不把半截内容冒充「已完成」。
      const MAX_ATTACH_ATTEMPTS = 8;
      type AttachResult = Awaited<ReturnType<typeof api.sessions.reattachStream>>;
      let result: AttachResult | null = null;

      const markReconnecting = (on: boolean) => {
        if (currentConvKeyRef.current !== convKey) return;
        updateConvMsgs(convKey, prev => {
          const idx = prev.map((m, j) => ({ m, j })).reverse()
            .find(x => x.m.sender === 'agent' && x.m.isStreaming)?.j ?? -1;
          if (idx < 0 || prev[idx]!.reconnecting === on) return prev;
          const u = [...prev];
          u[idx] = { ...u[idx]!, reconnecting: on };
          return u;
        }, sessionId);
      };

      for (let attempt = 1; attempt <= MAX_ATTACH_ATTEMPTS; attempt++) {
        if (abortCtrl.signal.aborted) return;
        try {
          // Prefer server snapshot (tools + text). Falls back to ring replay if older server.
          result = await api.sessions.reattachStream(
            agentId,
            sessionId,
            {
              onChunk: appendTextChunk,
              onThinking: appendThinkingChunk,
              onActivity: handleToolEvent,
              onCommit: handleCommitEvent,
              onSnapshot: handleSnapshot,
            },
            abortCtrl.signal,
            // afterSeq=0 → the server sends its authoritative UI snapshot (full text
            // + tool cards) instead of only events after `lastSeq`. Passing
            // `status.lastSeq` made `useSnapshot` false server-side, so a reattached
            // bubble could only ever show the TAIL of the reply.
            0,
          );
        } catch (e) {
          // A real abort must propagate (stop button / newer reattach / navigation).
          if (abortCtrl.signal.aborted) throw e;
          result = null;
        }
        if (!result || !result.attached) { result = null; break; }  // 204: nothing live
        if (result.terminal) break;                                 // 真终态：done

        // 传输中途断了 —— 问服务端到底还在不在跑，再决定是否继续接。
        markReconnecting(true);
        const st = await api.sessions.streamStatus(agentId, sessionId).catch(() => null);
        if (st?.messageId) lastMessageId = st.messageId;
        if (!st || !st.active || st.status === 'not_found' || st.status === 'idle') {
          markReconnecting(false);
          result = null;
          break;
        }
        await new Promise(r => setTimeout(r, Math.min(800 * attempt, 4000)));
        markReconnecting(false);
      }

      if (!result) {
        // 服务端已无活跃流 —— 本回合确实结束（或已无法再续接）。
        endStream(convKey);
        // Reattach added this session to the streaming set; it is not coming
        // back — release the session so the sidebar busy mark is removed.
        clearStreamSession(convKey, sessionId);
        if (currentConvKeyRef.current === convKey) {
          setSending(false);
          // 身份衔接（补 #356 遗漏的第五条终局路径）：先把本地合成 id 收敛到服务端
          // 已命名的 messageId，使随后的 DB heal 复用**同一行**。否则本地合成 id 的
          // 气泡被整条替换成 DB messageId 行 → React 卸载旧节点、挂载新节点，观感
          // 就是「半截流式气泡 → 完整回复一闪 + 结束态」（刷新后无此跳变，故"正常"）。
          if (lastMessageId && agentMsgId) {
            updateConvMsgs(convKey, prev => alignStreamedAgentId(prev, agentMsgId, lastMessageId), sessionId);
          }
          // 以持久化的完整回复为准重建气泡（DB heal），而不是把当前这半截内容
          // 定型成「已完成」。DB 读取失败/无该行时退回本地定型，避免永久「思考中」。
          void loadSessionMessages(sessionId, convKey)
            .catch(() => {})
            .finally(() => {
              updateConvMsgs(convKey, prev => finalizeLastStreamingBubble(prev, 'done'), sessionId);
            });
        }
        dropReattachCtl(abortCtrl);
        return;
      }

      if (currentConvKeyRef.current === convKey) {
        let finalizedId: string | undefined;
        updateConvMsgs(convKey, prev => {
          const u = [...prev];
          const idx = agentMsgId ? u.findIndex(m => m.id === agentMsgId) : -1;
          const i = idx >= 0 ? idx : u.map((m, j) => ({ m, j })).reverse().find(x => x.m.sender === 'agent' && x.m.isStreaming)?.j ?? -1;
          if (i < 0) return prev;
          const msg = u[i]!;
          // Only a still-in-flight bubble may be finalized here — never a
          // previous turn's completed reply.
          if (!msg.isStreaming) return prev;
          finalizedId = msg.id;
          const finalSegs = result!.segments?.length
            ? storedSegmentsToMsgSegments(result!.segments, msg.segments)
            : undefined;
          u[i] = {
            ...msg,
            text: result!.content || msg.text,
            isStreaming: false,
            isStopped: false,
            reconnecting: false,
            ...(finalSegs
              ? { segments: finalSegs, committedSegments: finalSegs }
              : {}),
          };
          return u;
        }, sessionId);
        // Converge the reattached bubble's synthetic id (`reattach_…`) to the
        // server-persisted id, so a later DB load dedups it by id instead of
        // rendering the reply twice.
        if (finalizedId) {
          updateConvMsgs(convKey, prev => alignStreamedAgentId(prev, finalizedId, result!.messageId), sessionId);
        }
        setSending(false);
      }
      endStream(convKey);
      // This reattach's stream session is finished (stream completed) — remove
      // it so the sidebar busy mark clears with the stream.
      clearStreamSession(convKey, sessionId);
      dropReattachCtl(abortCtrl);
    } catch (err) {
      // Aborted by stop / newer reattach / navigation — always clear local stream UI.
      const wasActive = abortCtrl ? [...reattachCtrlsRef.current.values()].includes(abortCtrl) : false;
      dropReattachCtl(abortCtrl);
      endStream(convKey);
      // Same as above: whatever ended this reattach (abort / error) means the
      // stream session is no longer active — release it.
      clearStreamSession(convKey, sessionId);
      if (currentConvKeyRef.current === convKey) {
        setSending(false);
        // The bubble this reattach was feeding is still marked streaming (the
        // handover / placeholder set isStreaming: true). Abort or death of the
        // reattach ends the local stream — finalize the bubble instead of
        // leaving a perpetual "thinking…" ghost. Only act when THIS was the
        // active reattach: a newer one may still be streaming the same bubble.
        if (wasActive) {
          updateConvMsgs(convKey, prev => finalizeLastStreamingBubble(prev), sessionId);
        }
      }
      if (err instanceof Error && err.name === 'AbortError') return;
    }
  }, [appendConvActivity, beginStream, endStream, getStreamSession, readConvMsgs, setStreamSession, updateConvMsgs, updateConvMsgsRaf]);

  // ── Send ──────────────────────────────────────────────────────────────────
  const send = useCallback(async (retryText?: string, options?: { isRetry?: boolean; isResume?: boolean; sessionIdOverride?: string }) => {
    const volatile = stateRef.current;
    const ctxPrefix = (!retryText && volatile.chatContext.length > 0)
      ? volatile.chatContext.map(c => c.content).join('\n\n') + '\n\n'
      : '';
    const text = (retryText ?? (ctxPrefix + volatile.input)).trim();
    if (!text && volatile.pendingImages.length === 0) return;
    if (volatile.chatMode === 'direct' && !volatile.selectedAgent) return;
    resumeChatScrollFollow();

    // Ignore accidental double-submit of the same text (double Enter / double click).
    const now = Date.now();
    const prevSend = lastSendGuardRef.current;
    if (
      !options?.isRetry
      && !options?.isResume
      && text
      && prevSend
      && prevSend.text === text
      && now - prevSend.at < 1500
    ) {
      return;
    }
    lastSendGuardRef.current = { text, at: now };

    // Duplicate-resume guard (see resumeGuardRef). Keyed by the bound session so
    // re-resuming the SAME conversation twice in quick succession is ignored,
    // while a genuine resume after a stop still works.
    if (options?.isResume) {
      const resumeKey = options.sessionIdOverride ?? volatile.activeSessionId ?? '';
      if (now - (resumeGuardRef.current.get(resumeKey) ?? 0) < 2000) return;
      resumeGuardRef.current.set(resumeKey, now);
    }

    // 只有「本次要发的那个会话」自身有在途流时，才谈得上“打断并重发”。
    //
    // 旧判据是 `activeSessionId && activeSessionId !== NEW_CHAT`（= “当前 tab 有没有
    // 真实 session id”），而 sending 与 convKey 都是 Agent 级、被同一 agent 的所有
    // session tab 共用 —— 于是「在 tab B 发消息」被判成「打断当前流」，把正在输出的
    // tab A 连同它的 SSE 一起 abort 掉。判据必须是会话自身的在途状态。
    if (volatile.sending && volatile.chatMode === 'direct') {
      const isSameSession = shouldInterruptForSend({
        liveSessions: getStreamSession(currentConvKeyRef.current),
        sendSessionId: volatile.activeSessionId,
      });
      if (isSameSession) {
        const prevKey = currentConvKeyRef.current;
        const buf = readConvMsgs(prevKey) ?? [];
        const lastUser = [...buf].reverse().find(m => m.sender === 'user');
        // Same text already in-flight — don't stack another user bubble; retry the turn.
        if (lastUser?.text === text && !options?.isRetry && !options?.isResume) {
          abortStreamsFor(volatile.activeSessionId ?? NEW_CHAT_PLACEHOLDER_ID);
          // P1 2b：占位/无会话不发后端取消（无 target 会 root 误杀），与 stopSending 同一决策。
          const dec0 = resolveStopCancelDecision(volatile.activeSessionId, NEW_CHAT_PLACEHOLDER_ID);
          if (dec0.kind === 'cancel') {
            void api.agents.cancelProcessing(volatile.selectedAgent!, dec0.target).catch(() => {});
          }
          abortStream(prevKey, volatile.activeSessionId);
          // Drop the in-flight user+empty agent pair before the retry re-adds them.
          updateConvMsgs(prevKey, prev => {
            const u = [...prev];
            // Remove trailing empty/partial agent, then the matching user bubble.
            if (u.length > 0 && u[u.length - 1]!.sender === 'agent') u.pop();
            if (u.length > 0 && u[u.length - 1]!.sender === 'user' && u[u.length - 1]!.text === text) u.pop();
            return u;
          });
          await new Promise(r => setTimeout(r, 50));
          return send(text, { isRetry: true });
        }
        // Same session: interrupt current stream and resend
        abortStreamsFor(volatile.activeSessionId ?? NEW_CHAT_PLACEHOLDER_ID);
        // P1 2b：同一决策 —— 占位/无会话不发后端取消（无 target 会 root 误杀）。
        const dec1 = resolveStopCancelDecision(volatile.activeSessionId, NEW_CHAT_PLACEHOLDER_ID);
        if (dec1.kind === 'cancel') {
          void api.agents.cancelProcessing(volatile.selectedAgent!, dec1.target).catch(() => {});
        }
        abortStream(prevKey, volatile.activeSessionId);
        updateConvMsgs(prevKey, prev => finalizeLastInterruptedAgent(prev));
        await new Promise(r => setTimeout(r, 50));
      }
      // For new session (NEW_CHAT_PLACEHOLDER_ID): don't abort. The message will be
      // sent to the agent's mailbox and queued. The agent will process it after
      // finishing the current stream, and the response will arrive via SSE or WS fallback.
    } else if (volatile.sending && volatile.chatMode !== 'direct') {
      // Non-direct mode (channel/dm): abort as before since channels are independent
      abortStreamsFor(stateRef.current.activeSessionId ?? currentConvKeyRef.current);
      const prevKey = currentConvKeyRef.current;
      abortStream(prevKey);
      updateConvMsgs(prevKey, prev => finalizeLastInterruptedAgent(prev));
      await new Promise(r => setTimeout(r, 50));
    }

    const imagesToSend = volatile.pendingImages.length > 0 ? volatile.pendingImages.map(img => img.dataUrl) : undefined;
    const fileNamesToSend = volatile.pendingImages.length > 0 ? volatile.pendingImages.map(img => img.name) : undefined;
    const sendKey = makeConvKey(volatile.chatMode, volatile.selectedAgent ?? '', volatile.activeChannel ?? '', volatile.activeDmUserId);
    const replyCtx = volatile.chatReplyTo;

    if (!retryText) {
      setInput('');
      setChatContext([]);
    }
    setPendingImages([]);
    setMentionDropdown(false);
    setChatReplyTo(null);

    // Mark this conv as sending (skip for DM — instant DB write, no LLM wait)
    const isDm = volatile.chatMode === 'dm';
    incrementSending(sendKey);
    // Initialize activity buffer keyed by session (not convKey) to prevent cross-session pollution
    const actBufKey = volatile.activeSessionId ?? sendKey;
    actBuffers.set(actBufKey, []);
    if (currentConvKeyRef.current === sendKey && !isDm) {
      setSending(true);
      setActivities([]);
    }

    if (volatile.chatMode === 'dm') {
      // Human-to-human DM or personal notepad — store only, never route to agents/LLM.
      const dmChannel = makeDmChannel(volatile.authUser?.id ?? '', volatile.activeDmUserId);
      const optId = `opt_${Date.now()}`;
      const userMsgDm: ChatMsg = { id: optId, sender: 'user', text, time: new Date().toLocaleTimeString(), rawCreatedAt: new Date().toISOString() };
      if (imagesToSend?.length) userMsgDm.images = imagesToSend;
      if (replyCtx) { userMsgDm.replyToId = replyCtx.id; userMsgDm.replyToSender = replyCtx.sender; userMsgDm.replyToText = replyCtx.text; }
      updateConvMsgs(sendKey, prev => [...prev, userMsgDm]);
      try {
        const result = await api.channels.sendMessage(dmChannel, {
          text, senderName: volatile.authUser?.name ?? t('page.fallbackYou'),
          senderId: volatile.authUser?.id,
          mentions: [], orgId: 'default',
          humanOnly: true, // never route to agents
          ...(imagesToSend?.length ? { images: imagesToSend } : {}),
          ...(fileNamesToSend?.length ? { fileNames: fileNamesToSend } : {}),
        });
        if (result.userMessage) addRecentMsgId(result.userMessage.id);
        updateConvMsgs(sendKey, prev => {
          const without = prev.filter(m => m.id !== optId);
          const newMsgs: ChatMsg[] = [];
          if (result.userMessage) newMsgs.push(channelMsgToChat(result.userMessage, volatile.authUser?.id));
          return newMsgs.length > 0 ? [...without, ...newMsgs] : prev;
        });
      } catch (e) {
        if (isMarkusCreditError(e)) dispatchCreditNotification();
        updateConvMsgs(sendKey, prev => {
          const without = prev.filter(m => m.id !== optId);
          return [...without, {
            id: `err_${Date.now()}`, sender: 'agent', text: t('page.errorWithMessage', { message: String(e) }),
            time: new Date().toLocaleTimeString(), agentName: t('page.systemName'), isError: true,
          }];
        });
      }
      decrementSending(sendKey);
      if (currentConvKeyRef.current === sendKey) setSending(false);
    } else if (volatile.chatMode === 'channel') {
      const optId = `opt_${Date.now()}`;
      const userMsgCh: ChatMsg = { id: optId, sender: 'user', text, time: new Date().toLocaleTimeString(), rawCreatedAt: new Date().toISOString() };
      if (replyCtx) { userMsgCh.replyToId = replyCtx.id; userMsgCh.replyToSender = replyCtx.sender; userMsgCh.replyToText = replyCtx.text; }
      updateConvMsgs(sendKey, prev => [...prev, userMsgCh]);

      // All agents in a group channel receive and process the message.
      // Mentioned agents are instructed to respond; others may stay silent.
      const mentions = parseMentionNames(text);
      const gc = volatile.groupChats.find(g => g.channelKey === volatile.activeChannel);
      if (volatile.activeChannel!.startsWith('group:')) {
        const allGroupAgents: Array<{ id: string; name: string; avatarUrl?: string }> = [];
        if (gc?.members) {
          for (const m of gc.members) {
            if (m.type === 'agent') {
              const a = volatile.agents.find(ag => ag.id === m.id);
              if (a) allGroupAgents.push({ id: a.id, name: a.name, avatarUrl: a.avatarUrl });
            }
          }
        }
        if (allGroupAgents.length > 0) {
          if (thinkingTimeoutRef.current) clearTimeout(thinkingTimeoutRef.current);
          setThinkingAgents(allGroupAgents);
          thinkingTimeoutRef.current = setTimeout(() => setThinkingAgents([]), 120_000);
        }
      }

      try {
        // Persist/send only the user's text. Reply context is carried via replyToId
        // (server prefixes [REPLY] for the agent; UI shows the quote header from metadata).
        const result = await api.channels.sendMessage(volatile.activeChannel!, {
          text, senderName: volatile.authUser?.name ?? t('page.fallbackYou'), mentions,
          senderId: volatile.authUser?.id,
          orgId: 'default',
          replyToId: replyCtx?.id,
          ...(imagesToSend?.length ? { images: imagesToSend } : {}),
          ...(fileNamesToSend?.length ? { fileNames: fileNamesToSend } : {}),
        });
        if (result.userMessage) addRecentMsgId(result.userMessage.id);
        if (result.agentMessage) addRecentMsgId(result.agentMessage.id);
        updateConvMsgs(sendKey, prev => {
          const without = prev.filter(m => m.id !== optId);
          const newMsgs: ChatMsg[] = [];
          if (result.userMessage) newMsgs.push(channelMsgToChat(result.userMessage, volatile.authUser?.id));
          if (result.agentMessage) newMsgs.push(channelMsgToChat(result.agentMessage, volatile.authUser?.id));
          return newMsgs.length > 0 ? [...without, ...newMsgs] : prev;
        });
      } catch (e) {
        if (isMarkusCreditError(e)) dispatchCreditNotification();
        const friendly = friendlyAgentError(e, t) || t('page.errorWithMessage', { message: String(e) });
        updateConvMsgs(sendKey, prev => [...prev, {
          id: `err_${Date.now()}`, sender: 'agent', text: friendly,
          time: new Date().toLocaleTimeString(), agentName: t('page.systemName'), isError: true,
        }]);
        if (thinkingTimeoutRef.current) { clearTimeout(thinkingTimeoutRef.current); thinkingTimeoutRef.current = null; }
        setThinkingAgents([]);
      }
      decrementSending(sendKey);
      if (currentConvKeyRef.current === sendKey) setSending(false);
    } else {
      // direct — build an interleaved segment stream
      beginStream(sendKey);
      const sendNonce = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const agentMsgId = `a_${sendNonce}`;
      const optimisticUserId = `u_${sendNonce}`;
      // Mutable session ID that gets resolved when session_start event arrives
      let streamSessionId: string | null = options?.sessionIdOverride
        ?? (volatile.activeSessionId === NEW_CHAT_PLACEHOLDER_ID ? null : (volatile.activeSessionId ?? null));
      if (options?.isResume) {
        // Resume: don't add a duplicate user message — just append the
        // agent continuation placeholder after the existing partial response.
        const agentCreatedAt = new Date().toISOString();
        updateConvMsgs(sendKey, prev => [
          ...prev,
          { id: agentMsgId, sender: 'agent', text: '', time: new Date().toLocaleTimeString(), rawCreatedAt: agentCreatedAt, segments: [], isStreaming: true },
        ], streamSessionId);
      } else {
        const agentCreatedAt = new Date().toISOString();
        const userMsg: ChatMsg = { id: optimisticUserId, sender: 'user', text, time: new Date().toLocaleTimeString(), rawCreatedAt: agentCreatedAt };
        if (imagesToSend?.length) userMsg.images = imagesToSend;
        if (replyCtx) { userMsg.replyToId = replyCtx.id; userMsg.replyToSender = replyCtx.sender; userMsg.replyToText = replyCtx.text; }
        updateConvMsgs(sendKey, prev => [
          ...prev,
          userMsg,
          { id: agentMsgId, sender: 'agent', text: '', time: new Date().toLocaleTimeString(), rawCreatedAt: agentCreatedAt, segments: [], isStreaming: true },
        ], streamSessionId);
      }

      /**
       * Append a text chunk to the segment stream (RAF-batched to reduce re-renders).
       * `chunk` is answer prose only — reasoning arrives via onThinking.
       */
      const appendTextChunk = (chunk: string) => {
        lastSseEventTimeRef.current = Date.now();
        updateConvMsgsRaf(sendKey, prev => {
          const u = [...prev];
          const idx = u.findIndex(m => m.id === agentMsgId);
          if (idx < 0) return prev;
          const msg = u[idx]!;
          u[idx] = { ...msg, text: (msg.text ?? '') + chunk, segments: appendTextToSegments(msg.segments ?? [], chunk) };
          return u;
        }, streamSessionId);
      };

      /** Append a raw reasoning chunk (structured event — no inline tags to parse). */
      const appendThinkingChunk = (chunk: string) => {
        lastSseEventTimeRef.current = Date.now();
        updateConvMsgsRaf(sendKey, prev => {
          const u = [...prev];
          const idx = u.findIndex(m => m.id === agentMsgId);
          if (idx < 0) return prev;
          const msg = u[idx]!;
          u[idx] = { ...msg, segments: appendThinkingToSegments(msg.segments ?? [], chunk) };
          return u;
        }, streamSessionId);
      };

      /** Handle server-committed per-turn text/thinking entries (clean, non-fragmented) */
      const handleCommitEvent = (event: StreamCommitEvent) => {
        lastSseEventTimeRef.current = Date.now();
        // Capture sessionId early so subsequent messages continue in the same session
        // even if the stream is aborted before the final 'done' event.
        if (event.type === 'session_start' && event.sessionId) {
          // Resolve the stream's session ID — replace placeholder with real ID
          const prevStreamSessionId = streamSessionId;
          streamSessionId = event.sessionId;
          // A new stream started in this session — clear any earlier user-stop.
          userStoppedSessionsRef.current.delete(event.sessionId);
          if (prevStreamSessionId && prevStreamSessionId !== event.sessionId) {
            clearStreamSession(sendKey, prevStreamSessionId);
          }
          setStreamSession(sendKey, event.sessionId);
          // Replace optimistic user id with the server-persisted id so reload/dedupe align.
          if (event.userMessageId && !options?.isResume) {
            updateConvMsgs(sendKey, prev => prev.map(m =>
              m.id === optimisticUserId ? { ...m, id: event.userMessageId! } : m
            ), event.sessionId);
          }
          // 占位 buffer 的提升由 setActiveSession 统一负责（见 promotePlaceholder）——
          // 不再需要手工把显示缓冲拷贝进一份单独的 session 缓存。
          if (currentConvKeyRef.current === sendKey) {
            // Only update activeSessionId if this stream's session matches what user expects.
            // If user was on __new_chat__ or the same session, update. Otherwise skip to
            // prevent a different session's stream from hijacking the user's view.
            const currentSess = volatile.activeSessionId;
            if (!currentSess || currentSess === NEW_CHAT_PLACEHOLDER_ID || currentSess === event.sessionId) {
              setActiveSessionId(event.sessionId);
              // NOTE: do NOT write `activeSessionBuffer` here. That map IS the manager's
              // view pointer, and `setActiveSession` below is its single writer: it is what
              // performs placeholder promotion. Writing the pointer first makes
              // `setActiveSession`'s `cur === sessionId` guard short-circuit and skip the
              // promotion, so the optimistic rows under `__new_chat__` are orphaned — the
              // user's own message disappears and the reply never streams (H4).
              setActiveSession(sendKey, event.sessionId);
              promoteStreamCtl(event.sessionId);
              if (volatile.selectedAgent) setStoredActiveSession(volatile.selectedAgent, event.sessionId);
              setOpenSessionTabs(prev => {
                // Replace placeholder if exists; otherwise ensure the session tab is present
                if (prev.some(t => t.id === NEW_CHAT_PLACEHOLDER_ID)) {
                  return prev.map(t => t.id === NEW_CHAT_PLACEHOLDER_ID ? { ...t, id: event.sessionId! } : t);
                }
                if (!prev.some(t => t.id === event.sessionId)) {
                  return [...prev, { id: event.sessionId!, agentId: volatile.selectedAgent ?? '', userId: null, title: '', createdAt: new Date().toISOString(), lastMessageAt: new Date().toISOString() }];
                }
                return prev;
              });
            }
          }
          return;
        }
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
        }, streamSessionId);
      };

      /** Handle a tool event: start adds a 'running' segment, end updates it, output appends live text */
      const handleToolEvent = (event: AgentToolEvent) => {
        lastSseEventTimeRef.current = Date.now();
        if (event.phase === 'heartbeat') return;
        if (event.phase === 'start' || event.phase === 'end') {
          appendConvActivity(sendKey, { ...event, phase: event.phase, ts: Date.now() }, streamSessionId);
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
            const committed = [...(u[idx]!.committedSegments ?? [])];
            if (event.arguments !== undefined) {
              committed.push({ type: 'tool', key: toolKey, tool: event.tool, status: 'running', args: event.arguments, createdAt: now });
            }
            u[idx] = { ...u[idx]!, segments: segs, committedSegments: committed };
            return u;
          }, streamSessionId);
        } else if (event.phase === 'output') {
          // RAF-batch high-frequency stdout chunks (same as text deltas).
          updateConvMsgsRaf(sendKey, prev => {
            const u = [...prev];
            const idx = u.findIndex(m => m.id === agentMsgId);
            if (idx < 0) return prev;
            const segs = [...(u[idx]!.segments ?? [])];
            for (let i = segs.length - 1; i >= 0; i--) {
              const s = segs[i]!;
              if (s.type === 'tool' && s.tool === event.tool && s.status === 'running') {
                segs[i] = { ...s, liveOutput: appendLiveOutput(s.liveOutput, event.output ?? '') };
                break;
              }
            }
            u[idx] = { ...u[idx]!, segments: segs };
            return u;
          }, streamSessionId);
        } else if (event.phase === 'subagent_progress' && event.subagentEvent) {
          // RAF-batch nested progress; cap retained rows so long sub-agents don't balloon DOM.
          updateConvMsgsRaf(sendKey, prev => {
            const u = [...prev];
            const idx = u.findIndex(m => m.id === agentMsgId);
            if (idx < 0) return prev;
            const appendLog = (list: MsgSegment[]): MsgSegment[] => {
              const next = [...list];
              for (let i = next.length - 1; i >= 0; i--) {
                const s = next[i]!;
                if (s.type === 'tool' && (s.tool === 'spawn_subagent' || s.tool === 'spawn_subagents') && s.status === 'running') {
                  next[i] = { ...s, subagentLogs: appendSubagentLog(s.subagentLogs, event.subagentEvent!) };
                  break;
                }
              }
              return next;
            };
            const segs = appendLog(u[idx]!.segments ?? []);
            const committed = appendLog(u[idx]!.committedSegments ?? []);
            u[idx] = { ...u[idx]!, segments: segs, committedSegments: committed };
            return u;
          }, streamSessionId);
        } else {
          updateConvMsgs(sendKey, prev => {
            const u = [...prev];
            const idx = u.findIndex(m => m.id === agentMsgId);
            if (idx < 0) return prev;
            const now = new Date().toISOString();
            const segs = [...(u[idx]!.segments ?? [])];
            let endedSubagentLogs: Extract<MsgSegment, { type: 'tool' }>['subagentLogs'];
            for (let i = segs.length - 1; i >= 0; i--) {
              const s = segs[i]!;
              if (s.type === 'tool' && s.tool === event.tool && s.status === 'running') {
                endedSubagentLogs = s.subagentLogs;
                segs[i] = { ...s, status: event.success === false ? 'error' : 'done', args: event.arguments, result: event.result, error: event.error, durationMs: event.durationMs, liveOutput: undefined, createdAt: now };
                break;
              }
            }
            const committed = [...(u[idx]!.committedSegments ?? [])];
            for (let i = committed.length - 1; i >= 0; i--) {
              const s = committed[i]!;
              if (s.type === 'tool' && s.tool === event.tool && s.status === 'running') {
                // Prefer logs accumulated on the live segment (progress may have
                // arrived before this committed row existed).
                committed[i] = {
                  ...s,
                  status: event.success === false ? 'error' : 'done',
                  args: event.arguments,
                  result: event.result,
                  error: event.error,
                  durationMs: event.durationMs,
                  liveOutput: undefined,
                  createdAt: now,
                  subagentLogs: endedSubagentLogs ?? s.subagentLogs,
                };
                break;
              }
            }
            u[idx] = { ...u[idx]!, segments: segs, committedSegments: committed };
            return u;
          }, streamSessionId);
        }
      };

      const abortCtrl = new AbortController();
      // 按「这次发送所在的会话」登记，interrupt 时才能精确命中它。
      streamCtrlsRef.current.set(
        stateRef.current.activeSessionId ?? NEW_CHAT_PLACEHOLDER_ID,
        abortCtrl,
      );
      // Same source as streamSessionId's initial value (formula deduped — the
      // async session_start resolution happens only inside messageStream below,
      // so this snapshot always equals the initial streamSessionId).
      const effectiveSessionId = streamSessionId;
      const streamSessionAtStart = effectiveSessionId;
      // A fresh user turn cancels any earlier stop — reattach may resume if the
      // stream drops while THIS turn is still generating.
      if (streamSessionAtStart) userStoppedSessionsRef.current.delete(streamSessionAtStart);
      // Add this session to the set of actively streaming sessions for this agent.
      if (streamSessionAtStart) {
        setStreamSession(sendKey, streamSessionAtStart);
      }

      try {
        lastSseEventTimeRef.current = Date.now();
        // Persist/send only the user's text. Reply context goes via replyTo metadata
        // so reload does not show the quoted agent message inside the user bubble.
        const streamResult = await api.agents.messageStream(
          volatile.selectedAgent!, text,
          {
            onChunk: appendTextChunk,
            onThinking: appendThinkingChunk,
            onActivity: handleToolEvent,
            onCommit: handleCommitEvent,
          },
          {
            signal: abortCtrl.signal,
            images: imagesToSend,
            sessionId: effectiveSessionId,
            isRetry: options?.isRetry,
            isResume: options?.isResume,
            fileNames: fileNamesToSend,
            replyTo: replyCtx,
          },
        );
        if (currentConvKeyRef.current === sendKey) {
          // Message was merged into the agent's active processing — remove the
          // empty agent placeholder and the follow-up user bubble (server also
          // deletes that DB row so reload won't resurrect it).
          if (streamResult.merged) {
            updateConvMsgs(sendKey, prev => prev.filter(m =>
              m.id !== agentMsgId && m.id !== optimisticUserId
            ), streamSessionId);
          }

          // Apply server's authoritative final segments and content so the
          // rendered state matches the DB-persisted data.  This prevents a
          // blank bubble when delta-built segments have empty content (e.g.
          // thinking-only responses before text_delta arrives).
          if (!streamResult.merged && streamResult.segments?.length) {
            updateConvMsgs(sendKey, prev => {
              const u = [...prev];
              const idx = u.findIndex(m => m.id === agentMsgId);
              if (idx < 0) return prev;
              const finalSegs = storedSegmentsToMsgSegments(streamResult.segments!, u[idx]!.segments);
              let finalText = streamResult.content || u[idx]!.text;
              if (!finalText) {
                finalText = finalSegs
                  .filter(s => s.type === 'text')
                  .map(s => (s as { content: string }).content)
                  .join('');
              }
              const empty = !finalText?.trim() && !finalSegs.some(s =>
                (s.type === 'text' && (s.content || s.thinking)) || s.type === 'tool'
              );
              u[idx] = {
                ...u[idx]!,
                text: finalText,
                segments: finalSegs,
                committedSegments: finalSegs,
                isStopped: streamResult.cancelled || u[idx]!.isStopped,
                emptyReply: streamResult.emptyReply || empty || undefined,
                isError: streamResult.emptyReply || empty ? true : u[idx]!.isError,
              };
              return u;
            }, streamSessionId);
          }

          // Fallback for pure text responses where the server sends text_commit
          // events (no text_delta, no done.segments) — build final segments
          // from the committedSegments that were accumulated during streaming.
          if (!streamResult.merged && !streamResult.segments?.length) {
            updateConvMsgs(sendKey, prev => {
              const u = [...prev];
              const idx = u.findIndex(m => m.id === agentMsgId);
              if (idx < 0) return prev;
              const msg = u[idx]!;
              const committed = msg.committedSegments ?? [];
              const committedText = committed
                .filter((s): s is MsgSegment & { type: 'text' } => s.type === 'text' && !!s.content)
                .map(s => s.content)
                .join('');
              const finalText = committedText || streamResult.content || msg.text;
              const empty = !finalText?.trim() && committed.length === 0;
              if (committed.length > 0 || finalText || streamResult.cancelled || streamResult.emptyReply || empty) {
                u[idx] = {
                  ...msg,
                  text: finalText,
                  segments: committed.length > 0 ? committed : msg.segments,
                  isStopped: streamResult.cancelled || msg.isStopped,
                  emptyReply: streamResult.emptyReply || empty || undefined,
                  isError: (streamResult.emptyReply || empty) ? true : msg.isError,
                };
              }
              return u;
            }, streamSessionId);
          }

          if (streamResult.sessionId) {
            // Only update active session if user hasn't switched to a different session
            setActiveSessionId(prev => {
              if (!prev || prev === NEW_CHAT_PLACEHOLDER_ID || prev === streamResult.sessionId) {
                return streamResult.sessionId!;
              }
              return prev;
            });
            // Keep the manager's routing gate in sync (see session_start): only
            // re-pin when this stream still owns the currently-viewed session.
            const curSess = activeSessionBuffer.get(sendKey);
            if (!curSess || curSess === NEW_CHAT_PLACEHOLDER_ID || curSess === streamResult.sessionId) {
              setActiveSession(sendKey, streamResult.sessionId);
              promoteStreamCtl(streamResult.sessionId);
            }
            setOpenSessionTabs(prev => {
              // Replace placeholder if exists
              if (prev.some(t => t.id === NEW_CHAT_PLACEHOLDER_ID)) {
                return prev.map(t => t.id === NEW_CHAT_PLACEHOLDER_ID ? { ...t, id: streamResult.sessionId! } : t);
              }
              // Deduplicate: don't add if already present
              if (prev.some(t => t.id === streamResult.sessionId)) return prev;
              return [...prev, { id: streamResult.sessionId!, agentId: volatile.selectedAgent ?? '', userId: null, title: '', createdAt: new Date().toISOString(), lastMessageAt: new Date().toISOString() }];
            });
          }
          loadSessions(volatile.selectedAgent!).then(s => {
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

          // Soft disconnect (refresh / browser killing the SSE): the fetch ends
          // without a terminal `done`, but the agent may still be running. Keep
          // nested subagent progress and reattach instead of freezing the bubble.
          const resumeSessionId = streamResult.sessionId
            ?? (streamSessionAtStart && streamSessionAtStart !== NEW_CHAT_PLACEHOLDER_ID
              ? streamSessionAtStart
              : null);
          if (
            !abortCtrl.signal.aborted
            && !streamResult.merged
            // Soft disconnect: the transport ended without a terminal `done`
            // (explicit flag, with the legacy `segments === undefined` as fallback).
            && (streamResult.softDisconnected ?? (streamResult.segments === undefined))
            && volatile.chatMode === 'direct'
            && volatile.selectedAgent
            && resumeSessionId
          ) {
            const resumeAgent = volatile.selectedAgent;
            // The server can be mid-transition when we ask, so retry a few times
            // with light backoff instead of giving up on the first answer.
            let attached = false;
            // 服务端已命名的在途回复 id —— 供下方 DB-heal 收尾做身份衔接。
            let resumeStatusMessageId: string | undefined;
            for (let attempt = 0; attempt < 4 && !attached; attempt += 1) {
              if (attempt > 0) await new Promise(r => setTimeout(r, 350 * attempt));
              if (abortCtrl.signal.aborted) break;
              try {
                const st = await api.sessions.streamStatus(resumeAgent, resumeSessionId);
                if (st.messageId) resumeStatusMessageId = st.messageId;
                // `active` stays true briefly after done/error (TTL) — only resume mid-run.
                if (st.status === 'streaming') {
                  updateConvMsgs(sendKey, prev => prev.map(m =>
                    m.id === agentMsgId
                      ? {
                          ...m,
                          isStreaming: true,
                          isStopped: false,
                          segments: (m.segments ?? []).map(s =>
                            s.type === 'tool' && (s.status === 'stopped' || s.status === 'running')
                              ? { ...s, status: 'running' as const }
                              : s,
                          ),
                        }
                      : m,
                  ), resumeSessionId);
                  decrementSending(sendKey);
                  dropStreamCtl(abortCtrl);
                  setStreamSession(sendKey, resumeSessionId);
                  // Balance OUR beginStream(sendKey) above before handing over to
                  // reattach — tryReattachActiveStream marks the agent streaming
                  // itself and will endStream it. Without this the refcount leaks
                  // +1 and the sidebar pins the agent to "working" after it stops.
                  endStream(sendKey);
                  void tryReattachActiveStream(resumeAgent, resumeSessionId, sendKey);
                  attached = true;
                  return;
                }
                // Turn already finished server-side while we were detached — the
                // persisted message is the source of truth, so stop retrying.
                if (st.status === 'done' || st.status === 'error' || st.status === 'stopped') break;
              } catch { /* keep retrying */ }
            }
            if (!attached && !abortCtrl.signal.aborted) {
              // Could not reattach. Reload the session so the bubble shows the
              // COMPLETE result instead of a truncated prefix — this automates the
              // "just refresh the page and it's fine" workaround.
              // 身份衔接（同上）：先把本地合成 id 收敛到服务端 messageId，使 DB heal
              // 复用同一行（React key 稳定），避免「半截气泡被整条替换」的闪烁。
              if (resumeStatusMessageId && agentMsgId) {
                updateConvMsgs(sendKey, prev => alignStreamedAgentId(prev, agentMsgId, resumeStatusMessageId), resumeSessionId);
              }
              try {
                const loaded = await loadSessionMessages(resumeSessionId, sendKey);
                if (loaded > 0) {
                  decrementSending(sendKey);
                  dropStreamCtl(abortCtrl);
                  endStream(sendKey);
                  return;
                }
              } catch { /* fall through to normal cleanup */ }
            }
          }
        }
        // 身份对齐（重复气泡根因）：把本地流式气泡的**合成 id** 收敛到服务端持久化
        // messageId。必须与「当前在看哪个会话」**解耦**——一次回合完全可能在你切到
        // 别的会话 / 标签之后才收到 done（那时上面整段 done 处理被视图门控跳过），或
        // 回复由 reattach / poll 恢复。只看视图会漏掉这些路径，本地气泡便带着合成 id
        // 留下；随后的 DB 加载按 id 相等去重失败 → 同一回复两个气泡（且陈旧副本会被
        // 按乐观发送时刻错插到它的用户消息之前）。路由走 streamSessionId（会话自身），
        // 与视图无关；仅当会话尚未解析、无法按会话路由时，才退回视图判据。
        if (!streamResult.merged
          && (streamSessionId || currentConvKeyRef.current === sendKey)) {
          updateConvMsgs(
            sendKey,
            prev => alignStreamedAgentId(prev, agentMsgId, streamResult.messageId),
            streamSessionId,
          );
        }
      } catch (e) {
        // Preserve sessionId from error so subsequent messages stay in the same session
        const errSessionId = (e as Error & { sessionId?: string })?.sessionId;
        if (errSessionId && volatile.chatMode === 'direct' && currentConvKeyRef.current === sendKey) {
          setActiveSessionId(errSessionId);
          // Keep the routing gate in sync with the resolved session id so a
          // later reattach cannot mix this stream into another session's buffer.
          setActiveSession(sendKey, errSessionId);
          promoteStreamCtl(errSessionId);
          setOpenSessionTabs(prev =>
            prev.map(t => t.id === NEW_CHAT_PLACEHOLDER_ID ? { ...t, id: errSessionId } : t)
          );
          loadSessions(volatile.selectedAgent!).then(s => {
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

        if (isMarkusCreditError(e)) dispatchCreditNotification();

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
          }, streamSessionId);
        } else {
          // User cancelled — keep partial content and mark as stopped
          updateConvMsgs(sendKey, prev => {
            const u = [...prev];
            const idx = u.findIndex(m => m.id === agentMsgId);
            if (idx >= 0) {
              const finalized = finalizeAgentMessage(u[idx]!, 'stopped');
              if (finalized === null) return prev.filter(m => m.id !== agentMsgId);
              u[idx] = finalized;
            }
            return u;
          }, streamSessionId);
        }
      }

      // Mark any still-running tool segments as stopped (stream ended due to
      // cancellation or disconnect). This block is the SINGLE convergence point
      // for every terminal path of a direct send(): done (with/without server
      // segments), error, soft-disconnect without reattach, SSE drop + poll
      // recovery. It must land the authoritative stream-end flag: the optimistic
      // placeholder carries isStreaming: true and nothing else in this flow
      // resets it — if it stayed true the bubble would render as a perpetual
      // "thinking…" (isStreamingMsg = ... || !!msg.isStreaming) and the sidebar
      // busy mark would hold via hasStreamingTail. See finalizeStreamEnd.
      updateConvMsgs(sendKey, prev => finalizeStreamEnd(prev, agentMsgId), streamSessionId);

      // If stream was aborted by user (api resolves rather than rejects on abort) —
      // keep partial content and mark as stopped. The catch block handles the rejection path.
      if (abortCtrl.signal.aborted) {
        updateConvMsgs(sendKey, prev => {
          const u = [...prev];
          const idx = u.findIndex(m => m.id === agentMsgId);
          if (idx >= 0) {
            const finalized = finalizeAgentMessage(u[idx]!, 'stopped');
            if (finalized === null) return prev.filter(m => m.id !== agentMsgId);
            u[idx] = finalized;
          }
          return u;
        }, streamSessionId);
      }

      // Fallback: if the agent message is empty (SSE connection may have dropped),
      // poll the session messages to recover the persisted reply.
      // Use the actual session ID from the stream result (or activeSessionId) instead
      // of blindly fetching the "latest" session which could be a different conversation.
      const currentMsgs = readConvMsgs(sendKey) ?? [];
      const agentMsg = currentMsgs.find(m => m.id === agentMsgId);
      const pollSessionId = volatile.activeSessionId && volatile.activeSessionId !== NEW_CHAT_PLACEHOLDER_ID ? volatile.activeSessionId : null;
      const hasVisibleContent = agentMsg ? msgHasContent(agentMsg) : false;
      if (agentMsg && !hasVisibleContent && volatile.chatMode === 'direct' && pollSessionId && !abortCtrl.signal.aborted) {
        // 指数退避 + 抖动 + 重试上限：SSE 断连后从 DB 恢复回复，避免紧密死循环轮询，
        // 也避免所有客户端同时狂轮。见 lib/streamResilience.ts。
        const pollForReply = async (retries: number, baseDelayMs: number) => {
          for (let i = 0; i < retries; i++) {
            const delay = exponentialBackoffDelay(i, { baseMs: baseDelayMs, maxMs: 8000, maxAttempts: retries });
            await new Promise(r => setTimeout(r, delay));
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
                }, streamSessionId);
                // The DB row we recovered is the authoritative identity — converge
                // the optimistic bubble's id to it so a later load dedups by id.
                updateConvMsgs(sendKey, prev => alignStreamedAgentId(prev, agentMsgId, recovered.id), streamSessionId);
                return;
              }
            } catch { /* retry */ }
          }
        };
        // Await polling so `sending` stays true (and the streaming animation
        // remains visible) while we recover the reply from the DB.
        await pollForReply(5, 2000);
      }

      // Only clean up if this invocation is still the active sender.
      // When a newer send() has taken over (user interrupted), abortControllerRef
      // already points to the new controller — skip cleanup to avoid killing
      // the new stream's state.
      const newCount = decrementSending(sendKey);
      // P1-14：无论 sessionId 是否已解析都要解除 busy。旧代码 `if (streamSessionId)`
      // 在「新会话首包前失败」（sessionId 仍为 null）时跳过清理，侧栏永久「工作中」，
      // 刷新/切页/reattach 均不自愈。
      //
      // BUT never with `undefined`: that is the WHOLE-KEY release, and the key is
      // the AGENT (several session tabs of one agent share it). A turn that ends
      // without a resolved session id — the new-chat tab, or a message the server
      // MERGED into the agent's in-flight processing (no session_start for it) —
      // would then wipe a SIBLING tab's live mark. chatStore drops to idle, the
      // buffer manager still reports the conversation as streaming, and the two
      // answers disagree: the sibling tab's bubble is a "ghost" by chatStore and
      // gets swept (border + 输出中 die) while the backend keeps generating. The
      // unresolved turn can only ever own the placeholder mark, so release that.
      clearStreamSession(sendKey, streamSessionId ?? NEW_CHAT_PLACEHOLDER_ID);
      endStream(sendKey);
      if ([...streamCtrlsRef.current.values()].includes(abortCtrl) || streamCtrlsRef.current.size === 0) {
        dropStreamCtl(abortCtrl);
        actBuffers.delete(streamSessionId ?? sendKey);
        if (currentConvKeyRef.current === sendKey) {
          setSending(newCount > 0);
          if (newCount === 0) setActivities([]);
        }
      } else {
        actBuffers.delete(streamSessionId ?? sendKey);
      }
    }
  }, [appendConvActivity, beginStream, clearStreamSession, currentConvKeyRef, decrementSending, endStream, incrementSending, loadSessions, readConvMsgs, setSending, setStreamSession, stateRef, updateConvMsgs, updateConvMsgsRaf]);

  return {
    send,
    stopSending,
    tryReattachActiveStream,
    loadSessionMessages,
  };
}