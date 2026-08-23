import type { AgentToolHandler } from '../agent.js';
import { createLogger, getTextContent } from '@markus/shared';
import type { IMemoryStore } from '../memory/types.js';

const log = createLogger('session-tools');

export interface SessionRow {
  id: string;
  agentId: string;
  userId?: string | null;
  title?: string | null;
  isMain?: boolean;
  createdAt?: string | Date;
  lastMessageAt?: string | Date;
  [k: string]: unknown;
}

export interface SessionMsgRow {
  id: string;
  sessionId: string;
  agentId?: string;
  role?: string;
  content?: string;
  createdAt?: string | Date;
  [k: string]: unknown;
}

/** 存储层查询能力的最小契约（由 SqliteChatSessionRepo 满足）。 */
export interface SessionRepo {
  listSessionsPaginated(
    agentId: string,
    opts: { since?: string; until?: string; userId?: string; page?: number; pageSize?: number },
  ): {
    sessions: SessionRow[];
    total: number;
    page: number;
    pageSize: number;
    hasMore: boolean;
  };
  getSession(sessionId: string): SessionRow | null | undefined;
  listMessagesPaginated(
    sessionId: string,
    opts: { since?: string; until?: string; page?: number; pageSize?: number },
  ): {
    messages: SessionMsgRow[];
    total: number;
    page: number;
    pageSize: number;
    hasMore: boolean;
  };
  /** 统计某 session 中某 agent 发出的消息数（用于"参与"权限判定）。 */
  countMessagesByAgent(sessionId: string, agentId: string): number;
}

/** 可选注入：让 agent 通过 session 工具主动压缩自己的历史上下文（0.9.7 context-root-fix）。 */
export interface SessionCompactor {
  compactOnDemand(sessionId: string, keepLast: number): { summary: string; flushedCount: number };
  /** ContextOS: compact with an explicit structured anchor (goal/done/next). */
  compactWithAnchor?(
    sessionId: string,
    keepLast: number,
    anchor: { goal?: string; done?: string; next?: string },
  ): { summary: string; flushedCount: number; anchorKey: string };
}

/** ContextOS: agent-managed slot store — pin/unpin facts that survive compaction. */
export interface SessionSlotStore {
  getSlots(sessionId: string): Array<{ key: string; text: string; updatedAt?: number }>;
  setSlot(sessionId: string, key: string, text: string): void;
  removeSlot(sessionId: string, key: string): void;
  /** Serialize this session's slots into the fixed [SLOTS] injection segment. */
  serialize(sessionId: string): string;
}

/** ContextOS: archived-fragment store — retrieve/include/purge compacted history. */
export interface SessionFragmentStore {
  retrieveFragments(
    query: string,
    maxResults: number,
  ): Array<{ id: string; content: string; metadata?: Record<string, unknown> }>;
  includeFragment(sessionId: string, fragmentId: string): { ok: boolean; message: string };
  purgeSessionFragments(sessionId: string): number;
  sessionStats(sessionId: string): { messageCount: number; slotKeys: string[]; fragmentCount: number };
}

export interface SessionToolContext {
  agentId: string;
  chatSessionRepo: SessionRepo;
  /** 可选。提供后，agent 可用 `operation: "compact"` 主动折叠旧历史，替换为锚点摘要。 */
  compactor?: SessionCompactor;
  /** ContextOS 可选。提供后，agent 可用 pin/unpin 钉住固定槽位、status 查看占用。 */
  slotStore?: SessionSlotStore;
  /** ContextOS 可选。提供后，agent 可用 retrieve/include/purge 管理已归档片段。 */
  fragmentStore?: SessionFragmentStore;
}

/**
 * Memory-backed SessionRepo — adapts MemoryStore conversation sessions to the
 * SessionRepo contract used by createSessionTool.
 *
 * WHY: the session tool must operate on the SAME session space the agent's
 * context is actually built from (MemoryStore `sess_*` / `task_*` / `a2a_*`),
 * NOT the Sqlite `cs_*` UI space. Mixing the two broke ContextOS:
 *   - checkOwnership used Sqlite (cs_* always "exists" → permission passed)
 *   - slot/compact/fragment operations used MemoryStore (no cs_* session →
 *     silent no-op returning ok but persisting nothing)
 * This adapter makes list/get/status/compact/pin/fragment ALL read/write the
 * same MemoryStore session records the agent truly manages.
 */
