import { createLogger, msgId } from '@markus/shared';
import type { Message } from '@markus/shared';
import type { CommAdapter, CommAdapterConfig, IncomingMessageHandler, SendOptions } from '../adapter.js';
import { WhatsAppClient, type WhatsAppClientConfig } from './client.js';

const log = createLogger('whatsapp-adapter');

export interface WhatsAppAdapterConfig extends CommAdapterConfig {
  platform: 'whatsapp';
  // WhatsApp Business API credentials
  phoneNumberId: string;
  accessToken: string;
  businessAccountId: string;
  // Webhook configuration
  webhookVerifyToken?: string;
  webhookPort?: number;
  // Optional: For sandbox/testing
  apiVersion?: string;
  baseUrl?: string;
}

export class WhatsAppAdapter implements CommAdapter {
  readonly platform = 'whatsapp';
  private config?: WhatsAppAdapterConfig;
  private client?: WhatsAppClient;
  private handlers: IncomingMessageHandler[] = [];
  private connected = false;

  async connect(config: CommAdapterConfig): Promise<void> {
    this.config = config as WhatsAppAdapterConfig;
    
    // Create WhatsApp client with the configuration
    const clientConfig: WhatsAppClientConfig = {
      phoneNumberId: this.config.phoneNumberId,
      accessToken: this.config.accessToken,
      businessAccountId: this.config.businessAccountId,
      apiVersion: this.config.apiVersion,
      baseUrl: this.config.baseUrl,
    };
    
    this.client = new WhatsAppClient(clientConfig);
    
    // TODO: Set up webhook server if webhookPort is specified
    // TODO: Register webhook with WhatsApp API if needed
    
    this.connected = true;
    log.info('WhatsApp adapter connected');
  }

  async disconnect(): Promise<void> {
    // Clean up connections
    this.client = undefined;
    this.connected = false;
    log.info('WhatsApp adapter disconnected');
  }

  async sendMessage(channelId: string, content: string, options?: SendOptions): Promise<string> {
    if (!this.config || !this.client) throw new Error('WhatsApp adapter not connected');
    
    try {
      // channelId is the recipient phone number (e.g., +1234567890)
      const messageId = await this.client.sendTextMessage(channelId, content);
      log.info(`WhatsApp message sent to ${channelId}: ${messageId}`);
      return messageId;
    } catch (error) {
      log.error(`Failed to send WhatsApp message to ${channelId}:`, error);
      throw error;
    }
  }

  async sendReply(channelId: string, replyToId: string, content: string): Promise<string> {
    if (!this.config || !this.client) throw new Error('WhatsApp adapter not connected');
    
    // WhatsApp doesn't have a direct reply API like some platforms
    // We'll send a regular message but could prefix with "Re: " or similar
    const replyContent = `Re: ${content}`;
    
    try {
      const messageId = await this.client.sendTextMessage(channelId, replyContent);
      log.info(`WhatsApp reply sent to ${channelId} (in response to ${replyToId}): ${messageId}`);
      return messageId;
    } catch (error) {
      log.error(`Failed to send WhatsApp reply to ${channelId}:`, error);
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
  // This would require setting up an HTTP server to receive webhooks from WhatsApp
  // and calling the registered handlers with formatted messages
}