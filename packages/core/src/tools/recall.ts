import type { AgentToolHandler } from '../agent.js';
import { createLogger } from '@markus/shared';

const log = createLogger('recall-tools');

const CONTENT_TRUNCATE_LIMIT = 500;

export interface RecallCallbacks {
  listActivities: (agentId: string, opts: {
    type?: string;
    taskId?: string;
    limit?: number;
  }) => Array<{
    id: string;
    type: string;
    label: string;
    taskId?: string | null;
    startedAt: string;
    endedAt?: string | null;
    totalTokens: number;
    totalTools: number;
    success: boolean;
    summary?: string;
  }>;
  getActivityLogs: (activityId: string) => Array<{
    seq: number;
    type: string;
    content: string;
    createdAt: string;
  }>;
  searchActivities?: (agentId: string, query: string, opts?: { limit?: number }) => Array<{
    id: string;
    type: string;
    label: string;
    taskId?: string | null;
    startedAt: string;
    endedAt?: string | null;
    totalTokens: number;
    totalTools: number;
    success: boolean;
    summary?: string;
    keywords?: string;
  }>;
}

export interface RecallContext extends RecallCallbacks {
  agentId: string;
}

const OP_ALIASES = new Set(['list', 'get', 'search']);

/**
 * Intuitive resolution:
 *   1. activity_id present → get
 *   2. query/q present (and not a bare "list"/"recent") → search
 *   3. otherwise → list
 *
 * Also accepts legacy/drift fields: operation/op/action/mode/data, and
 * type="list"|"get"|"search" when used as a mistaken operation field.
 */
export function normalizeRecallArgs(args: Record<string, unknown>): {
  operation: 'list' | 'get' | 'search';
  query: string | undefined;
  activityId: string | undefined;
  taskId: string | undefined;
  activityType: string | undefined;
  limit: unknown;
} {
  let activityId = (args.activity_id ?? args.activityId ?? args.id) as string | undefined;
  let query = (args.query ?? args.q ?? args.keywords) as string | undefined;
  const taskId = (args.task_id ?? args.taskId) as string | undefined;
  let activityType = args.type as string | undefined;
  const limit = args.limit;

  // Explicit mode from several common aliases models invent.
  let explicit = (args.operation ?? args.op ?? args.action ?? args.mode ?? args.data) as string | undefined;
  if (typeof explicit === 'string') explicit = explicit.trim().toLowerCase();
  // Model sometimes puts the mode in `type` (conflicts with activity-type filter).
  if ((!explicit || !OP_ALIASES.has(explicit)) && typeof activityType === 'string') {
    const t = activityType.trim().toLowerCase();
    if (OP_ALIASES.has(t)) {
      explicit = t;
      activityType = undefined;
    }
  }
  if (explicit?.startsWith('list')) explicit = 'list';
  else if (explicit?.startsWith('get')) explicit = 'get';
  else if (explicit?.startsWith('search')) explicit = 'search';
  if (explicit && !OP_ALIASES.has(explicit)) explicit = undefined;

  // Free-form query that is really a list/get command.
  if (typeof query === 'string') {
    const lower = query.trim().toLowerCase();
    if (!explicit && (lower === 'list' || lower === 'recent' || lower.startsWith('list '))) {
      explicit = 'list';
      query = undefined;
    } else if (!explicit && (lower === 'get' || lower.startsWith('get '))) {
      explicit = 'get';
      const id = query.trim().slice(3).trim();
      if (id && !activityId) activityId = id;
      query = undefined;
    } else if (!explicit && (lower === 'search' || lower.startsWith('search '))) {
      explicit = 'search';
      query = query.trim().replace(/^search\s+/i, '').trim() || undefined;
    }
  }

  let operation: 'list' | 'get' | 'search';
  if (explicit === 'get' || explicit === 'list' || explicit === 'search') {
    operation = explicit;
  } else if (activityId) {
    operation = 'get';
  } else if (query && query.trim()) {
    operation = 'search';
  } else {
    operation = 'list';
  }

  return { operation, query, activityId, taskId, activityType, limit };
}

