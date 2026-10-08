/**
 * ConversationBufferManager — Pure state machine for per-conversation message
 * buffer management. Zero React dependency; fully unit-testable.
 *
 * ## 模型：一个存储 + 一根指针
 *
 * 消息只有**一份**存储：`buffers: bufferId → ChatMsg[]`。
 * `bufferId` = 会话 id（会话态视图，如 direct 模式的某个 session tab）；
 * 没有会话概念的对话（`ch:*` / `dm:*`）退化为 convKey。
 *
 * `view: convKey → bufferId` **只是一根指针**，表示"这个对话现在在看哪个 buffer"。
 *
 * 于是"显示什么"是**投影**：`display(convKey) = buffers[view(convKey)]`。
 *
 * ## 为什么是这个模型（历史教训）
 *
 * 旧实现是**两个存储**：一份按 convKey 的共享"显示缓冲"，一份按 sessionId 的缓存，
 * 中间再插一道手工维护的**路由门**（`activeSession`）+ 切 tab 时的 save/restore。
 * 由此长出一族补偿机制：`isDisplayRoute`、`isCacheFresher`、`pinnedToOtherSession`、
 * `otherSessionStreaming`、`placeholderTurnBelongsTo`、save/restore……
 * 它们全部只为一件事服务：**猜"这份共享缓冲现在算谁的"。**
 *
 * 猜错就出这些 bug：
 *   - 后台会话的流把内容混进正在看的 tab（气泡漂移/错序/空白）；
 *   - 别的 tab 的 `session_start` 抢走路由门 → 正在看的 tab 增量写进缓存，
 *     气泡突然不动了（"看起来断了，其实服务端还在跑"）；
 *   - 一个 tab 的回合结束去清 Agent 级标记 → 兄弟 tab 被判死。
 *
 * 现在**跨会话污染在类型上就不可表达**：一条流的每一次写入都只可能落在
 * 它自己会话的 buffer 上，没有"这份缓冲算谁的"这个问题，所以也不需要任何补偿机制。
 *
 * 不变量：`buffers[id]` 只由 `id` 所属的会话/对话写入；`view` 只被用户显式切换
 * 或占位→真实 id 的**提升**改写。
 */
import type { ChatMsg, ChatMode } from '../pages/ChatHelpers.ts';
import type { ActivityStep } from '../components/ActivityIndicator.tsx';
import type { ChatSessionInfo } from '../api.ts';

export type ConvPhase = 'idle' | 'loading' | 'ready' | 'streaming';

/**
 * READ-ONLY projection of the view pointer (`convKey → bufferId`).
 *
 * Deliberately exposes `get` only. The pointer has exactly one legitimate writer —
 * `setActiveSession` — because that method also performs **placeholder promotion**
 * (folding the `__new_chat__` buffer into the real session when the server assigns
 * an id). A raw `view.set()` bypasses it: `setActiveSession`'s first line is
 * `if (cur === sessionId) return`, so writing the pointer first makes it return
 * early and SKIP promotion — silently turning the promotion logic into dead code.
 * That is exactly the H4 regression (a brand-new chat's first message vanished and
 * never streamed until the turn ended). Keeping the map private makes the bypass
 * unrepresentable rather than merely discouraged.
 */
export interface ActiveSessionView {
  get(key: string): string | undefined;
}

export interface BufferWriteResult {
  displayChanged: boolean;
  newMessages?: ChatMsg[];
}

export interface ActivityWriteResult {
  displayChanged: boolean;
  newActivities?: ActivityStep[];
}

/**
 * 一个会话**窗口的边界**：还能往前翻吗（`hasMore`）、从哪儿翻（`oldestCursor`）。
 *
 * 它与窗口的**内容**（`buffers[id]`）是同一个事实的两半，所以必须**同一个 key**。
 */
export interface WindowBounds {
  hasMore: boolean;
  /** 下一页游标 = 该 buffer 已加载的最早一条消息的时间；null = 没有更早的了。 */
  oldestCursor: string | null;
}

export function makeConvKey(mode: ChatMode, agent: string, channel: string, dmUserId?: string): string {
  return mode === 'channel' ? `ch:${channel}` :
    mode === 'dm' ? `dm:${dmUserId ?? ''}` :
    (agent || '_direct');
}

