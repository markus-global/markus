import { eq, desc, lt, and } from 'drizzle-orm';
import type { Database } from '../db.js';
import { channelMessages } from '../schema.js';
import { generateId } from '@markus/shared';

export interface ChannelMsgMetadata {
  thinking?: string[];
  toolCalls?: Array<{
    tool: string;
    status: 'done' | 'error';
    arguments?: unknown;
    result?: string;
    durationMs?: number;
  }>;
}

export interface ChannelMsg {
  id: string;
  orgId: string;
  channel: string;
  senderId: string;
  senderType: string;
  senderName: string;
  text: string;
  mentions: string[];
  metadata?: ChannelMsgMetadata | null;
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
    metadata?: ChannelMsgMetadata;
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
      metadata: data.metadata ?? {},
    }).returning();
    const r = row!;
    return {
      ...r,
      mentions: (r.mentions ?? []) as string[],
      metadata: (r.metadata ?? null) as ChannelMsgMetadata | null,
    };
  }

  async getMessages(
    channel: string,
    limit = 50,
    before?: string,
  ): Promise<{ messages: ChannelMsg[]; hasMore: boolean }> {
    const conditions = before
      ? and(eq(channelMessages.channel, channel), lt(channelMessages.createdAt, new Date(before)))
      : eq(channelMessages.channel, channel);

    const rows = await this.db.select().from(channelMessages)
      .where(conditions)
      .orderBy(desc(channelMessages.createdAt))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const messages = rows.slice(0, limit)
      .reverse()
      .map(r => ({
        ...r,
        mentions: (r.mentions ?? []) as string[],
        metadata: (r.metadata ?? null) as ChannelMsgMetadata | null,
      }));
    return { messages, hasMore };
  }
}
