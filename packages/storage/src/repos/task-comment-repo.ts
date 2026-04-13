import { eq, asc } from 'drizzle-orm';
import type { Database } from '../db.js';
import { taskComments } from '../schema.js';
import { generateId } from '@markus/shared';

export interface TaskCommentRow {
  id: string;
  taskId: string;
  authorId: string;
  authorName: string;
  authorType: string;
  content: string;
  attachments: unknown;
  mentions: string[];
  activityId?: string | null;
  createdAt: Date;
}

export class TaskCommentRepo {
  constructor(private db: Database) {}

  async add(data: {
    taskId: string;
    authorId: string;
    authorName: string;
    authorType: string;
    content: string;
    attachments?: unknown[];
    mentions?: string[];
    activityId?: string;
  }): Promise<TaskCommentRow> {
    const [row] = await this.db.insert(taskComments).values({
      id: generateId('tc'),
      taskId: data.taskId,
      authorId: data.authorId,
      authorName: data.authorName,
      authorType: data.authorType,
      content: data.content,
      attachments: (data.attachments ?? []) as Record<string, unknown>[],
      mentions: (data.mentions ?? []) as string[],
      activityId: data.activityId ?? null,
    }).returning();
    return { ...row!, mentions: (row!.mentions ?? []) as string[], activityId: row!.activityId };
  }

  async getByTask(taskId: string): Promise<TaskCommentRow[]> {
    const rows = await this.db.select().from(taskComments)
      .where(eq(taskComments.taskId, taskId))
      .orderBy(asc(taskComments.createdAt));
    return rows.map(r => ({ ...r, mentions: (r.mentions ?? []) as string[] }));
  }

  async deleteByTask(taskId: string): Promise<void> {
    await this.db.delete(taskComments).where(eq(taskComments.taskId, taskId));
  }
}