/** 会话态视图（`direct`）才按 session 分 buffer；channel/dm 没有会话概念。 */
const isSessionScopedKey = (key: string): boolean =>
  !!key && !key.startsWith('ch:') && !key.startsWith('dm:') && key !== '_direct';

export class ConversationBufferManager {
  currentConvKey = '';
  loadingSession: string | null = null;

  /** 唯一消息存储：bufferId → messages。 */
  readonly buffers = new Map<string, ChatMsg[]>();
  /** convKey → 当前查看的 bufferId（**指针**，不是路由门）。 */
  private readonly view = new Map<string, string>();

  /** Stable, READ-ONLY projection of `view` (same object identity every access —
   *  an unstable identity here previously caused a 120-renders/s idle loop when it
   *  was used as an effect dependency). */
  private readonly viewReader: ActiveSessionView = { get: (key: string) => this.view.get(key) };

  /** Read the view pointer for `convKey`. Writing goes through the setters below. */
  get activeSessions(): ActiveSessionView { return this.viewReader; }
  readonly actBuffers = new Map<string, ActivityStep[]>();
  readonly sessionTabs = new Map<string, ChatSessionInfo[]>();

  /**
   * 窗口边界：`bufferId → { hasMore, oldestCursor }`。
   *
   * 为什么**必须**和消息存在同一个 key 上：一个会话窗口由「内容」与「边界」两半构成
   * （内容 = `buffers[id]`，边界 = 还能往前翻吗 / 从哪儿翻）。旧实现把内容放在这里
   * （per-buffer），却把边界放在 Team.tsx 的**全局** ref 里 —— 于是**任何**会话的加载都会
   * 覆盖当前视图的边界。用户报障「跨会话搜索，第一次正常，多试几次之后跳错 / 直接显示
   * 该会话最新消息」正是它：换 Agent 的 effect 会为「上次那个会话」发一次背景 soft-refresh，
   * 它与导航自己的加载**并发**，谁最后完成谁写边界；导航要跳的那条目标消息还没加载进来，
   * `loadMore` 的闸门却读到别人的 `hasMore=false` / `oldestCursor=null` → 一次都不翻 →
   * 判定「目标加载失败」→ 回到底部。
   *
   * 铁律：**边界的唯一写者是「加载这个 buffer 的那个请求」**；读侧（翻页闸门）只读这里，
   * 绝不读 React 派生值（见第五轮的教训）。切视图不需要"重置边界"—— 每个 buffer 自带边界。
   */
  private readonly windowBounds = new Map<string, WindowBounds>();

  /** 读「这个 buffer 的窗口边界」。权威、同步、per-buffer。无记录 = 没有更早的历史。 */
  getWindowBounds(bufferId: string): WindowBounds {
    return this.windowBounds.get(bufferId) ?? { hasMore: false, oldestCursor: null };
  }

  /** 写「这个 buffer 的窗口边界」。唯一写者：加载**这个 buffer** 的那个请求。 */
  setWindowBounds(bufferId: string, bounds: WindowBounds): void {
    this.windowBounds.set(bufferId, bounds);
  }

  private phase = new Map<string, ConvPhase>();
  /** 仅非会话态（channel/dm）仍用它：那里"会话 id"不存在，计数无歧义。 */
  private sendCount = new Map<string, number>();
  /** 正向归属记录：本对话下**正在飞**的会话集合。唯一的存活真相。 */
  private streamingSessions = new Map<string, Set<string>>();
  private bufferOrder: string[] = [];

  static readonly MAX_MESSAGES = 500;
  static readonly MAX_BUFFERS = 30;
  static readonly NEW_CHAT_ID = '__new_chat__';

  // ── Phase transitions ──

  /**
   * Effective phase for a conversation.
   *
   * The stored phase alone is NOT enough. `phase` is agent-level (one convKey =
   * one agent) while streams are tracked per SESSION, so with two tabs of the
   * same agent streaming at once, one turn finishing calls `endStream()` and
   * collapses the phase to 'ready' while the other turn is still live. Every
   * consumer that gated on the stored phase then declared the surviving turn
   * dead.
   *
   * So the stored phase is an OVERRIDE for the windows where the ownership
   * record cannot speak (pre-registration: `beginStream` flips the phase before
   * `session_start` lands the mark). Whenever the set is non-empty, it wins.
   */
  getPhase(key: string): ConvPhase {
    const stored = this.phase.get(key) ?? 'idle';
    if (stored === 'streaming') return stored;
    return this.hasLiveStream(key) ? 'streaming' : stored;
  }

