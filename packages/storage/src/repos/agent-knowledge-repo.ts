import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import type { Database } from '../db.js';
import { agentKnowledge } from '../schema.js';

export interface KnowledgeRow {
  id: string;
  agentId: string;
  orgId: string;
  category: string;
  title: string;
  content: string;
  tags: string[];
  source: string;
  metadata: Record<string, unknown>;
  importance: number;
  accessCount: number;
  lastAccessedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export class AgentKnowledgeRepo {
  constructor(private db: Database) {}

  async create(data: {
    id: string;
    agentId: string;
    orgId: string;
    category: string;
    title: string;
    content: string;
    tags?: string[];
    source?: string;
    metadata?: Record<string, unknown>;
    importance?: number;
  }): Promise<KnowledgeRow> {
    const [row] = await this.db.insert(agentKnowledge).values({
      id: data.id,
      agentId: data.agentId,
      orgId: data.orgId,
      category: data.category,
      title: data.title,
      content: data.content,
      tags: data.tags ?? [],
      source: data.source ?? 'agent',
      metadata: data.metadata ?? {},
      importance: data.importance ?? 50,
    }).returning();
    return row as unknown as KnowledgeRow;
  }

  async findById(id: string): Promise<KnowledgeRow | undefined> {
    const [row] = await this.db.select().from(agentKnowledge)
      .where(eq(agentKnowledge.id, id));
    return row as unknown as KnowledgeRow | undefined;
  }

  async findByAgent(agentId: string, opts?: {
    category?: string;
    limit?: number;
  }): Promise<KnowledgeRow[]> {
    const conditions = [eq(agentKnowledge.agentId, agentId)];
    if (opts?.category) conditions.push(eq(agentKnowledge.category, opts.category));

    const rows = await this.db.select().from(agentKnowledge)
      .where(and(...conditions))
      .orderBy(desc(agentKnowledge.updatedAt))
      .limit(opts?.limit ?? 50);
    return rows as unknown as KnowledgeRow[];
  }

  async search(agentId: string, query: string, limit = 10): Promise<KnowledgeRow[]> {
    const rows = await this.db.select().from(agentKnowledge)
      .where(and(
        eq(agentKnowledge.agentId, agentId),
        sql`(${agentKnowledge.title} ILIKE ${'%' + query + '%'} OR ${agentKnowledge.content} ILIKE ${'%' + query + '%'})`,
      ))
      .orderBy(desc(agentKnowledge.importance), desc(agentKnowledge.updatedAt))
      .limit(limit);
    return rows as unknown as KnowledgeRow[];
  }

  async searchByTags(agentId: string, tags: string[], limit = 10): Promise<KnowledgeRow[]> {
    const rows = await this.db.select().from(agentKnowledge)
      .where(and(
        eq(agentKnowledge.agentId, agentId),
        sql`${agentKnowledge.tags} ?| array[${sql.join(tags.map(t => sql`${t}`), sql`, `)}]`,
      ))
      .orderBy(desc(agentKnowledge.importance))
      .limit(limit);
    return rows as unknown as KnowledgeRow[];
  }

  async recordAccess(id: string): Promise<void> {
    await this.db.update(agentKnowledge)
      .set({
        accessCount: sql`${agentKnowledge.accessCount} + 1`,
        lastAccessedAt: new Date(),
      })
      .where(eq(agentKnowledge.id, id));
  }

  async update(id: string, data: Partial<{
    title: string;
    content: string;
    category: string;
    tags: string[];
    importance: number;
    metadata: Record<string, unknown>;
  }>): Promise<void> {
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (data.title !== undefined) updates.title = data.title;
    if (data.content !== undefined) updates.content = data.content;
    if (data.category !== undefined) updates.category = data.category;
    if (data.tags !== undefined) updates.tags = data.tags;
    if (data.importance !== undefined) updates.importance = data.importance;
    if (data.metadata !== undefined) updates.metadata = data.metadata;

    await this.db.update(agentKnowledge).set(updates).where(eq(agentKnowledge.id, id));
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(agentKnowledge).where(eq(agentKnowledge.id, id));
  }

  async deleteByAgent(agentId: string): Promise<void> {
    await this.db.delete(agentKnowledge).where(eq(agentKnowledge.agentId, agentId));
  }

  async countByAgent(agentId: string): Promise<number> {
    const [result] = await this.db.select({ count: sql<number>`count(*)` })
      .from(agentKnowledge)
      .where(eq(agentKnowledge.agentId, agentId));
    return Number(result?.count ?? 0);
  }
}
