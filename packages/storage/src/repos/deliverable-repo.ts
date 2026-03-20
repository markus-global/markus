import { eq, and, desc, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../db.js';
import { deliverables } from '../schema.js';

export interface DeliverableRow {
  id: string;
  type: string;
  title: string;
  summary: string;
  reference: string;
  tags: string[];
  status: string;
  taskId: string | null;
  agentId: string | null;
  projectId: string | null;
  requirementId: string | null;
  artifactType: string | null;
  artifactData: Record<string, unknown> | null;
  diffStats: Record<string, number> | null;
  testResults: Record<string, number> | null;
  accessCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export class DeliverableRepo {
  constructor(private db: Database) {}

  async create(data: {
    id: string;
    type: string;
    title: string;
    summary: string;
    reference?: string;
    tags?: string[];
    status?: string;
    taskId?: string;
    agentId?: string;
    projectId?: string;
    requirementId?: string;
    artifactType?: string;
    artifactData?: Record<string, unknown>;
    diffStats?: Record<string, number>;
    testResults?: Record<string, number>;
  }): Promise<DeliverableRow> {
    const [row] = await this.db.insert(deliverables).values({
      id: data.id,
      type: data.type,
      title: data.title,
      summary: data.summary,
      reference: data.reference ?? '',
      tags: data.tags ?? [],
      status: data.status ?? 'active',
      taskId: data.taskId ?? null,
      agentId: data.agentId ?? null,
      projectId: data.projectId ?? null,
      requirementId: data.requirementId ?? null,
      artifactType: data.artifactType ?? null,
      artifactData: data.artifactData ?? null,
      diffStats: data.diffStats ?? null,
      testResults: data.testResults ?? null,
    }).returning();
    return row as unknown as DeliverableRow;
  }

  async findById(id: string): Promise<DeliverableRow | undefined> {
    const [row] = await this.db.select().from(deliverables)
      .where(eq(deliverables.id, id));
    return row as unknown as DeliverableRow | undefined;
  }

  async search(opts: {
    query?: string;
    projectId?: string;
    agentId?: string;
    taskId?: string;
    type?: string;
    status?: string;
    limit?: number;
  }): Promise<DeliverableRow[]> {
    const conditions: SQL[] = [];
    if (opts.projectId) conditions.push(eq(deliverables.projectId, opts.projectId));
    if (opts.agentId) conditions.push(eq(deliverables.agentId, opts.agentId));
    if (opts.taskId) conditions.push(eq(deliverables.taskId, opts.taskId));
    if (opts.type) conditions.push(eq(deliverables.type, opts.type));
    if (opts.status) conditions.push(eq(deliverables.status, opts.status));
    if (opts.query) {
      conditions.push(
        sql`(${deliverables.title} ILIKE ${'%' + opts.query + '%'} OR ${deliverables.summary} ILIKE ${'%' + opts.query + '%'})`
      );
    }

    const q = this.db.select().from(deliverables);
    const withWhere = conditions.length > 0 ? q.where(and(...conditions)) : q;
    const rows = await withWhere
      .orderBy(desc(deliverables.updatedAt))
      .limit(opts.limit ?? 100);
    return rows as unknown as DeliverableRow[];
  }

  async update(id: string, data: Partial<{
    type: string;
    title: string;
    summary: string;
    reference: string;
    tags: string[];
    status: string;
    projectId: string;
    requirementId: string;
    artifactType: string;
    artifactData: Record<string, unknown>;
  }>): Promise<void> {
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    for (const [key, val] of Object.entries(data)) {
      if (val !== undefined) updates[key] = val;
    }
    await this.db.update(deliverables).set(updates).where(eq(deliverables.id, id));
  }

  async recordAccess(id: string): Promise<void> {
    await this.db.update(deliverables)
      .set({ accessCount: sql`${deliverables.accessCount} + 1` })
      .where(eq(deliverables.id, id));
  }

  async remove(id: string): Promise<void> {
    await this.db.update(deliverables)
      .set({ status: 'outdated', updatedAt: new Date() })
      .where(eq(deliverables.id, id));
  }

  async listAll(limit = 500): Promise<DeliverableRow[]> {
    const rows = await this.db.select().from(deliverables)
      .orderBy(desc(deliverables.updatedAt))
      .limit(limit);
    return rows as unknown as DeliverableRow[];
  }

  async listTaskIdsWithDeliverables(): Promise<Set<string>> {
    const rows = await this.db.selectDistinct({ taskId: deliverables.taskId })
      .from(deliverables)
      .where(sql`${deliverables.taskId} IS NOT NULL`);
    return new Set((rows as Array<{ taskId: string | null }>).filter(r => r.taskId !== null).map(r => r.taskId!));
  }

  async deleteByTask(taskId: string): Promise<void> {
    await this.db.delete(deliverables).where(eq(deliverables.taskId, taskId));
  }
}