  /**
   * Is at least one stream genuinely in flight for this conversation?
   * Single source of truth for both "is the agent busy" and the derived phase.
   */
  hasLiveStream(key: string): boolean {
    return (this.streamingSessions.get(key)?.size ?? 0) > 0;
  }

  beginLoad(key: string): void {
    if (this.getPhase(key) !== 'streaming') {
      this.phase.set(key, 'loading');
    }
  }

  completeLoad(key: string): void {
    if (this.getPhase(key) === 'loading') {
      this.phase.set(key, 'ready');
    }
  }

  beginStream(key: string): void {
    this.phase.set(key, 'streaming');
  }

  /** Collapse the phase to 'ready' for this turn's end (siblings keep it alive
   * via the ownership set — see getPhase). */
  endStream(key: string): void {
    if (this.getPhase(key) === 'streaming') {
      this.phase.set(key, 'ready');
    }
  }

  /** Clear a conversation back to empty idle, pointing the view at `repinTo`. */
  resetConv(key: string, repinTo?: string): void {
    this.phase.set(key, 'idle');
    const cur = this.view.get(key);
    if (cur) {
      this.buffers.delete(cur);
      // 事实与内容同生命周期：buffer 没了，它的窗口边界也必须没了，
      // 否则下一次进入这个 key 会拿到上一段的「还能往前翻」，指向一段不存在的历史。
      this.windowBounds.delete(cur);
    }
    this.actBuffers.delete(cur ?? key);
    this.actBuffers.delete(key);
    if (repinTo) this.view.set(key, repinTo);
    else this.view.delete(key);
  }

  // ── Message buffer writes ──

  /** Resolve the buffer a write belongs to. Not a policy decision — it is just
   *  "the session this write says it is, else the one being viewed". */
  private bufferIdFor(key: string, sessionId?: string | null): string {
    return sessionId ?? this.view.get(key) ?? key;
  }

  updateMessages(
    key: string,
    updater: (prev: ChatMsg[]) => ChatMsg[],
    sessionId?: string | null,
  ): BufferWriteResult {
    const id = this.bufferIdFor(key, sessionId);
    let next = updater(this.buffers.get(id) ?? []);
    if (next.length > ConversationBufferManager.MAX_MESSAGES) {
      next = next.slice(-ConversationBufferManager.MAX_MESSAGES);
    }
    this.buffers.set(id, next);
    this.touchBuffer(id);
    this.evictIfNeeded(id);

    // "Changed the display" is now simply: this buffer is the one being viewed.
    const displayChanged = this.currentConvKey === key && (this.view.get(key) ?? key) === id;
    return { displayChanged, newMessages: displayChanged ? next : undefined };
  }

  /**
   * Apply a DB load result for `sessionId`.
   *
   * The DB is the ordering authority; a live streaming tail is the only thing
   * the buffer may add. Under this model a load can ONLY touch its own
   * session's buffer, so a background tab's load can never replace the
   * transcript the user is watching — that class of bug is gone by construction.
   */
  applyLoadResult(convKey: string, sessionId: string, msgs: ChatMsg[]): BufferWriteResult {
    const prev = this.buffers.get(sessionId) ?? [];
    const streamLive = this.isStreamLiveForSession(convKey, sessionId);
    const merged = this.mergeDbWithCache(msgs, prev, streamLive);
    this.buffers.set(sessionId, merged);
    this.touchBuffer(sessionId);
    this.evictIfNeeded(sessionId);

    if (this.loadingSession === sessionId) this.completeLoad(convKey);

    const displayChanged = this.currentConvKey === convKey
      && (this.view.get(convKey) ?? convKey) === sessionId;
    return { displayChanged, newMessages: displayChanged ? merged : undefined };
  }

