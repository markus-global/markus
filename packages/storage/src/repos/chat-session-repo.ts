import { eq, desc, lt, and } from 'drizzle-orm';
import type { Database } from '../db.js';
import { chatSessions, chatMessages } from '../schema.js';
import { generateId } from '@markus/shared';

export interface ChatSession {
  id: string;
  agentId: string;
  userId: string | null;
  title: string | null;
  createdAt: Date;
  lastMessageAt: Date;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  agentId: string;
  role: string;
  content: string;
  tokensUsed: number;
  createdAt: Date;
}

export class ChatSessionRepo {
  constructor(private db: Database) {}

  async createSession(agentId: string, userId?: string): Promise<ChatSession> {
    const [row] = await this.db.insert(chatSessions).values({
      id: generateId('ses'),
      agentId,
      userId: userId ?? null,
      title: null,
      lastMessageAt: new Date(),
    }).returning();
    return row!;
  }

  async getSessionsByAgent(agentId: string, limit = 20): Promise<ChatSession[]> {
    return this.db.select().from(chatSessions)
      .where(eq(chatSessions.agentId, agentId))
      .orderBy(desc(chatSessions.lastMessageAt))
      .limit(limit);
  }

  async getSession(sessionId: string): Promise<ChatSession | null> {
    const [row] = await this.db.select().from(chatSessions)
      .where(eq(chatSessions.id, sessionId))
      .limit(1);
    return row ?? null;
  }

  async updateLastMessage(sessionId: string, title?: string): Promise<void> {
    const updates: Partial<typeof chatSessions.$inferInsert> = {
      lastMessageAt: new Date(),
    };
    if (title) updates.title = title;
    await this.db.update(chatSessions)
      .set(updates)
      .where(eq(chatSessions.id, sessionId));
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.db.delete(chatSessions).where(eq(chatSessions.id, sessionId));
  }

  // ── Messages ──────────────────────────────────────────────────────────────

  async appendMessage(
    sessionId: string,
    agentId: string,
    role: string,
    content: string,
    tokensUsed = 0,
  ): Promise<ChatMessage> {
    const [row] = await this.db.insert(chatMessages).values({
      id: generateId('msg'),
      sessionId,
      agentId,
      role,
      content,
      tokensUsed,
    }).returning();
    return row!;
  }

  async getMessages(
    sessionId: string,
    limit = 50,
    before?: string,
  ): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
    const conditions = before
      ? and(
          eq(chatMessages.sessionId, sessionId),
          lt(chatMessages.id, before),
        )
      : eq(chatMessages.sessionId, sessionId);

    // Fetch one extra to determine hasMore
    const rows = await this.db.select().from(chatMessages)
      .where(conditions)
      .orderBy(desc(chatMessages.createdAt))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const messages = rows.slice(0, limit).reverse(); // chronological order
    return { messages, hasMore };
  }

  async getMessageCount(sessionId: string): Promise<number> {
    const rows = await this.db.select({ id: chatMessages.id })
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId));
    return rows.length;
  }
}