export function createRecallTool(ctx: RecallContext): AgentToolHandler {
  return {
    name: 'recall_activity',
    description: [
      'Look up your own past execution history (tool logs, prior chats/tasks).',
      '',
      'How to call (pick one — no need for an "operation" field):',
      '• Recent activities: {} or { "limit": 10 }',
      '• One activity\'s detailed logs: { "activity_id": "act-..." }',
      '• Keyword search: { "query": "auth error" }',
      '',
      'Optional filters for recent list: task_id, type (activity kind: chat/task/heartbeat), limit (default 5, max 20).',
      'Legacy: operation="list"|"get"|"search" is still accepted.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        activity_id: {
          type: 'string',
          description: 'If set, return detailed logs for this activity (get). Example: act-agt_…',
        },
        query: {
          type: 'string',
          description: 'If set (and no activity_id), search activity summaries by keywords. Omit both activity_id and query to list recent activities.',
        },
        task_id: {
          type: 'string',
          description: 'Optional: when listing recent activities, only those for this task.',
        },
        type: {
          type: 'string',
          description: 'Optional: when listing, filter by activity kind (chat, task, heartbeat). Do not put "list"/"get"/"search" here.',
        },
        limit: {
          type: 'number',
          description: 'Max results for list/search (default 5, max 20).',
        },
        operation: {
          type: 'string',
          enum: ['list', 'get', 'search'],
          description: 'Optional legacy override. Prefer activity_id / query / empty args instead.',
        },
      },
      required: [],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const normalized = normalizeRecallArgs(args);
      const { operation } = normalized;

      if (operation === 'list') {
        try {
          const limit = Math.min(Math.max(Number(normalized.limit) || 5, 1), 20);
          const activities = ctx.listActivities(ctx.agentId, {
            type: normalized.activityType,
            taskId: normalized.taskId,
            limit,
          });
          if (activities.length === 0) {
            return JSON.stringify({ status: 'ok', activities: [], message: 'No activities found.' });
          }
          return JSON.stringify({
            status: 'ok',
            activities: activities.map(a => ({
              id: a.id,
              type: a.type,
              label: a.label,
              taskId: a.taskId ?? undefined,
              startedAt: a.startedAt,
              endedAt: a.endedAt ?? undefined,
              totalTools: a.totalTools,
              success: a.success,
              summary: a.summary ?? undefined,
            })),
          });
        } catch (err) {
          log.error('recall_activity list failed', { error: String(err) });
          return JSON.stringify({ status: 'error', message: String(err) });
        }
      }

      if (operation === 'search') {
        const query = normalized.query;
        if (!query) {
          return JSON.stringify({
            status: 'error',
            message: 'Search needs a query string. Example: { "query": "auth error" }. For recent items use {} or { "limit": 10 }.',
          });
        }
        if (!ctx.searchActivities) {
          return JSON.stringify({ status: 'error', message: 'Search is not available — activity indexing not configured.' });
        }
        try {
          const limit = Math.min(Math.max(Number(normalized.limit) || 5, 1), 20);
          const results = ctx.searchActivities(ctx.agentId, query, { limit });
          if (results.length === 0) {
            return JSON.stringify({ status: 'ok', activities: [], message: `No activities matching "${query}".` });
          }
          return JSON.stringify({
            status: 'ok',
            activities: results.map(a => ({
              id: a.id,
              type: a.type,
              label: a.label,
              taskId: a.taskId ?? undefined,
              startedAt: a.startedAt,
              endedAt: a.endedAt ?? undefined,
              success: a.success,
              summary: a.summary ?? undefined,
              keywords: a.keywords ?? undefined,
            })),
          });
        } catch (err) {
          log.error('recall_activity search failed', { error: String(err) });
          return JSON.stringify({ status: 'error', message: String(err) });
        }
      }

      // get
      const activityId = normalized.activityId;
      if (!activityId) {
        return JSON.stringify({
          status: 'error',
          message: 'Getting details needs activity_id. Example: { "activity_id": "act-..." }. List recent first with {}.',
        });
      }
      try {
        const logs = ctx.getActivityLogs(activityId);
        if (logs.length === 0) {
          return JSON.stringify({ status: 'ok', logs: [], message: 'No logs found for this activity.' });
        }
        return JSON.stringify({
          status: 'ok',
          logs: logs.map(l => ({
            seq: l.seq,
            type: l.type,
            content: l.content.length > CONTENT_TRUNCATE_LIMIT
              ? l.content.slice(0, CONTENT_TRUNCATE_LIMIT) + '...[truncated]'
              : l.content,
            createdAt: l.createdAt,
          })),
        });
      } catch (err) {
        log.error('recall_activity get failed', { error: String(err) });
        return JSON.stringify({ status: 'error', message: String(err) });
      }
    },
  };
}