  /**
   * Build the buffer as: DB messages first (correct chronological order),
   * then any buffer-only rows (a streaming tail not yet persisted) inserted by
   * createdAt so late WS arrivals stay ordered. Duplicates by id are dropped.
   *
   * Ordering exception: LIVE-streaming agent bubbles are ALWAYS appended last.
   * Their rawCreatedAt is the OPTIMISTIC send time (earlier than the DB user
   * row's createdAt), so chronological insertion would place the in-flight
   * reply ABOVE the user message it answers.
   *
   * AUTHORITY RULE for agent rows: once a turn is over the DB is the sole
   * authority. A buffer-only agent row may therefore ONLY ever be the LIVE tail
   * of a stream still in flight. Any other buffer-only agent row is stale local
   * state whose id was never converged to the persisted messageId — the turn
   * ended while a different conversation was on screen, or the reply was
   * recovered by a reattach / poll (see `alignStreamedAgentId`), or the user
   * navigated away before `done`. It MUST be dropped rather than ordered: its
   * rawCreatedAt is the optimistic send time, so chronological insertion strands
   * a duplicate of the reply ABOVE its own user message (the "duplicate bubble
   * in front" report). The ONLY exception is a client-only terminal marker
   * (error / stopped / empty reply) — that carries the sole copy when a failure
   * never reached the DB, so it is kept.
   */
  private mergeDbWithCache(dbMsgs: ChatMsg[], buffered?: ChatMsg[], streamLive = false): ChatMsg[] {
    if (!buffered || buffered.length === 0) return [...dbMsgs];
    const byId = new Set<string>();
    const out: ChatMsg[] = [];
    for (const m of dbMsgs) {
      byId.add(m.id);
      out.push(m);
    }
    const streamingTail: ChatMsg[] = [];
    const rest: ChatMsg[] = [];
    // 本回合的持久化回复 = DB 的最后一条行（若为 agent）。在途气泡与它是同一回复的
    // 两个身份（本地合成 id `a_…` / `reattach_…` vs 持久化 messageId）：一个回合的
    // 回复只允许渲染一条。若两者 id 不同而都保留，就会看到「DB 的完成态快照」与
    // 「实时气泡」并排/互换 —— 这正是「流式时闪现一个完整气泡后直接进入结束态」的
    // 机制。合并规则：内容以**实时**为准（本地 deltas 领先于 DB 的 partial 快照），
    // 身份用**持久化 id**（React key 稳定 → 不再整条替换闪烁），DB 快照行移除。
    const dbTail = dbMsgs.length > 0 ? dbMsgs[dbMsgs.length - 1] : undefined;
    const dbTailIsAgentRow = !!dbTail && dbTail.sender === 'agent';
    let absorbedDbTailId = false;
    for (const cm of buffered) {
      if (byId.has(cm.id)) continue;
      if (cm.sender === 'agent') {
        const clientMarker = !!(cm.isError || cm.isStopped || cm.emptyReply);
        if (!clientMarker) {
          // DB is the sole authority for agent rows: only a LIVE tail survives.
          if (streamLive && cm.isStreaming) {
            if (dbTailIsAgentRow && dbTail && !absorbedDbTailId) {
              const i = out.findIndex(m => m.id === dbTail.id);
              if (i >= 0) out.splice(i, 1);
              absorbedDbTailId = true;
              streamingTail.push({ ...cm, id: dbTail.id });
              byId.add(dbTail.id);
            } else {
              streamingTail.push(cm);
              byId.add(cm.id);
            }
          }
          // else: stale local copy of an already-persisted reply → drop it.
          continue;
        }
        // client marker: keep (falls through to chronological insert below)
      }
      rest.push(cm);
    }
    for (const cm of rest) {
      if (byId.has(cm.id)) continue;
      const t = cm.rawCreatedAt ? Date.parse(cm.rawCreatedAt) : NaN;
      let i = out.length;
      while (i > 0 && out[i - 1]!.rawCreatedAt && Number.isFinite(t)) {
        const pt = Date.parse(out[i - 1]!.rawCreatedAt!);
        if (!Number.isFinite(pt) || pt <= t) break;
        i--;
      }
      out.splice(i, 0, cm);
      byId.add(cm.id);
    }
    for (const cm of streamingTail) out.push(cm);
    return out;
  }

  // ── Activity buffer ──

  appendActivity(key: string, step: ActivityStep, sessionId?: string | null): ActivityWriteResult {
    const bufKey = sessionId ?? key;
    const next = [...(this.actBuffers.get(bufKey) ?? []), step];
    this.actBuffers.set(bufKey, next);

    if (this.currentConvKey !== key) return { displayChanged: false };
    const viewed = this.view.get(key);
    if (!sessionId || !viewed || viewed === sessionId) {
      return { displayChanged: true, newActivities: next };
    }
    return { displayChanged: false };
  }

