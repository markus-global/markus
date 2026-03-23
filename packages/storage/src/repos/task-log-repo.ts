import { eq, asc, sql } from 'drizzle-orm';
import type { Database } from '../db.js';
import { taskLogs } from '../schema.js';
import { generateId } from '@markus/shared';

export type TaskLogType = 'status' | 'text' | 'tool_start' | 'tool_end' | 'error';

export interface TaskLogRow {
  id: string;
  taskId: string;
  agentId: string;
  seq: number;
  type: string;
  content: string;
  metadata: unknown;
  executionRound: number;
  createdAt: Date;
}

export class TaskLogRepo {
  constructor(private db: Database) {}

  async append(data: {
    taskId: string;
    agentId: string;
    seq: number;
    type: TaskLogType;
    content: string;
    metadata?: unknown;
    executionRound?: number;
  }): Promise<TaskLogRow> {
    const [row] = await this.db.insert(taskLogs).values({
      id: generateId('tl'),
      taskId: data.taskId,
      agentId: data.agentId,
      seq: data.seq,
      type: data.type,
      content: data.content,
      metadata: (data.metadata ?? {}) as Record<string, unknown>,
      executionRound: data.executionRound ?? 1,
    }).returning();
    return row!;
  }

  async getMaxSeq(taskId: string): Promise<number> {
    const result = await this.db.select({ maxSeq: sql<number>`COALESCE(MAX(${taskLogs.seq}), -1)` })
      .from(taskLogs)
      .where(eq(taskLogs.taskId, taskId));
    return result[0]?.maxSeq ?? -1;
  }

  async getByTask(taskId: string): Promise<TaskLogRow[]> {
    return this.db.select().from(taskLogs)
      .where(eq(taskLogs.taskId, taskId))
      .orderBy(asc(taskLogs.seq));
  }

  async deleteByTask(taskId: string): Promise<void> {
    await this.db.delete(taskLogs).where(eq(taskLogs.taskId, taskId));
  }
}
