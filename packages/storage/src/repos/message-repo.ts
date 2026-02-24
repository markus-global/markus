import { eq, and, desc } from 'drizzle-orm';
import type { Database } from '../db.js';
import { messages } from '../schema.js';

type MessagePlatform = 'feishu' | 'whatsapp' | 'slack' | 'telegram' | 'webui' | 'internal';
type MessageDirection = 'inbound' | 'outbound';

export class MessageRepo {
  constructor(private db: Database) {}

  async create(data: {
    id: string;
    platform: MessagePlatform;
    direction: MessageDirection;
    channelId: string;
    senderId: string;
    senderName?: string;
    agentId?: string;
    content: unknown;
    replyToId?: string;
    threadId?: string;
  }) {
    const [row] = await this.db.insert(messages).values({
      id: data.id,
      platform: data.platform,
      direction: data.direction,
      channelId: data.channelId,
      senderId: data.senderId,
      senderName: data.senderName ?? null,
      agentId: data.agentId ?? null,
      content: data.content,
      replyToId: data.replyToId ?? null,
      threadId: data.threadId ?? null,
    }).returning();
    return row!;
  }

  async findByChannel(channelId: string, limit = 50) {
    return this.db.select().from(messages)
      .where(eq(messages.channelId, channelId))
      .orderBy(desc(messages.createdAt))
      .limit(limit);
  }

  async findByAgent(agentId: string, limit = 50) {
    return this.db.select().from(messages)
      .where(eq(messages.agentId, agentId))
      .orderBy(desc(messages.createdAt))
      .limit(limit);
  }

  async findByThread(threadId: string) {
    return this.db.select().from(messages)
      .where(eq(messages.threadId, threadId))
      .orderBy(messages.createdAt);
  }
}