export function createMemorySessionRepo(mem: IMemoryStore): SessionRepo {
  return {
    listSessionsPaginated(agentId: string, opts: {
      since?: string; until?: string; userId?: string; page?: number; pageSize?: number;
    }) {
      const sessions = mem.listSessions(agentId)
        .filter((s) => {
          if (opts.since && s.lastActivityAt && s.lastActivityAt < opts.since) return false;
          if (opts.until && s.lastActivityAt && s.lastActivityAt > opts.until) return false;
          return true;
        })
        .sort((a, b) =>
          (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''),
        );
      const page = Math.max(1, Math.trunc(Number(opts.page) || 1) || 1);
      const pageSize = Math.min(Math.max(1, Math.trunc(Number(opts.pageSize) || 20) || 20), 50);
      const total = sessions.length;
      const slice = sessions.slice((page - 1) * pageSize, page * pageSize);
      return {
        sessions: slice.map((s) => ({
          id: s.id,
          agentId: s.agentId,
          userId: null,
          title: null,
          isMain: false,
          createdAt: s.startedAt,
          lastMessageAt: s.lastActivityAt,
        })),
        total,
        page,
        pageSize,
        hasMore: page * pageSize < total,
      };
    },
    getSession(sessionId: string): SessionRow | null | undefined {
      const s = mem.getSession(sessionId);
      if (!s) return null;
      return {
        id: s.id,
        agentId: s.agentId,
        userId: null,
        title: null,
        isMain: false,
        createdAt: s.startedAt,
        lastMessageAt: s.lastActivityAt,
      };
    },
    listMessagesPaginated(sessionId: string, opts: {
      since?: string; until?: string; page?: number; pageSize?: number;
    }) {
      const s = mem.getSession(sessionId);
      // LLMMessage has no createdAt — memory sessions store messages verbatim,
      // so since/until time filtering is not applicable at message level.
      const all = s?.messages ?? [];
      const page = Math.max(1, Math.trunc(Number(opts.page) || 1) || 1);
      const pageSize = Math.min(Math.max(1, Math.trunc(Number(opts.pageSize) || 50) || 50), 100);
      const total = all.length;
      const slice = all.slice((page - 1) * pageSize, page * pageSize);
      return {
        messages: slice.map((m) => ({
          id: '',
          sessionId,
          agentId: s?.agentId,
          role: m.role ?? null,
          content: getTextContent(m.content),
        })),
        total,
        page,
        pageSize,
        hasMore: page * pageSize < total,
      };
    },
    countMessagesByAgent(sessionId: string, agentId: string): number {
      const s = mem.getSession(sessionId);
      if (!s) return 0;
      // 会话归属该 agent 即视为"参与"（memory session 都是单主会话）
      return s.agentId === agentId ? s.messages.length : 0;
    },
  };
}

const OP_ALIASES = new Set([
  'list', 'get', 'compact',
  'pin', 'unpin', 'include', 'retrieve', 'purge', 'status',
]);

