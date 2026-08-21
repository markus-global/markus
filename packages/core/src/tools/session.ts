import type { AgentToolHandler } from '../agent.js';
import { createLogger } from '@markus/shared';

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
}

export interface SessionToolContext {
  agentId: string;
  chatSessionRepo: SessionRepo;
  /** 可选。提供后，agent 可用 `operation: "compact"` 主动折叠旧历史，替换为锚点摘要。 */
  compactor?: SessionCompactor;
}

const OP_ALIASES = new Set(['list', 'get', 'compact']);

export function normalizeSessionArgs(args: Record<string, unknown>): {
  operation: 'list' | 'get' | 'compact';
  sessionId: string | undefined;
  since: string | undefined;
  until: string | undefined;
  userId: string | undefined;
  page: number | undefined;
  pageSize: number | undefined;
  keepLast: number | undefined;
} {
  const sessionId = (args.session_id ?? args.sessionId ?? args.id) as string | undefined;
  let since = (args.since ?? args.after) as string | undefined;
  const until = (args.until ?? args.before) as string | undefined;
  const userId = (args.user_id ?? args.userId) as string | undefined;
  const page = (args.page ?? args.page_no) as number | undefined;
  const pageSize = (args.page_size ?? args.pageSize ?? args.limit) as number | undefined;
  const keepLast = (args.keep_last ?? args.keepLast ?? args.keep) as number | undefined;

  let explicit = (args.operation ?? args.op ?? args.action ?? args.mode) as string | undefined;
  if (typeof explicit === 'string') explicit = explicit.trim().toLowerCase();
  if (typeof args.type === 'string' && OP_ALIASES.has(args.type.trim().toLowerCase())) {
    explicit = args.type.trim().toLowerCase();
  }
  if (explicit?.startsWith('list')) explicit = 'list';
  else if (explicit?.startsWith('get')) explicit = 'get';
  else if (explicit?.startsWith('compact')) explicit = 'compact';
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

  let operation: 'list' | 'get' | 'compact';
  if (explicit === 'get') operation = 'get';
  else if (explicit === 'list') operation = 'list';
  else if (explicit === 'compact') operation = 'compact';
  else if (sessionId) operation = 'get';
  else operation = 'list';

  return { operation, sessionId, since, until, userId, page, pageSize, keepLast };
}

function iso(v: string | Date | undefined): string | undefined {
  if (!v) return undefined;
  return v instanceof Date ? v.toISOString() : String(v);
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
        message: 'Getting a session needs session_id. Example: { "operation": "get", "session_id": "cs-..." }. List first with { "operation": "list" }.',
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
        message: 'Compacting needs session_id. Example: { "operation": "compact", "session_id": "cs-...", "keep_last": 40 }.',
      });
    }
    // 权限：只允许压缩自己拥有的 session（避免 agent 篡改他人上下文）。
    const session = repo.getSession(n.sessionId);
    if (!session) {
      return JSON.stringify({ status: 'not_found', message: `No session with id ${n.sessionId}.` });
    }
    if (session.agentId !== ctx.agentId) {
      return JSON.stringify({ status: 'forbidden', message: `Not authorized to compact session ${n.sessionId}.` });
    }
    const keepLast = Math.max(5, Math.min(200, Math.trunc(Number(n.keepLast) || 40) || 40));
    try {
      const res = ctx.compactor.compactOnDemand(n.sessionId, keepLast);
      return JSON.stringify({
        status: 'ok',
        flushedCount: res.flushedCount,
        remaining: res.summary.length,
        summary: res.summary,
        note: 'Earlier messages were compacted into the anchor summary above. Continue the work from this point; you do NOT need to re-read the flushed messages.',
      });
    } catch (err) {
      log.error('session compact failed', { error: String(err) });
      return JSON.stringify({ status: 'error', message: String(err) });
    }
  }

  return {
    name: 'session',
    description: [
      'Manage your own conversation sessions (chat_sessions/chat_messages) stored by the platform.',
      '',
      'Commands (pick one):',
      '• session_list — list your sessions. Args: since/until (ISO timestamps), page, page_size.',
      '  Example: { "operation": "list", "since": "2026-08-01", "page": 1, "page_size": 20 }',
      '• session_get — get one session + its messages. Args: session_id, since/until, page, page_size.',
      '  Example: { "operation": "get", "session_id": "cs-...", "page_size": 50 }',
      '• session_compact — collapse stale history you no longer need into an anchor summary, so future turns stop re-reading it. Use when earlier tool results / file dumps are obsolete (e.g. after a big refactor) or when you feel the context is bloated.',
      '  Args: session_id (required), keep_last (optional, default 40, range 5-200 — how many most-recent messages to keep verbatim).',
      '  Example: { "operation": "compact", "session_id": "cs-...", "keep_last": 40 }',
      '',
      'Permissions: you may list sessions you own (agent_id matches), get sessions you own OR participated in, and compact ONLY sessions you own.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['list', 'get', 'compact'], description: 'list, get, or compact. Default: list when no session_id, get when session_id present.' },
        session_id: { type: 'string', description: 'For get/compact: the session id to fetch/compact (e.g. cs-…).' },
        since: { type: 'string', description: 'ISO timestamp — filter sessions/messages with timestamp >= since.' },
        until: { type: 'string', description: 'ISO timestamp — filter sessions/messages with timestamp <= until.' },
        page: { type: 'number', description: '1-based page number (default 1).' },
        page_size: { type: 'number', description: 'Page size (list default 20 max 50; get default 50 max 100).' },
        keep_last: { type: 'number', description: 'For compact: how many most-recent messages to keep verbatim (default 40, range 5-200).' },
      },
      required: [],
    },
    async execute(args: Record<string, unknown>, _onOutput?: unknown): Promise<string> {
      try {
        const n = normalizeSessionArgs(args);
        switch (n.operation) {
          case 'get': return await doGet(args);
          case 'compact': return await doCompact(args);
          default: return await doList(args);
        }
      } catch (err) {
        log.error('session tool failed', { error: String(err) });
        return JSON.stringify({ status: 'error', message: String(err) });
      }
    },
  };
}
