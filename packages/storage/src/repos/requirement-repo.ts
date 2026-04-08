import { eq, and } from 'drizzle-orm';
import type { Database } from '../db.js';
import { requirements } from '../schema.js';

type RequirementStatus =
  | 'pending'
  | 'in_progress'
  | 'blocked'
  | 'review'
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'cancelled'
  | 'archived';
type RequirementSource = 'user' | 'agent';
type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export class RequirementRepo {
  constructor(private db: Database) {}

  async create(data: {
    id: string;
    orgId: string;
    title: string;
    description?: string;
    status?: RequirementStatus;
    priority?: TaskPriority;
    source: RequirementSource;
    createdBy: string;
    projectId?: string;
    approvedBy?: string;
    approvedAt?: Date;
    tags?: string[];
  }) {
    const [row] = await this.db
      .insert(requirements)
      .values({
        id: data.id,
        orgId: data.orgId,
        title: data.title,
        description: data.description ?? '',
        status: data.status ?? 'pending',
        priority: data.priority ?? 'medium',
        source: data.source,
        createdBy: data.createdBy,
        projectId: data.projectId ?? null,
        approvedBy: data.approvedBy ?? null,
        approvedAt: data.approvedAt ?? null,
        tags: data.tags ?? [],
      })
      .returning();
    return row!;
  }

  async findById(id: string) {
    const [row] = await this.db.select().from(requirements).where(eq(requirements.id, id));
    return row;
  }

  async updateStatus(id: string, status: RequirementStatus) {
    await this.db
      .update(requirements)
      .set({ status, updatedAt: new Date() })
      .where(eq(requirements.id, id));
  }

  async approve(id: string, approvedBy: string) {
    const now = new Date();
    await this.db
      .update(requirements)
      .set({ status: 'in_progress', approvedBy, approvedAt: now, updatedAt: now })
      .where(eq(requirements.id, id));
  }

  async reject(id: string, reason: string) {
    await this.db
      .update(requirements)
      .set({ status: 'rejected', rejectedReason: reason, updatedAt: new Date() })
      .where(eq(requirements.id, id));
  }

  async update(
    id: string,
    data: { title?: string; description?: string; priority?: TaskPriority; tags?: string[]; projectId?: string | null }
  ) {
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (data.title !== undefined) updates['title'] = data.title;
    if (data.description !== undefined) updates['description'] = data.description;
    if (data.priority !== undefined) updates['priority'] = data.priority;
    if (data.tags !== undefined) updates['tags'] = data.tags;
    if (data.projectId !== undefined) updates['projectId'] = data.projectId;
    await this.db.update(requirements).set(updates).where(eq(requirements.id, id));
  }

  async listByOrg(orgId: string, filters?: { status?: RequirementStatus; source?: RequirementSource; projectId?: string }) {
    const conditions = [eq(requirements.orgId, orgId)];
    if (filters?.status) conditions.push(eq(requirements.status, filters.status));
    if (filters?.source) conditions.push(eq(requirements.source, filters.source));
    if (filters?.projectId) conditions.push(eq(requirements.projectId, filters.projectId));
    return this.db
      .select()
      .from(requirements)
      .where(and(...conditions));
  }

  async delete(id: string) {
    await this.db.delete(requirements).where(eq(requirements.id, id));
  }
}