  // ── Session (view pointer) ──

  /** The buffer id currently viewed for this conversation. */
  getActiveSession(key: string): string | undefined {
    return this.view.get(key);
  }

  /**
   * Point the view at `sessionId`.
   *
   * One real job beyond assignment: **promote a placeholder buffer**. A turn
   * started from a fresh tab writes its optimistic rows under NEW_CHAT_ID
   * before the server assigns a real id; when `session_start` lands we must fold
   * that buffer into the real one and move the pointer, else the user bubble
   * stays behind under the placeholder and the tab looks half-empty.
   *
   * Never steals the view from another REAL session — a background stream
   * announcing its id must not yank the tab the user is reading.
   */
  setActiveSession(key: string, sessionId: string): void {
    const cur = this.view.get(key);
    if (cur === sessionId) return;
    if (cur === undefined || cur === ConversationBufferManager.NEW_CHAT_ID) {
      // Fold any placeholder rows in whenever we move OFF the placeholder —
      // including when the view was never explicitly pinned there (a fresh tab
      // can accumulate optimistic rows under NEW_CHAT_ID before the view is set).
      this.promotePlaceholder(sessionId);
      this.view.set(key, sessionId);
      return;
    }
    // View is pinned to a different real session: leave it alone.
  }

  /** Fold the NEW_CHAT placeholder buffer into the real session buffer. */
  private promotePlaceholder(sessionId: string): void {
    const placeholder = this.buffers.get(ConversationBufferManager.NEW_CHAT_ID);
    if (!placeholder || placeholder.length === 0) return;
    const target = this.buffers.get(sessionId) ?? [];
    const ids = new Set(target.map(m => m.id));
    const merged = [...target, ...placeholder.filter(m => !ids.has(m.id))];
    this.buffers.set(sessionId, merged);
    this.touchBuffer(sessionId);
    this.buffers.delete(ConversationBufferManager.NEW_CHAT_ID);
  }

  clearActiveSession(key: string): void {
    this.view.delete(key);
  }

  /**
   * Historically snapshotted the shared display buffer into a per-session cache.
   * There is no second store to snapshot any more — buffers are already keyed by
   * session — so this is intentionally a no-op kept for call-site compatibility.
   */
  saveToCache(): void { /* nothing to move: one store, one pointer */ }

  /**
   * Switch the view to `sessionId` and return its buffer.
   *
   * Stale `isStreaming` rows are dropped unless this session has a live stream,
   * so switching back never renders an old duplicate bubble at the tail.
   */
  restoreFromCache(key: string, sessionId: string): ChatMsg[] | undefined {
    if (isSessionScopedKey(key)) this.view.set(key, sessionId);
    const buffered = this.buffers.get(sessionId);
    if (!buffered || buffered.length === 0) return undefined;
    const live = this.isStreamLiveForSession(key, sessionId);
    if (live) return buffered;
    const usable = buffered.filter(m => !(m.sender === 'agent' && m.isStreaming && !m.isStopped));
    if (usable.length === 0) {
      this.buffers.delete(sessionId);
      return undefined;
    }
    this.buffers.set(sessionId, usable);
    return usable;
  }

  /**
   * Is a stream genuinely in flight for `sessionId` in this conversation?
   *
   * An EMPTY set during a `streaming` phase is the pre-registration window
   * (`beginStream` flips the phase before the session mark lands), so it must
   * NOT be read as "no stream".
   */
  private isStreamLiveForSession(convKey: string, sessionId: string): boolean {
    if (this.getPhase(convKey) !== 'streaming') return false;
    const set = this.streamingSessions.get(convKey);
    if (!set || set.size === 0) return true;
    if (set.has(sessionId)) return true;
    return this.placeholderTurnBelongsTo(convKey, sessionId);
  }

  /** A mark under the placeholder belongs to whichever session is being viewed. */
  private placeholderTurnBelongsTo(convKey: string, sessionId: string): boolean {
    const set = this.streamingSessions.get(convKey);
    if (!set || !set.has(ConversationBufferManager.NEW_CHAT_ID)) return false;
    return this.view.get(convKey) === sessionId;
  }

