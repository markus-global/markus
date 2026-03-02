import { eq, and, desc, sql, ilike, or } from 'drizzle-orm';
import type { Database } from '../db.js';
import { marketplaceSkills } from '../schema.js';

export interface MarketplaceSkillRow {
  id: string;
  name: string;
  description: string;
  source: 'official' | 'community' | 'custom';
  status: 'draft' | 'pending_review' | 'published' | 'rejected' | 'archived';
  version: string;
  authorId: string | null;
  authorName: string;
  category: string;
  tags: string[];
  tools: Array<{ name: string; description: string }>;
  readme: string | null;
  requiredPermissions: string[];
  requiredEnv: string[];
  config: Record<string, unknown>;
  downloadCount: number;
  avgRating: number;
  ratingCount: number;
  createdAt: Date;
  updatedAt: Date;
  publishedAt: Date | null;
}

export class MarketplaceSkillRepo {
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
    category: string;
    tags?: string[];
    tools?: Array<{ name: string; description: string }>;
    readme?: string;
    requiredPermissions?: string[];
    requiredEnv?: string[];
    config?: Record<string, unknown>;
  }): Promise<MarketplaceSkillRow> {
    const [row] = await this.db.insert(marketplaceSkills).values({
      id: data.id,
      name: data.name,
      description: data.description,
      source: data.source ?? 'community',
      status: data.status ?? 'draft',
      version: data.version ?? '1.0.0',
      authorId: data.authorId,
      authorName: data.authorName,
      category: data.category,
      tags: data.tags ?? [],
      tools: data.tools ?? [],
      readme: data.readme,
      requiredPermissions: data.requiredPermissions ?? [],
      requiredEnv: data.requiredEnv ?? [],
      config: data.config ?? {},
      publishedAt: data.status === 'published' ? new Date() : null,
    }).returning();
    return row as unknown as MarketplaceSkillRow;
  }

  async findById(id: string): Promise<MarketplaceSkillRow | undefined> {
    const [row] = await this.db.select().from(marketplaceSkills)
      .where(eq(marketplaceSkills.id, id));
    return row as unknown as MarketplaceSkillRow | undefined;
  }

  async list(opts?: {
    source?: 'official' | 'community' | 'custom';
    status?: string;
    category?: string;
    limit?: number;
    offset?: number;
  }): Promise<MarketplaceSkillRow[]> {
    const conditions = [];
    if (opts?.source) conditions.push(eq(marketplaceSkills.source, opts.source));
    if (opts?.status) conditions.push(eq(marketplaceSkills.status, opts.status as MarketplaceSkillRow['status']));
    if (opts?.category) conditions.push(eq(marketplaceSkills.category, opts.category));

    let query = this.db.select().from(marketplaceSkills)
      .orderBy(desc(marketplaceSkills.downloadCount), desc(marketplaceSkills.avgRating));

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as typeof query;
    }

    const rows = await query.limit(opts?.limit ?? 50).offset(opts?.offset ?? 0);
    return rows as unknown as MarketplaceSkillRow[];
  }

  async search(query: string, opts?: {
    source?: 'official' | 'community' | 'custom';
    category?: string;
    limit?: number;
  }): Promise<MarketplaceSkillRow[]> {
    const conditions = [
      eq(marketplaceSkills.status, 'published'),
      or(
        ilike(marketplaceSkills.name, `%${query}%`),
        ilike(marketplaceSkills.description, `%${query}%`),
      ),
    ];
    if (opts?.source) conditions.push(eq(marketplaceSkills.source, opts.source));
    if (opts?.category) conditions.push(eq(marketplaceSkills.category, opts.category));

    const rows = await this.db.select().from(marketplaceSkills)
      .where(and(...conditions))
      .orderBy(desc(marketplaceSkills.downloadCount))
      .limit(opts?.limit ?? 20);
    return rows as unknown as MarketplaceSkillRow[];
  }

  async updateStatus(id: string, status: MarketplaceSkillRow['status']): Promise<void> {
    const updates: Record<string, unknown> = { status, updatedAt: new Date() };
    if (status === 'published') updates.publishedAt = new Date();
    await this.db.update(marketplaceSkills).set(updates).where(eq(marketplaceSkills.id, id));
  }

  async incrementDownloads(id: string): Promise<void> {
    await this.db.update(marketplaceSkills)
      .set({ downloadCount: sql`${marketplaceSkills.downloadCount} + 1` })
      .where(eq(marketplaceSkills.id, id));
  }

  async updateRating(id: string, avgRating: number, ratingCount: number): Promise<void> {
    await this.db.update(marketplaceSkills)
      .set({ avgRating: Math.round(avgRating), ratingCount, updatedAt: new Date() })
      .where(eq(marketplaceSkills.id, id));
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(marketplaceSkills).where(eq(marketplaceSkills.id, id));
  }
}
