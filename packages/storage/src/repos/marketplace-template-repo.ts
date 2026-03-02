import { eq, and, desc, sql, ilike, or } from 'drizzle-orm';
import type { Database } from '../db.js';
import { marketplaceTemplates } from '../schema.js';

export interface MarketplaceTemplateRow {
  id: string;
  name: string;
  description: string;
  source: 'official' | 'community' | 'custom';
  status: 'draft' | 'pending_review' | 'published' | 'rejected' | 'archived';
  version: string;
  authorId: string | null;
  authorName: string;
  roleId: string;
  agentRole: string;
  skills: string[];
  llmProvider: string | null;
  tags: string[];
  category: string;
  icon: string | null;
  heartbeatIntervalMs: number | null;
  starterTasks: Array<{ title: string; description: string; priority: string }>;
  config: Record<string, unknown>;
  downloadCount: number;
  avgRating: number;
  ratingCount: number;
  createdAt: Date;
  updatedAt: Date;
  publishedAt: Date | null;
}

export class MarketplaceTemplateRepo {
  constructor(private db: Database) {}

  async create(data: {
    id: string;
    name: string;
    description: string;
    source?: 'official' | 'community' | 'custom';
    status?: 'draft' | 'pending_review' | 'published';
    version?: string;
    authorId?: string;
    authorName: string;
    roleId: string;
    agentRole?: string;
    skills?: string[];
    llmProvider?: string;
    tags?: string[];
    category: string;
    icon?: string;
    heartbeatIntervalMs?: number;
    starterTasks?: Array<{ title: string; description: string; priority: string }>;
    config?: Record<string, unknown>;
  }): Promise<MarketplaceTemplateRow> {
    const [row] = await this.db.insert(marketplaceTemplates).values({
      id: data.id,
      name: data.name,
      description: data.description,
      source: data.source ?? 'community',
      status: data.status ?? 'draft',
      version: data.version ?? '1.0.0',
      authorId: data.authorId,
      authorName: data.authorName,
      roleId: data.roleId,
      agentRole: data.agentRole ?? 'worker',
      skills: data.skills ?? [],
      llmProvider: data.llmProvider,
      tags: data.tags ?? [],
      category: data.category,
      icon: data.icon,
      heartbeatIntervalMs: data.heartbeatIntervalMs,
      starterTasks: data.starterTasks ?? [],
      config: data.config ?? {},
      publishedAt: data.status === 'published' ? new Date() : null,
    }).returning();
    return row as unknown as MarketplaceTemplateRow;
  }

  async findById(id: string): Promise<MarketplaceTemplateRow | undefined> {
    const [row] = await this.db.select().from(marketplaceTemplates)
      .where(eq(marketplaceTemplates.id, id));
    return row as unknown as MarketplaceTemplateRow | undefined;
  }

  async list(opts?: {
    source?: 'official' | 'community' | 'custom';
    status?: string;
    category?: string;
    limit?: number;
    offset?: number;
  }): Promise<MarketplaceTemplateRow[]> {
    const conditions = [];
    if (opts?.source) conditions.push(eq(marketplaceTemplates.source, opts.source));
    if (opts?.status) conditions.push(eq(marketplaceTemplates.status, opts.status as MarketplaceTemplateRow['status']));
    if (opts?.category) conditions.push(eq(marketplaceTemplates.category, opts.category));

    let query = this.db.select().from(marketplaceTemplates)
      .orderBy(desc(marketplaceTemplates.downloadCount), desc(marketplaceTemplates.avgRating));

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as typeof query;
    }

    const rows = await query.limit(opts?.limit ?? 50).offset(opts?.offset ?? 0);
    return rows as unknown as MarketplaceTemplateRow[];
  }

  async search(query: string, opts?: {
    source?: 'official' | 'community' | 'custom';
    category?: string;
    limit?: number;
  }): Promise<MarketplaceTemplateRow[]> {
    const conditions = [
      eq(marketplaceTemplates.status, 'published'),
      or(
        ilike(marketplaceTemplates.name, `%${query}%`),
        ilike(marketplaceTemplates.description, `%${query}%`),
      ),
    ];
    if (opts?.source) conditions.push(eq(marketplaceTemplates.source, opts.source));
    if (opts?.category) conditions.push(eq(marketplaceTemplates.category, opts.category));

    const rows = await this.db.select().from(marketplaceTemplates)
      .where(and(...conditions))
      .orderBy(desc(marketplaceTemplates.downloadCount))
      .limit(opts?.limit ?? 20);
    return rows as unknown as MarketplaceTemplateRow[];
  }

  async updateStatus(id: string, status: MarketplaceTemplateRow['status']): Promise<void> {
    const updates: Record<string, unknown> = { status, updatedAt: new Date() };
    if (status === 'published') updates.publishedAt = new Date();
    await this.db.update(marketplaceTemplates).set(updates).where(eq(marketplaceTemplates.id, id));
  }

  async incrementDownloads(id: string): Promise<void> {
    await this.db.update(marketplaceTemplates)
      .set({ downloadCount: sql`${marketplaceTemplates.downloadCount} + 1` })
      .where(eq(marketplaceTemplates.id, id));
  }

  async updateRating(id: string, avgRating: number, ratingCount: number): Promise<void> {
    await this.db.update(marketplaceTemplates)
      .set({ avgRating: Math.round(avgRating), ratingCount, updatedAt: new Date() })
      .where(eq(marketplaceTemplates.id, id));
  }

  async update(id: string, data: Partial<{
    name: string;
    description: string;
    version: string;
    skills: string[];
    tags: string[];
    category: string;
    icon: string;
    config: Record<string, unknown>;
  }>): Promise<void> {
    await this.db.update(marketplaceTemplates)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(marketplaceTemplates.id, id));
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(marketplaceTemplates).where(eq(marketplaceTemplates.id, id));
  }

  async countBySource(): Promise<Record<string, number>> {
    const rows = await this.db.select({
      source: marketplaceTemplates.source,
      count: sql<number>`count(*)`,
    }).from(marketplaceTemplates)
      .where(eq(marketplaceTemplates.status, 'published'))
      .groupBy(marketplaceTemplates.source);
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.source] = Number(row.count);
    }
    return result;
  }
}
