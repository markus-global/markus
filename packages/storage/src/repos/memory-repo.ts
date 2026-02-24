import { eq, and, desc, sql } from 'drizzle-orm';
import type { Database } from '../db.js';
import { memories } from '../schema.js';

export class MemoryRepo {
  constructor(private db: Database) {}

  async create(data: {
    id: string;
    agentId: string;
    type: string;
    content: string;
    metadata?: unknown;
  }) {
    const [row] = await this.db.insert(memories).values({
      id: data.id,
      agentId: data.agentId,
      type: data.type,
      content: data.content,
      metadata: data.metadata ?? {},
    }).returning();
    return row!;
  }

  async findByAgent(agentId: string, type?: string, limit = 20) {
    const conditions = [eq(memories.agentId, agentId)];
    if (type) conditions.push(eq(memories.type, type));
    return this.db.select().from(memories)
      .where(and(...conditions))
      .orderBy(desc(memories.createdAt))
      .limit(limit);
  }

  async search(agentId: string, query: string, limit = 10) {
    return this.db.select().from(memories)
      .where(and(
        eq(memories.agentId, agentId),
        sql`${memories.content} ILIKE ${'%' + query + '%'}`,
      ))
      .orderBy(desc(memories.createdAt))
      .limit(limit);
  }

  async deleteByAgent(agentId: string) {
    await this.db.delete(memories).where(eq(memories.agentId, agentId));
  }
}
