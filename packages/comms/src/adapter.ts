import type { Message } from '@markus/shared';

export interface CommAdapterConfig {
  platform: string;
  [key: string]: unknown;
}

export interface IncomingMessageHandler {
  (message: Message): Promise<void>;
}

export interface CommAdapter {
  readonly platform: string;
  connect(config: CommAdapterConfig): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(channelId: string, content: string, options?: SendOptions): Promise<string>;
  sendReply(channelId: string, replyToId: string, content: string): Promise<string>;
  onMessage(handler: IncomingMessageHandler): void;
  isConnected(): boolean;
}

export interface SendOptions {
  threadId?: string;
  richText?: boolean;
  mentionUserIds?: string[];
}