export function normalizeSessionArgs(args: Record<string, unknown>): {
  operation: 'list' | 'get' | 'compact' | 'pin' | 'unpin' | 'include' | 'retrieve' | 'purge' | 'status';
  sessionId: string | undefined;
  since: string | undefined;
  until: string | undefined;
  userId: string | undefined;
  page: number | undefined;
  pageSize: number | undefined;
  keepLast: number | undefined;
  key: string | undefined;
  content: string | undefined;
  query: string | undefined;
  maxResults: number | undefined;
  fragmentId: string | undefined;
  goal: string | undefined;
  done: string | undefined;
  next: string | undefined;
} {
  const sessionId = (args.session_id ?? args.sessionId ?? args.id) as string | undefined;
  let since = (args.since ?? args.after) as string | undefined;
  const until = (args.until ?? args.before) as string | undefined;
  const userId = (args.user_id ?? args.userId) as string | undefined;
  const page = (args.page ?? args.page_no) as number | undefined;
  const pageSize = (args.page_size ?? args.pageSize ?? args.limit) as number | undefined;
  const keepLast = (args.keep_last ?? args.keepLast ?? args.keep) as number | undefined;
  const key = (args.key ?? args.slot_key ?? args.slotKey) as string | undefined;
  const content = (args.content ?? args.value ?? args.text) as string | undefined;
  const query = (args.query ?? args.q ?? args.search) as string | undefined;
  const maxResults = (args.max_results ?? args.maxResults ?? args.limit) as number | undefined;
  const fragmentId = (args.fragment_id ?? args.fragmentId) as string | undefined;
  const goal = (args.goal ?? args.anchor_goal) as string | undefined;
  const done = (args.done ?? args.anchor_done) as string | undefined;
  const next = (args.next ?? args.anchor_next) as string | undefined;

  let explicit = (args.operation ?? args.op ?? args.action ?? args.mode) as string | undefined;
  if (typeof explicit === 'string') explicit = explicit.trim().toLowerCase();
  if (typeof args.type === 'string' && OP_ALIASES.has(args.type.trim().toLowerCase())) {
    explicit = args.type.trim().toLowerCase();
  }
  if (explicit?.startsWith('list')) explicit = 'list';
  else if (explicit?.startsWith('get')) explicit = 'get';
  else if (explicit?.startsWith('compact')) explicit = 'compact';
  else if (explicit?.startsWith('pin')) explicit = 'pin';
  else if (explicit?.startsWith('unpin')) explicit = 'unpin';
  else if (explicit?.startsWith('include')) explicit = 'include';
  else if (explicit?.startsWith('retrieve')) explicit = 'retrieve';
  else if (explicit?.startsWith('purge')) explicit = 'purge';
  else if (explicit?.startsWith('status')) explicit = 'status';
  if (explicit && !OP_ALIASES.has(explicit)) explicit = undefined;

  // Free-form query like "get cs-1"
  if (typeof since === 'string') {
    const lower = since.trim().toLowerCase();
    if (!explicit && (lower === 'get' || lower.startsWith('get '))) {
      explicit = 'get';
      const id = since.trim().slice(3).trim();
      if (id && !sessionId) since = undefined;
    }
  }

  let operation: 'list' | 'get' | 'compact' | 'pin' | 'unpin' | 'include' | 'retrieve' | 'purge' | 'status';
  if (explicit === 'get') operation = 'get';
  else if (explicit === 'list') operation = 'list';
  else if (explicit === 'compact') operation = 'compact';
  else if (explicit === 'pin') operation = 'pin';
  else if (explicit === 'unpin') operation = 'unpin';
  else if (explicit === 'include') operation = 'include';
  else if (explicit === 'retrieve') operation = 'retrieve';
  else if (explicit === 'purge') operation = 'purge';
  else if (explicit === 'status') operation = 'status';
  else if (sessionId) operation = 'get';
  else operation = 'list';

  return {
    operation, sessionId, since, until, userId, page, pageSize, keepLast,
    key, content, query, maxResults, fragmentId, goal, done, next,
  };
}

function iso(v: string | Date | undefined): string | undefined {
  if (!v) return undefined;
  return v instanceof Date ? v.toISOString() : String(v);
}

/** Ownership: agent may write/manage a session only if it owns it (agentId matches). */
function checkOwnership(
  repo: SessionRepo,
  sessionId: string,
  agentId: string,
): { session?: SessionRow; error?: string } {
  const session = repo.getSession(sessionId);
  if (!session) return { error: JSON.stringify({ status: 'not_found', message: `No session with id ${sessionId}.` }) };
  if (session.agentId !== agentId) {
    return { error: JSON.stringify({ status: 'forbidden', message: `Not authorized to manage session ${sessionId}.` }) };
  }
  return { session };
}

