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
  }): Promise<TaskCommentRow> {
    const [row] = await this.db.insert(taskComments).values({
      id: generateId('tc'),
      taskId: data.taskId,
      authorId: data.authorId,
      authorName: data.authorName,
      authorType: data.authorType,
      content: data.content,
      attachments: (data.attachments ?? []) as Record<string, unknown>[],
    }).returning();
    return row!;
  }

  async getByTask(taskId: string): Promise<TaskCommentRow[]> {
    return this.db.select().from(taskComments)
      .where(eq(taskComments.taskId, taskId))
      .orderBy(asc(taskComments.createdAt));
  }

  async deleteByTask(taskId: string): Promise<void> {
    await this.db.delete(taskComments).where(eq(taskComments.taskId, taskId));
  }
}
