import { eq, and, sql } from 'drizzle-orm';
import type { Database } from '../db.js';
import { tasks } from '../schema.js';

type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'blocked'
  | 'review'
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'cancelled'
  | 'archived';
type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export class TaskRepo {
  constructor(private db: Database) {}

  async create(data: {
    id: string;
    orgId: string;
    title: string;
    description?: string;
    priority?: TaskPriority;
    status?: TaskStatus;
    assignedAgentId: string;
    reviewerAgentId: string;
    executionRound?: number;
    requirementId?: string;
    projectId?: string;
    createdBy?: string;
    blockedBy?: string[];
    dueAt?: Date;
    taskType?: string;
    scheduleConfig?: Record<string, unknown>;
    subtasks?: unknown[];
  }) {
    const [row] = await this.db
      .insert(tasks)
      .values({
        id: data.id,
        orgId: data.orgId,
        title: data.title,
        description: data.description ?? '',
        priority: data.priority ?? 'medium',
        status: data.status ?? 'pending',
        assignedAgentId: data.assignedAgentId,
        reviewerAgentId: data.reviewerAgentId,
        executionRound: data.executionRound ?? 1,
        requirementId: data.requirementId ?? null,
        projectId: data.projectId ?? null,
        createdBy: data.createdBy ?? null,
        blockedBy: data.blockedBy ?? [],
        dueAt: data.dueAt ?? null,
        taskType: data.taskType ?? 'standard',
        scheduleConfig: data.scheduleConfig ?? null,
        subtasks: data.subtasks ?? [],
      })
      .returning();
    return row!;
  }

  async findById(id: string) {
    const [row] = await this.db.select().from(tasks).where(eq(tasks.id, id));
    return row;
  }

  async updateStatus(id: string, status: TaskStatus, updatedBy?: string) {
    const now = new Date();
    const updates: Record<string, unknown> = { status, updatedAt: now };
    if (updatedBy) updates['updatedBy'] = updatedBy;
    if (status === 'in_progress') {
      updates['startedAt'] = now;
    }
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      updates['completedAt'] = now;
    }
    await this.db.update(tasks).set(updates).where(eq(tasks.id, id));
  }

  async assign(id: string, agentId: string) {
    await this.db.update(tasks).set({ assignedAgentId: agentId, updatedAt: new Date() }).where(eq(tasks.id, id));
  }

  async update(
    id: string,
    data: { title?: string; description?: string; priority?: TaskPriority; notes?: string[]; blockedBy?: string[]; projectId?: string | null; requirementId?: string | null; scheduleConfig?: Record<string, unknown> | null; reviewerAgentId?: string; updatedBy?: string }
  ) {
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (data.title !== undefined) updates['title'] = data.title;
    if (data.description !== undefined) updates['description'] = data.description;
    if (data.priority !== undefined) updates['priority'] = data.priority;
    if (data.notes !== undefined) updates['notes'] = data.notes;
    if (data.blockedBy !== undefined) updates['blockedBy'] = data.blockedBy;
    if (data.projectId !== undefined) updates['projectId'] = data.projectId;
    if (data.requirementId !== undefined) updates['requirementId'] = data.requirementId;
    if (data.scheduleConfig !== undefined) updates['scheduleConfig'] = data.scheduleConfig;
    if (data.reviewerAgentId !== undefined) updates['reviewerAgentId'] = data.reviewerAgentId;
    if (data.updatedBy !== undefined) updates['updatedBy'] = data.updatedBy;
    await this.db.update(tasks).set(updates).where(eq(tasks.id, id));
  }

  async clearForRerun(id: string, executionRound: number) {
    await this.db.update(tasks).set({
      executionRound,
      result: null,
      startedAt: null,
      completedAt: null,
      updatedAt: new Date(),
    }).where(eq(tasks.id, id));
  }

  async setResult(id: string, result: unknown) {
    await this.db.update(tasks).set({ result, updatedAt: new Date() }).where(eq(tasks.id, id));
  }

  async updateDeliverables(id: string, deliverables: unknown[]) {
    await this.db.update(tasks).set({ deliverables, updatedAt: new Date() }).where(eq(tasks.id, id));
  }

  async updateSubtasks(id: string, subtasks: unknown[]) {
    await this.db.update(tasks).set({ subtasks, updatedAt: new Date() }).where(eq(tasks.id, id));
  }

  async updateExecutionRound(id: string, round: number) {
    await this.db.update(tasks).set({ executionRound: round, updatedAt: new Date() }).where(eq(tasks.id, id));
  }

  async listByOrg(orgId: string, filters?: { status?: TaskStatus; assignedAgentId?: string; projectId?: string; taskType?: string }) {
    const conditions = [eq(tasks.orgId, orgId)];
    if (filters?.status) conditions.push(eq(tasks.status, filters.status));
    if (filters?.assignedAgentId)
      conditions.push(eq(tasks.assignedAgentId, filters.assignedAgentId));
    if (filters?.projectId) conditions.push(eq(tasks.projectId, filters.projectId));
    if (filters?.taskType) conditions.push(eq(tasks.taskType, filters.taskType));
    return this.db
      .select()
      .from(tasks)
      .where(and(...conditions));
  }

  async listByAgent(agentId: string) {
    return this.db.select().from(tasks).where(eq(tasks.assignedAgentId, agentId));
  }

  async updateBlockedBy(id: string, blockedBy: string[]) {
    await this.db.update(tasks).set({ blockedBy, updatedAt: new Date() }).where(eq(tasks.id, id));
  }

  /**
   * Upsert: guarantee the task row exists in DB before writing child rows
   * (task_logs, task_comments) that reference it via FK.
   */
  async ensureExists(data: {
    id: string;
    orgId: string;
    title: string;
    description?: string;
    priority?: TaskPriority;
    status?: TaskStatus;
    assignedAgentId: string;
    reviewerAgentId: string;
    executionRound?: number;
    requirementId?: string;
    projectId?: string;
    createdBy?: string;
    blockedBy?: string[];
    dueAt?: Date;
    taskType?: string;
    scheduleConfig?: Record<string, unknown>;
    subtasks?: unknown[];
  }) {
    await this.db
      .insert(tasks)
      .values({
        id: data.id,
        orgId: data.orgId,
        title: data.title,
        description: data.description ?? '',
        priority: data.priority ?? 'medium',
        status: data.status ?? 'pending',
        assignedAgentId: data.assignedAgentId,
        reviewerAgentId: data.reviewerAgentId,
        executionRound: data.executionRound ?? 1,
        requirementId: data.requirementId ?? null,
        projectId: data.projectId ?? null,
        createdBy: data.createdBy ?? null,
        blockedBy: data.blockedBy ?? [],
        dueAt: data.dueAt ?? null,
        taskType: data.taskType ?? 'standard',
        scheduleConfig: data.scheduleConfig ?? null,
        subtasks: data.subtasks ?? [],
      })
      .onConflictDoUpdate({
        target: tasks.id,
        set: {
          title: sql`excluded.title`,
          status: sql`excluded.status`,
          assignedAgentId: sql`excluded.assigned_agent_id`,
          executionRound: sql`excluded.execution_round`,
          updatedAt: new Date(),
        },
      });
  }

  async delete(id: string) {
    await this.db.delete(tasks).where(eq(tasks.id, id));
  }
}