export function createSessionTool(ctx: SessionToolContext): AgentToolHandler {
  const repo = ctx.chatSessionRepo;

  async function doList(args: Record<string, unknown>): Promise<string> {
    const n = normalizeSessionArgs(args);
    const page = Math.max(1, Math.trunc(Number(n.page) || 1) || 1);
    const pageSize = Math.min(Math.max(1, Math.trunc(Number(n.pageSize) || 20) || 20), 50);
    const res = repo.listSessionsPaginated(ctx.agentId, {
      since: n.since,
      until: n.until,
      userId: n.userId,
      page,
      pageSize,
    });
    return JSON.stringify({
      status: 'ok',
      sessions: res.sessions.map(s => ({
        id: s.id,
        agentId: s.agentId,
        userId: s.userId ?? null,
        title: s.title ?? null,
        isMain: !!s.isMain,
        createdAt: iso(s.createdAt as string | Date),
        lastMessageAt: iso(s.lastMessageAt as string | Date),
      })),
      total: res.total,
      page: res.page,
      pageSize: res.pageSize,
      hasMore: res.hasMore,
    });
  }

  async function doGet(args: Record<string, unknown>): Promise<string> {
    const n = normalizeSessionArgs(args);
    if (!n.sessionId) {
      return JSON.stringify({
        status: 'error',
        message: 'Getting a session needs session_id. Example: { "operation": "get", "session_id": "sess_..." }. List first with { "operation": "list" }.',
      });
    }
    const session = repo.getSession(n.sessionId);
    if (!session) {
      return JSON.stringify({ status: 'not_found', message: `No session with id ${n.sessionId}.` });
    }
    // 权限：归属 或 参与（本 agent 在该 session 发过消息）
    const isOwner = session.agentId === ctx.agentId;
    if (!isOwner) {
      const participated = repo.countMessagesByAgent(n.sessionId, ctx.agentId) > 0;
      if (!participated) {
        return JSON.stringify({ status: 'forbidden', message: `Not authorized to read session ${n.sessionId}.` });
      }
    }
    const page = Math.max(1, Math.trunc(Number(n.page) || 1) || 1);
    const pageSize = Math.min(Math.max(1, Math.trunc(Number(n.pageSize) || 50) || 50), 100);
    const msgs = repo.listMessagesPaginated(n.sessionId, {
      since: n.since,
      until: n.until,
      page,
      pageSize,
    });
    return JSON.stringify({
      status: 'ok',
      session: {
        id: session.id,
        agentId: session.agentId,
        userId: session.userId ?? null,
        title: session.title ?? null,
        isMain: !!session.isMain,
        createdAt: iso(session.createdAt as string | Date),
        lastMessageAt: iso(session.lastMessageAt as string | Date),
      },
      messages: msgs.messages.map(m => ({
        id: m.id,
        role: m.role ?? null,
        content: m.content ?? '',
        createdAt: iso(m.createdAt as string | Date),
      })),
      totalMessages: msgs.total,
      page: msgs.page,
      pageSize: msgs.pageSize,
      hasMore: msgs.hasMore,
    });
  }

  async function doCompact(args: Record<string, unknown>): Promise<string> {
    if (!ctx.compactor) {
      return JSON.stringify({
        status: 'error',
        message: 'Context compaction is not available in this runtime (no compactor injected).',
      });
    }
    const n = normalizeSessionArgs(args);
    if (!n.sessionId) {
      return JSON.stringify({
        status: 'error',
        message: 'Compacting needs session_id. Example: { "operation": "compact", "session_id": "sess_...", "keep_last": 40 }.',
      });
    }
    // 权限：只允许压缩自己拥有的 session（避免 agent 篡改他人上下文）。
    const own = checkOwnership(repo, n.sessionId, ctx.agentId);
    if (own.error) return own.error;
    const keepLast = Math.max(5, Math.min(200, Math.trunc(Number(n.keepLast) || 40) || 40));
    try {
      const hasAnchor = n.goal || n.done || n.next;
      let res: { summary: string; flushedCount: number; anchorKey?: string };
      if (hasAnchor && ctx.compactor.compactWithAnchor) {
        res = ctx.compactor.compactWithAnchor(n.sessionId, keepLast, {
          goal: n.goal, done: n.done, next: n.next,
        });
      } else {
        res = ctx.compactor.compactOnDemand(n.sessionId, keepLast);
      }
      return JSON.stringify({
        status: 'ok',
        flushedCount: res.flushedCount,
        remaining: res.summary.length,
        summary: res.summary,
        ...(res.anchorKey ? { anchored_as: res.anchorKey } : {}),
        note: hasAnchor
          ? 'As a pinch: pin a goal/done/next anchor keeps your position alive even after compaction. Use session_pin to persist them as durable slots.'
          : 'Earlier messages were compacted into the anchor summary above. Continue the work from this point; you do NOT need to re-read the flushed messages.',
      });
    } catch (err) {
      log.error('session compact failed', { error: String(err) });
      return JSON.stringify({ status: 'error', message: String(err) });
    }
  }

  async function doPin(args: Record<string, unknown>): Promise<string> {
    if (!ctx.slotStore) {
      return JSON.stringify({ status: 'error', message: 'Slot pinning is not available in this runtime (no slotStore injected).' });
    }
    const n = normalizeSessionArgs(args);
    if (!n.sessionId || !n.key || n.content === undefined) {
      return JSON.stringify({
        status: 'error',
        message: 'Pinning needs session_id, key, content. Example: { "operation": "pin", "session_id": "sess_...", "key": "goal", "content": "..." }.',
      });
    }
    const own = checkOwnership(repo, n.sessionId, ctx.agentId);
    if (own.error) return own.error;
    try {
      ctx.slotStore.setSlot(n.sessionId, n.key, n.content);
      return JSON.stringify({
        status: 'ok',
        pinned: { [n.key]: n.content.slice(0, 120) + (n.content.length > 120 ? '…' : '') },
        note: `Pinned key "${n.key}" into session ${n.sessionId}. It stays in the fixed [SLOTS] segment and is NEVER compacted until you unpin it.`,
      });
    } catch (err) {
      log.error('session pin failed', { error: String(err) });
      return JSON.stringify({ status: 'error', message: String(err) });
    }
  }

  async function doUnpin(args: Record<string, unknown>): Promise<string> {
    if (!ctx.slotStore) {
      return JSON.stringify({ status: 'error', message: 'Slot pinning is not available in this runtime (no slotStore injected).' });
    }
    const n = normalizeSessionArgs(args);
    if (!n.sessionId || !n.key) {
      return JSON.stringify({ status: 'error', message: 'Unpinning needs session_id and key.' });
    }
    const own = checkOwnership(repo, n.sessionId, ctx.agentId);
    if (own.error) return own.error;
    try {
      ctx.slotStore.removeSlot(n.sessionId, n.key);
      return JSON.stringify({ status: 'ok', unpinned: n.key, note: `Removed pinned key "${n.key}".` });
    } catch (err) {
      log.error('session unpin failed', { error: String(err) });
      return JSON.stringify({ status: 'error', message: String(err) });
    }
  }

  async function doRetrieve(args: Record<string, unknown>): Promise<string> {
    if (!ctx.fragmentStore) {
      return JSON.stringify({ status: 'error', message: 'Fragment retrieval is not available in this runtime (no fragmentStore injected).' });
    }
    const n = normalizeSessionArgs(args);
    const query = String(n.query ?? '');
    const maxResults = Math.max(1, Math.min(20, Math.trunc(Number(n.maxResults) || 5) || 5));
    try {
      const hits = ctx.fragmentStore.retrieveFragments(query, maxResults);
      if (!hits.length) {
        return JSON.stringify({
          status: 'ok',
          hits: [],
          note: query
            ? `No archived fragments matched "${query}". Compaction archives raw history recoverable via session_retrieve.`
            : 'No archived fragments. Compaction archives raw history recoverable via session_retrieve.',
        });
      }
      return JSON.stringify({
        status: 'ok',
        hits: hits.map((h) => ({ id: h.id, content: h.content.slice(0, 2000) })),
        note: 'Return the fragment_id to session_include to reinject it into context.',
      });
    } catch (err) {
      log.error('session retrieve failed', { error: String(err) });
      return JSON.stringify({ status: 'error', message: String(err) });
    }
  }

  async function doInclude(args: Record<string, unknown>): Promise<string> {
    if (!ctx.fragmentStore) {
      return JSON.stringify({ status: 'error', message: 'Fragment inclusion is not available in this runtime (no fragmentStore injected).' });
    }
    const n = normalizeSessionArgs(args);
    if (!n.sessionId || !n.fragmentId) {
      return JSON.stringify({ status: 'error', message: 'Including needs session_id and fragment_id (from session_retrieve).' });
    }
    const own = checkOwnership(repo, n.sessionId, ctx.agentId);
    if (own.error) return own.error;
    try {
      const res = ctx.fragmentStore.includeFragment(n.sessionId, n.fragmentId);
      return JSON.stringify(res.ok ? { status: 'ok', ...res } : { status: 'error', ...res });
    } catch (err) {
      log.error('session include failed', { error: String(err) });
      return JSON.stringify({ status: 'error', message: String(err) });
    }
  }

  async function doPurge(args: Record<string, unknown>): Promise<string> {
    if (!ctx.fragmentStore) {
      return JSON.stringify({ status: 'error', message: 'Fragment purge is not available in this runtime (no fragmentStore injected).' });
    }
    const n = normalizeSessionArgs(args);
    if (!n.sessionId) {
      return JSON.stringify({ status: 'error', message: 'Purging needs session_id.' });
    }
    const own = checkOwnership(repo, n.sessionId, ctx.agentId);
    if (own.error) return own.error;
    try {
      const removed = ctx.fragmentStore.purgeSessionFragments(n.sessionId);
      return JSON.stringify({
        status: 'ok',
        purgedFragments: removed,
        note: `Removed ${removed} archived fragment(s) for session ${n.sessionId}. These are permanently deleted (compact no longer archived if purged).`,
      });
    } catch (err) {
      log.error('session purge failed', { error: String(err) });
      return JSON.stringify({ status: 'error', message: String(err) });
    }
  }

  async function doStatus(args: Record<string, unknown>): Promise<string> {
    const n = normalizeSessionArgs(args);
    if (!n.sessionId) {
      return JSON.stringify({ status: 'error', message: 'Status needs session_id.' });
    }
    // status is read-only: ownership OR participation is enough (same as get).
    const session = repo.getSession(n.sessionId);
    if (!session) {
      return JSON.stringify({ status: 'not_found', message: `No session with id ${n.sessionId}.` });
    }
    const isOwner = session.agentId === ctx.agentId;
    if (!isOwner) {
      const participated = repo.countMessagesByAgent(n.sessionId, ctx.agentId) > 0;
      if (!participated) {
        return JSON.stringify({ status: 'forbidden', message: `Not authorized to read session ${n.sessionId}.` });
      }
    }
    try {
      const fragmentStats = ctx.fragmentStore?.sessionStats ? ctx.fragmentStore.sessionStats(n.sessionId) : undefined;
      const slots = ctx.slotStore?.getSlots ? ctx.slotStore.getSlots(n.sessionId) : [];
      return JSON.stringify({
        status: 'ok',
        sessionId: n.sessionId,
        messageCount: fragmentStats?.messageCount ?? repo.listMessagesPaginated(n.sessionId, { page: 1, pageSize: 1 }).total,
        fragmentCount: fragmentStats?.fragmentCount ?? 0,
        slots: slots.map((s) => s.key),
        note: 'Use session_status to observe your context water level; use session_compact / session_pin to actively manage it.',
      });
    } catch (err) {
      log.error('session status failed', { error: String(err) });
      return JSON.stringify({ status: 'error', message: String(err) });
    }
  }

  return {
    name: 'session',
    description: [
      'Manage your own conversation sessions (MemoryStore sessions, ids like sess_* / task_* / a2a_* / hb_*) and context.',
      '',
      'Commands (pick one):',
      '• session_list — list your sessions. Args: since/until (ISO), page, page_size. Returns { sessions: [{id, agentId, createdAt, lastMessageAt}], total, page, page_size, has_more }.',
      '  Example: { "operation": "list", "since": "2026-08-01", "page": 1, "page_size": 20 }',
      '• session_get — get one session + its messages. Args: session_id, since/until, page, page_size. Returns { status, sessionId, messages: [{role, content}], total, page }.',
      '  Example: { "operation": "get", "session_id": "sess_...", "page_size": 50 }',
      '• session_compact — collapse stale history into an anchor summary so future turns stop re-reading it. Atomic: an assistant tool-call and its tool results are NEVER split. Optionally pass goal/done/next to anchor your position. Use when earlier tool results are obsolete or context feels bloated. Returns { status, flushedCount, remaining, summary } — summary is a [SYSTEM]-prefixed anchor injected into the session; the raw flushed messages are archived and recoverable via session_retrieve.',
      '  Args: session_id (required), keep_last (5-200, default 40), goal/done/next (optional anchors).',
      '  Example: { "operation": "compact", "session_id": "sess_...", "keep_last": 40 }',
      '• session_pin — write a durable slot into the fixed [SLOTS] segment: persisted per session and injected every turn, NEVER compacted until you unpin it. Best for your current goal / what is done / what is next (use key=goal/done/next). Returns { status, pinned: {key: content} }.',
      '  Args: session_id, key, content. Example: { "operation": "pin", "session_id": "sess_...", "key": "goal", "content": "..." }',
      '• session_unpin — remove a pinned slot. Args: session_id, key. Returns { status, unpinned: key }.',
      '• session_retrieve — search archived (compacted) history fragments by keyword. Returns { status, hits: [{id: fragment_id, content}] } — note the field is "hits", each element carries the fragment id needed for session_include. Args: session_id, query, max_results.',
      '• session_include — reinject an archived fragment (by fragment_id) back into context. Args: session_id, fragment_id.',
      '• session_purge — permanently delete archived fragments for a session. Args: session_id.',
      '• session_status — read-only snapshot: message count, pinned slot keys, archived fragment count. Returns { status, sessionId, messageCount, fragmentCount, slots: [key...] }. Args: session_id.',
      '',
      'Permissions: you may list sessions you own; get/status sessions you own OR participated in; compact/pin/unpin/include/purge ONLY sessions you own.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['list', 'get', 'compact', 'pin', 'unpin', 'include', 'retrieve', 'purge', 'status'],
          description: 'Which session operation to run. Default: list when no session_id, get when session_id present.',
        },
        session_id: { type: 'string', description: 'The session id to operate on (sess_* / task_* / a2a_* / hb_* — see session_list).' },
        since: { type: 'string', description: 'ISO timestamp — filter sessions/messages with timestamp >= since.' },
        until: { type: 'string', description: 'ISO timestamp — filter sessions/messages with timestamp <= until.' },
        page: { type: 'number', description: '1-based page number (default 1).' },
        page_size: { type: 'number', description: 'Page size (list default 20 max 50; get default 50 max 100).' },
        keep_last: { type: 'number', description: 'For compact: how many most-recent messages to keep verbatim (default 40, range 5-200).' },
        key: { type: 'string', description: 'For pin/unpin: the slot key (e.g. goal, done, next).' },
        content: { type: 'string', description: 'For pin: the fact/anchor text to pin (> up to 1200 chars).' },
        query: { type: 'string', description: 'For retrieve: keyword(s) to search archived fragments.' },
        max_results: { type: 'number', description: 'For retrieve: max results (default 5, max 20).' },
        fragment_id: { type: 'string', description: 'For include: the fragment id (from retrieve) to reinject.' },
        goal: { type: 'string', description: 'For compact: anchor goal (optional).' },
        done: { type: 'string', description: 'For compact: anchor done-so-far (optional).' },
        next: { type: 'string', description: 'For compact: anchor next-step (optional).' },
      },
      required: [],
    },
    async execute(args: Record<string, unknown>, _onOutput?: unknown): Promise<string> {
      try {
        const n = normalizeSessionArgs(args);
        switch (n.operation) {
          case 'get': return await doGet(args);
          case 'compact': return await doCompact(args);
          case 'pin': return await doPin(args);
          case 'unpin': return await doUnpin(args);
          case 'retrieve': return await doRetrieve(args);
          case 'include': return await doInclude(args);
          case 'purge': return await doPurge(args);
          case 'status': return await doStatus(args);
          default: return await doList(args);
        }
      } catch (err) {
        log.error('session tool failed', { error: String(err) });
        return JSON.stringify({ status: 'error', message: String(err) });
      }
    },
  };
}
