import { createLogger, msgId, type Message } from '@markus/shared';
import type { CommAdapter, CommAdapterConfig, IncomingMessageHandler, SendOptions } from '../adapter.js';
import { DiscordClient, type DiscordClientConfig, type DiscordMessage } from './client.js';

const log = createLogger('discord-adapter');

export interface DiscordAdapterConfig extends CommAdapterConfig {
  platform: 'discord';
  botToken: string;
  apiUrl?: string;
  gatewayUrl?: string;
  reconnectDelaysMs?: number[];
}

export class DiscordAdapter implements CommAdapter {
  readonly platform = 'discord';

  private client?: DiscordClient;
  private connected = false;
  private handlers: IncomingMessageHandler[] = [];

  async connect(config: CommAdapterConfig): Promise<void> {
    await this.disconnect();
    const discordConfig = config as DiscordAdapterConfig;
    const clientConfig: DiscordClientConfig = {
      botToken: discordConfig.botToken,
      apiUrl: discordConfig.apiUrl,
      gatewayUrl: discordConfig.gatewayUrl,
      reconnectDelaysMs: discordConfig.reconnectDelaysMs,
    };

    const client = new DiscordClient(clientConfig);

    await client.connect((message) => this.handleMessage(message));

    this.client = client;
    this.connected = true;
  }

  disconnect(): Promise<void> {
    this.client?.disconnect();
    this.client = undefined;
    this.connected = false;
    return Promise.resolve();
  }

  async sendMessage(channelId: string, content: string, _options?: SendOptions): Promise<string> {
    if (!this.client || !this.isConnected()) {
      throw new Error('Discord adapter not connected');
    }

    const message = await this.client.sendMessage(channelId, content);
    return message.id;
  }

  async sendReply(channelId: string, replyToId: string, content: string): Promise<string> {
    if (!this.client || !this.isConnected()) {
      throw new Error('Discord adapter not connected');
    }

    const message = await this.client.sendReply(channelId, replyToId, content);
    return message.id;
  }

  onMessage(handler: IncomingMessageHandler): void {
    this.handlers.push(handler);
  }

  isConnected(): boolean {
    return this.connected && (this.client?.isConnected() ?? false);
  }

  private async handleMessage(message: DiscordMessage): Promise<void> {
    if (message.author.bot || !message.content) {
      return;
    }

    const mapped: Message = {
      id: msgId(),
      platform: 'discord',
      direction: 'inbound',
      channelId: message.channel_id,
      senderId: message.author.id,
      senderName: message.author.username,
      agentId: '',
      content: {
        type: 'text',
        text: message.content,
      },
      replyToId: message.message_reference?.message_id,
      threadId: message.id,
      timestamp: message.timestamp,
    };

    for (const handler of this.handlers) {
      try {
        await handler(mapped);
      } catch (error) {
        log.error('Discord message handler failed', { error: String(error) });
      }
    }
  }
}
