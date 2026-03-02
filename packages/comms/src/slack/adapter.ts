import { createLogger, msgId } from '@markus/shared';
import type { Message } from '@markus/shared';
import type { CommAdapter, CommAdapterConfig, IncomingMessageHandler, SendOptions } from '../adapter.js';
import { SlackClient, type SlackClientConfig } from './client.js';

const log = createLogger('slack-adapter');

export interface SlackAdapterConfig extends CommAdapterConfig {
  platform: 'slack';
  // Slack Bot Token (starts with xoxb-)
  botToken: string;
  // Slack App Token (starts with xapp-)
  appToken?: string;
  // Signing Secret for verifying requests
  signingSecret: string;
  // Webhook configuration
  webhookPort?: number;
  // Optional: Custom API endpoint
  apiUrl?: string;
  // Optional: Socket mode enabled
  socketMode?: boolean;
}

export class SlackAdapter implements CommAdapter {
  readonly platform = 'slack';
  private config?: SlackAdapterConfig;
  private client?: SlackClient;
  private handlers: IncomingMessageHandler[] = [];
  private connected = false;

  async connect(config: CommAdapterConfig): Promise<void> {
    this.config = config as SlackAdapterConfig;
    
    // Create Slack client with the configuration
    const clientConfig: SlackClientConfig = {
      botToken: this.config.botToken,
      appToken: this.config.appToken,
      signingSecret: this.config.signingSecret,
      apiUrl: this.config.apiUrl,
      socketMode: this.config.socketMode,
    };
    
    this.client = new SlackClient(clientConfig);
    
    // TODO: Set up webhook server if webhookPort is specified
    // TODO: Set up Socket Mode if socketMode is enabled
    
    this.connected = true;
    log.info('Slack adapter connected');
  }

  async disconnect(): Promise<void> {
    // Clean up connections
    this.client = undefined;
    this.connected = false;
    log.info('Slack adapter disconnected');
  }

  async sendMessage(channelId: string, content: string, options?: SendOptions): Promise<string> {
    if (!this.config || !this.client) throw new Error('Slack adapter not connected');
    
    try {
      // channelId is the Slack channel ID (e.g., C1234567890)
      const slackOptions: Record<string, unknown> = {};
      if (options?.threadId) {
        slackOptions.thread_ts = options.threadId;
      }
      const messageId = await this.client.sendTextMessage(channelId, content, slackOptions);
      log.info(`Slack message sent to channel ${channelId}: ${messageId}`);
      return messageId;
    } catch (error) {
      log.error(`Failed to send Slack message to ${channelId}:`, { error });
      throw error;
    }
  }

  async sendReply(channelId: string, replyToId: string, content: string): Promise<string> {
    if (!this.config || !this.client) throw new Error('Slack adapter not connected');
    
    try {
      // In Slack, replyToId is the thread_ts (timestamp) of the message to reply to
      const slackOptions: Record<string, unknown> = {
        thread_ts: replyToId,
        reply_broadcast: false,
      };
      const messageId = await this.client.sendTextMessage(channelId, content, slackOptions);
      log.info(`Slack reply sent to channel ${channelId} (in thread ${replyToId}): ${messageId}`);
      return messageId;
    } catch (error) {
      log.error(`Failed to send Slack reply to ${channelId}:`, { error });
      throw error;
    }
  }

  async sendBlocks(channelId: string, blocks: any[], text?: string, options?: SendOptions): Promise<string> {
    if (!this.config || !this.client) throw new Error('Slack adapter not connected');
    
    try {
      const slackOptions: Record<string, unknown> = {};
      if (options?.threadId) {
        slackOptions.thread_ts = options.threadId;
      }
      const messageId = await this.client.sendBlocksMessage(channelId, blocks, text, slackOptions);
      log.info(`Slack blocks message sent to channel ${channelId}: ${messageId}`);
      return messageId;
    } catch (error) {
      log.error(`Failed to send Slack blocks message to ${channelId}:`, { error });
      throw error;
    }
  }

  async updateMessage(channelId: string, messageId: string, content: string): Promise<void> {
    if (!this.config || !this.client) throw new Error('Slack adapter not connected');
    
    try {
      await this.client.updateMessage(channelId, messageId, content, undefined);
      log.info(`Slack message updated in channel ${channelId}: ${messageId}`);
    } catch (error) {
      log.error(`Failed to update Slack message ${messageId} in ${channelId}:`, { error });
      throw error;
    }
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    if (!this.config || !this.client) throw new Error('Slack adapter not connected');
    
    try {
      await this.client.deleteMessage(channelId, messageId);
      log.info(`Slack message deleted from channel ${channelId}: ${messageId}`);
    } catch (error) {
      log.error(`Failed to delete Slack message ${messageId} from ${channelId}:`, { error });
      throw error;
    }
  }

  onMessage(handler: IncomingMessageHandler): void {
    this.handlers.push(handler);
  }

  isConnected(): boolean {
    return this.connected;
  }

  // TODO: Implement webhook handling for incoming messages
  // This would require setting up an HTTP server to receive events from Slack
  // and calling the registered handlers with formatted messages
  
  // TODO: Implement Socket Mode for real-time events
  // This would use the Slack Bolt framework to handle events in real-time
}