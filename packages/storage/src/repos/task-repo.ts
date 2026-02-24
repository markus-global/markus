import { eq, and } from 'drizzle-orm';
import type { Database } from '../db.js';
import { tasks } from '../schema.js';

type TaskStatus = 'pending' | 'assigned' | 'in_progress' | 'blocked' | 'completed' | 'failed' | 'cancelled';
type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export class TaskRepo {
  constructor(private db: Database) {}

  async create(data: {
    id: string;
    orgId: string;
    title: string;
    description?: string;
    priority?: TaskPriority;
    assignedAgentId?: string;
    parentTaskId?: string;
    dueAt?: Date;
  }) {
    const [row] = await this.db.insert(tasks).values({
      id: data.id,
      orgId: data.orgId,
      title: data.title,
      description: data.description ?? '',
      priority: data.priority ?? 'medium',
      status: data.assignedAgentId ? 'assigned' : 'pending',
      assignedAgentId: data.assignedAgentId ?? null,
      parentTaskId: data.parentTaskId ?? null,
      dueAt: data.dueAt ?? null,
    }).returning();
    return row!;
  }

  async findById(id: string) {
    const [row] = await this.db.select().from(tasks).where(eq(tasks.id, id));
    return row;
  }

  async updateStatus(id: string, status: TaskStatus) {
    await this.db.update(tasks).set({ status, updatedAt: new Date() }).where(eq(tasks.id, id));
  }

  async assign(id: string, agentId: string) {
    await this.db.update(tasks).set({
      assignedAgentId: agentId,
      status: 'assigned',
      updatedAt: new Date(),
    }).where(eq(tasks.id, id));
  }

  async setResult(id: string, result: unknown) {
    await this.db.update(tasks).set({ result, updatedAt: new Date() }).where(eq(tasks.id, id));
  }

  async listByOrg(orgId: string, filters?: { status?: TaskStatus; assignedAgentId?: string }) {
    const conditions = [eq(tasks.orgId, orgId)];
    if (filters?.status) conditions.push(eq(tasks.status, filters.status));
    if (filters?.assignedAgentId) conditions.push(eq(tasks.assignedAgentId, filters.assignedAgentId));
    return this.db.select().from(tasks).where(and(...conditions));
  }

  async listByAgent(agentId: string) {
    return this.db.select().from(tasks).where(eq(tasks.assignedAgentId, agentId));
  }

  async delete(id: string) {
    await this.db.delete(tasks).where(eq(tasks.id, id));
  }
}
