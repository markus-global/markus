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
  }>;
  getActivityLogs: (activityId: string) => Array<{
    seq: number;
    type: string;
    content: string;
    createdAt: string;
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
      'or "get" with an activity_id to see detailed tool call logs for a specific activity.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['list', 'get'],
          description: 'list = recent activity summaries, get = detailed logs for one activity',
        },
        activity_id: {
          type: 'string',
          description: 'Required for "get" operation. The activity ID to retrieve logs for.',
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
          description: 'Max results for "list" (default 5, max 20).',
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
            })),
          });
        } catch (err) {
          log.error('recall_activity list failed', { error: String(err) });
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

      return JSON.stringify({ status: 'error', message: `Unknown operation: ${operation}. Use "list" or "get".` });
    },
  };
}
