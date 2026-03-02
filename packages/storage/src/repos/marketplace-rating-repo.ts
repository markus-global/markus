import { eq, and, desc, sql, avg } from 'drizzle-orm';
import type { Database } from '../db.js';
import { marketplaceRatings } from '../schema.js';

export interface MarketplaceRatingRow {
  id: string;
  targetType: 'template' | 'skill';
  targetId: string;
  userId: string;
  rating: number;
  review: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class MarketplaceRatingRepo {
  constructor(private db: Database) {}

  async create(data: {
    id: string;
    targetType: 'template' | 'skill';
    targetId: string;
    userId: string;
    rating: number;
    review?: string;
  }): Promise<MarketplaceRatingRow> {
    const [row] = await this.db.insert(marketplaceRatings).values({
      id: data.id,
      targetType: data.targetType,
      targetId: data.targetId,
      userId: data.userId,
      rating: Math.min(5, Math.max(1, data.rating)),
      review: data.review ?? null,
    }).returning();
    return row as unknown as MarketplaceRatingRow;
  }

  async findByTarget(targetType: 'template' | 'skill', targetId: string, opts?: {
    limit?: number;
    offset?: number;
  }): Promise<MarketplaceRatingRow[]> {
    const rows = await this.db.select().from(marketplaceRatings)
      .where(and(
        eq(marketplaceRatings.targetType, targetType),
        eq(marketplaceRatings.targetId, targetId),
      ))
      .orderBy(desc(marketplaceRatings.createdAt))
      .limit(opts?.limit ?? 20)
      .offset(opts?.offset ?? 0);
    return rows as unknown as MarketplaceRatingRow[];
  }

  async findByUser(userId: string, targetType?: 'template' | 'skill'): Promise<MarketplaceRatingRow[]> {
    const conditions = [eq(marketplaceRatings.userId, userId)];
    if (targetType) conditions.push(eq(marketplaceRatings.targetType, targetType));
    const rows = await this.db.select().from(marketplaceRatings)
      .where(and(...conditions))
      .orderBy(desc(marketplaceRatings.createdAt));
    return rows as unknown as MarketplaceRatingRow[];
  }

  async findUserRating(userId: string, targetType: 'template' | 'skill', targetId: string): Promise<MarketplaceRatingRow | undefined> {
    const [row] = await this.db.select().from(marketplaceRatings)
      .where(and(
        eq(marketplaceRatings.userId, userId),
        eq(marketplaceRatings.targetType, targetType),
        eq(marketplaceRatings.targetId, targetId),
      ));
    return row as unknown as MarketplaceRatingRow | undefined;
  }

  async update(id: string, data: { rating?: number; review?: string }): Promise<void> {
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (data.rating !== undefined) updates.rating = Math.min(5, Math.max(1, data.rating));
    if (data.review !== undefined) updates.review = data.review;
    await this.db.update(marketplaceRatings).set(updates).where(eq(marketplaceRatings.id, id));
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(marketplaceRatings).where(eq(marketplaceRatings.id, id));
  }

  async getAggregation(targetType: 'template' | 'skill', targetId: string): Promise<{ avg: number; count: number }> {
    const [result] = await this.db.select({
      avgRating: avg(marketplaceRatings.rating),
      count: sql<number>`count(*)`,
    }).from(marketplaceRatings)
      .where(and(
        eq(marketplaceRatings.targetType, targetType),
        eq(marketplaceRatings.targetId, targetId),
      ));
    return {
      avg: result?.avgRating ? Number(result.avgRating) : 0,
      count: Number(result?.count ?? 0),
    };
  }
}
