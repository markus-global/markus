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

export function createRecallTool(ctx: RecallContext): AgentToolHandler {
  return {
    name: 'recall_activity',
    description:
      'Query your own execution history. Use "list" to see recent activities, ' +
      '"get" with an activity_id for detailed logs, or "search" to find activities by keywords.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['list', 'get', 'search'],
          description: 'list = recent activities, get = detailed logs for one activity, search = keyword search across activity summaries',
        },
        activity_id: {
          type: 'string',
          description: 'Required for "get" operation. The activity ID to retrieve logs for.',
        },
        query: {
          type: 'string',
          description: 'Required for "search" operation. Keywords to search for in activity summaries (e.g. "auth error", "file_edit deployment").',
        },
        task_id: {
          type: 'string',
          description: 'Optional filter for "list": only show activities related to this task.',
        },
        type: {
          type: 'string',
          description: 'Optional filter for "list": activity type (e.g. task, chat, heartbeat).',
        },
        limit: {
          type: 'number',
          description: 'Max results for "list" and "search" (default 5, max 20).',
        },
      },
      required: ['operation'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const operation = args.operation as string;

      if (operation === 'list') {
        try {
          const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20);
          const activities = ctx.listActivities(ctx.agentId, {
            type: args.type as string | undefined,
            taskId: args.task_id as string | undefined,
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
        const query = args.query as string;
        if (!query) {
          return JSON.stringify({ status: 'error', message: 'query is required for "search" operation' });
        }
        if (!ctx.searchActivities) {
          return JSON.stringify({ status: 'error', message: 'Search is not available — activity indexing not configured.' });
        }
        try {
          const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20);
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

      if (operation === 'get') {
        const activityId = args.activity_id as string;
        if (!activityId) {
          return JSON.stringify({ status: 'error', message: 'activity_id is required for "get" operation' });
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
      }

      return JSON.stringify({ status: 'error', message: `Unknown operation: ${operation}. Use "list", "get", or "search".` });
    },
  };
}
