import { eq, desc, lt, and } from 'drizzle-orm';
import type { Database } from '../db.js';
import { channelMessages } from '../schema.js';
import { generateId } from '@markus/shared';

export interface ChannelMsg {
  id: string;
  orgId: string;
  channel: string;
  senderId: string;
  senderType: string;
  senderName: string;
  text: string;
  mentions: string[];
  createdAt: Date;
}

export class ChannelMessageRepo {
  constructor(private db: Database) {}

  async append(data: {
    orgId: string;
    channel: string;
    senderId: string;
    senderType: string;
    senderName: string;
    text: string;
    mentions?: string[];
  }): Promise<ChannelMsg> {
    const [row] = await this.db.insert(channelMessages).values({
      id: generateId('cm'),
      orgId: data.orgId,
      channel: data.channel,
      senderId: data.senderId,
      senderType: data.senderType,
      senderName: data.senderName,
      text: data.text,
      mentions: data.mentions ?? [],
    }).returning();
    const r = row!;
    return { ...r, mentions: (r.mentions ?? []) as string[] };
  }

  async getMessages(
    channel: string,
    limit = 50,
    before?: string,
  ): Promise<{ messages: ChannelMsg[]; hasMore: boolean }> {
    const conditions = before
      ? and(eq(channelMessages.channel, channel), lt(channelMessages.id, before))
      : eq(channelMessages.channel, channel);

    const rows = await this.db.select().from(channelMessages)
      .where(conditions)
      .orderBy(desc(channelMessages.createdAt))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const messages = rows.slice(0, limit)
      .reverse()
      .map(r => ({ ...r, mentions: (r.mentions ?? []) as string[] }));
    return { messages, hasMore };
  }
}
