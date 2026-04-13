import { eq, asc } from 'drizzle-orm';
import type { Database } from '../db.js';
import { requirementComments } from '../schema.js';
import { generateId } from '@markus/shared';

export interface RequirementCommentRow {
  id: string;
  requirementId: string;
  authorId: string;
  authorName: string;
  authorType: string;
  content: string;
  attachments: unknown;
  mentions: string[];
  activityId?: string | null;
  createdAt: Date;
}

export class RequirementCommentRepo {
  constructor(private db: Database) {}

  async add(data: {
    requirementId: string;
    authorId: string;
    authorName: string;
    authorType: string;
    content: string;
    attachments?: unknown[];
    mentions?: string[];
    activityId?: string;
  }): Promise<RequirementCommentRow> {
    const [row] = await this.db.insert(requirementComments).values({
      id: generateId('rc'),
      requirementId: data.requirementId,
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

  async getByRequirement(requirementId: string): Promise<RequirementCommentRow[]> {
    const rows = await this.db.select().from(requirementComments)
      .where(eq(requirementComments.requirementId, requirementId))
      .orderBy(asc(requirementComments.createdAt));
    return rows.map(r => ({ ...r, mentions: (r.mentions ?? []) as string[] }));
  }

  async deleteByRequirement(requirementId: string): Promise<void> {
    await this.db.delete(requirementComments).where(eq(requirementComments.requirementId, requirementId));
  }
}