  // ── Send / stream tracking ──

  incrementSend(key: string): void {
    this.sendCount.set(key, (this.sendCount.get(key) ?? 0) + 1);
  }

  decrementSend(key: string): number {
    const n = Math.max(0, (this.sendCount.get(key) ?? 1) - 1);
    this.sendCount.set(key, n);
    return n;
  }

  resetSend(key: string): void {
    this.sendCount.set(key, 0);
  }

  isSending(key: string): boolean {
    return (this.sendCount.get(key) ?? 0) > 0;
  }

  /** Returns true when the membership actually changed (false = already present). */
  addStreamSession(key: string, sid: string): boolean {
    const s = this.streamingSessions.get(key) ?? new Set();
    if (s.has(sid)) {
      this.streamingSessions.set(key, s);
      return false;
    }
    s.add(sid);
    this.streamingSessions.set(key, s);
    return true;
  }

  /** Returns true when the membership actually changed (false = nothing to remove). */
  removeStreamSession(key: string, sid?: string): boolean {
    if (sid) {
      const s = this.streamingSessions.get(key);
      if (!s || !s.has(sid)) return false;
      s.delete(sid);
      if (s.size === 0) this.streamingSessions.delete(key);
      return true;
    }
    return this.streamingSessions.delete(key);
  }

  getStreamSessions(key: string): Set<string> | undefined {
    return this.streamingSessions.get(key);
  }

  /**
   * Single, idempotent teardown for ANY path that must stop the current
   * send/stream: user stop, double-submit retry, same-session interrupt,
   * channel abort, unmount. Safe to call when nothing is active — returns false
   * so callers can skip follow-up work.
   */
  abortStream(key: string, sessionId?: string | null): boolean {
    let affected = false;

    if ((this.sendCount.get(key) ?? 0) > 0) {
      this.sendCount.set(key, 0);
      affected = true;
    }

    const bufKey = sessionId ?? key;
    if (this.actBuffers.delete(bufKey)) affected = true;

    if (this.getPhase(key) === 'streaming') {
      this.phase.set(key, 'ready');
      affected = true;
    }

    if (sessionId) {
      const had = this.streamingSessions.get(key)?.has(sessionId) ?? false;
      this.removeStreamSession(key, sessionId);
      if (had) affected = true;
    } else if (this.streamingSessions.delete(key)) {
      affected = true;
    }

    return affected;
  }

  // ── Buffer reads ──

  /** The messages to render for this conversation (a projection of `view`). */
  getMessages(key: string): ChatMsg[] | undefined {
    return this.buffers.get(this.view.get(key) ?? key);
  }

  getActivities(bufKey: string): ActivityStep[] {
    return this.actBuffers.get(bufKey) ?? [];
  }

  deleteBuffer(id: string): void {
    this.buffers.delete(id);
    this.windowBounds.delete(id);
  }

  // ── Internal ──

  private viewBufferId(): string {
    const k = this.currentConvKey;
    return this.view.get(k) ?? k;
  }

  private evictIfNeeded(currentId: string): void {
    if (this.buffers.size <= ConversationBufferManager.MAX_BUFFERS) return;
    const keep = this.viewBufferId();
    for (const k of [...this.buffers.keys()]) {
      if (this.buffers.size <= ConversationBufferManager.MAX_BUFFERS) break;
      if (k === currentId || k === keep) continue;
      this.buffers.delete(k);
      this.actBuffers.delete(k);
      this.windowBounds.delete(k);
    }
  }

  /** Track a buffer write for LRU eviction (oldest first, viewed buffer kept). */
  touchBuffer(id: string): void {
    const idx = this.bufferOrder.indexOf(id);
    if (idx !== -1) this.bufferOrder.splice(idx, 1);
    this.bufferOrder.push(id);

    while (this.bufferOrder.length > ConversationBufferManager.MAX_BUFFERS) {
      const oldest = this.bufferOrder.shift()!;
      const keep = new Set([this.viewBufferId(), ...this.view.values()]);
      if (keep.has(oldest)) {
        this.bufferOrder.push(oldest);
        break;
      }
      this.buffers.delete(oldest);
      this.actBuffers.delete(oldest);
      this.windowBounds.delete(oldest);
    }
  }
}
