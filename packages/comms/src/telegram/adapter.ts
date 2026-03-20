import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createLogger, msgId, type Message } from '@markus/shared';
import type { CommAdapter, CommAdapterConfig, IncomingMessageHandler, SendOptions } from '../adapter.js';
import { TelegramClient, type TelegramClientConfig, type TelegramMessage } from './client.js';

const log = createLogger('telegram-adapter');

export interface TelegramAdapterConfig extends CommAdapterConfig {
  platform: 'telegram';
  botToken: string;
  webhookPort?: number;
  webhookSecret?: string;
  webhookPath?: string;
  apiUrl?: string;
  pollingEnabled?: boolean;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
}

export class TelegramAdapter implements CommAdapter {
  readonly platform = 'telegram';
  private config?: TelegramAdapterConfig;
  private client?: TelegramClient;
  private handlers: IncomingMessageHandler[] = [];
  private server?: ReturnType<typeof createServer>;
  private connected = false;

  async connect(config: CommAdapterConfig): Promise<void> {
    this.config = config as TelegramAdapterConfig;
    
    // Create Telegram client with the configuration
    const clientConfig: TelegramClientConfig = {
      botToken: this.config.botToken,
      apiUrl: this.config.apiUrl,
      pollingEnabled: this.config.pollingEnabled,
    };
    
    this.client = new TelegramClient(clientConfig);

    // Test connection by getting bot info
    try {
      const botInfo = await this.client.getMe();
      log.info(`Telegram bot connected: @${botInfo.username} (${botInfo.first_name})`);
    } catch (error) {
      log.error('Failed to connect to Telegram:', { error });
      throw error;
    }

    // Set up webhook if webhookPort is specified
    if (this.config.webhookPort) {
      await this.setupWebhook();
    }

    this.connected = true;
    log.info('Telegram adapter connected');
  }

  async disconnect(): Promise<void> {
    // Clean up webhook if it was set up
    if (this.config?.webhookPort && this.server) {
      this.server.close();
      log.info('Telegram webhook server stopped');
    }

    this.client = undefined;
    this.connected = false;
    log.info('Telegram adapter disconnected');
  }

  async sendMessage(channelId: string, content: string, options?: SendOptions): Promise<string> {
    if (!this.config || !this.client) throw new Error('Telegram adapter not connected');
    
    try {
      // channelId is the chat ID (can be number or string starting with @ for usernames)
      const chatId = channelId.startsWith('@') ? channelId : Number(channelId);
      
      const message = await this.client.sendMessage({
        chat_id: chatId,
        text: content,
        parse_mode: options?.richText ? 'Markdown' : undefined,
        disable_notification: false,
      });

      log.info(`Telegram message sent to ${channelId}: ${message.message_id}`);
      return message.message_id.toString();
    } catch (error) {
      log.error(`Failed to send Telegram message to ${channelId}:`, { error });
      throw error;
    }
  }

  async sendReply(channelId: string, replyToId: string, content: string): Promise<string> {
    if (!this.config || !this.client) throw new Error('Telegram adapter not connected');
    
    try {
      const chatId = channelId.startsWith('@') ? channelId : Number(channelId);
      const replyToMessageId = Number(replyToId);
      
      const message = await this.client.sendMessage({
        chat_id: chatId,
        text: content,
        reply_to_message_id: replyToMessageId,
      });

      log.info(`Telegram reply sent to ${channelId} (in response to ${replyToId}): ${message.message_id}`);
      return message.message_id.toString();
    } catch (error) {
      log.error(`Failed to send Telegram reply to ${channelId}:`, { error });
      throw error;
    }
  }

  async sendBlocks(channelId: string, blocks: any[], text?: string, options?: SendOptions): Promise<string> {
    if (!this.config || !this.client) throw new Error('Telegram adapter not connected');
    
    try {
      // Telegram doesn't support rich blocks like Slack, so we send text content
      const content = text || this.blocksToText(blocks);
      const chatId = channelId.startsWith('@') ? channelId : Number(channelId);
      
      const message = await this.client.sendMessage({
        chat_id: chatId,
        text: content,
        parse_mode: 'HTML', // Use HTML for basic formatting
      });
      
      log.info(`Telegram blocks message sent to channel ${channelId}: ${message.message_id}`);
      return message.message_id.toString();
    } catch (error) {
      log.error(`Failed to send Telegram blocks message to ${channelId}:`, { error });
      throw error;
    }
  }

  async updateMessage(channelId: string, messageId: string, content: string): Promise<void> {
    if (!this.config || !this.client) throw new Error('Telegram adapter not connected');
    
    try {
      const chatId = channelId.startsWith('@') ? channelId : Number(channelId);
      const msgId = Number(messageId);
      
      // Telegram doesn't have a direct update message API, so we send a new message
      // and optionally delete the old one
      await this.client.sendMessage({
        chat_id: chatId,
        text: `(Updated) ${content}`,
      } as any);
      
      log.info(`Telegram message update simulated for message ${messageId} in channel ${channelId}`);
    } catch (error) {
      log.error(`Failed to update Telegram message ${messageId} in ${channelId}:`, { error });
      throw error;
    }
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    if (!this.config || !this.client) throw new Error('Telegram adapter not connected');
    
    try {
      // Telegram doesn't have a delete message API in this client
      // We'll log it but not actually delete
      log.warn(`Telegram message deletion requested for message ${messageId} in channel ${channelId}, but not implemented`);
    } catch (error) {
      log.error(`Failed to delete Telegram message ${messageId} in ${channelId}:`, { error });
      throw error;
    }
  }

  private blocksToText(blocks: any[]): string {
    // Convert blocks to plain text for Telegram
    let text = '';
    for (const block of blocks) {
      if (block.type === 'section') {
        if (block.text?.text) {
          text += block.text.text + '\n';
        }
      } else if (block.type === 'header') {
        if (block.text?.text) {
          text += `# ${block.text.text}\n`;
        }
      } else if (block.type === 'divider') {
        text += '---\n';
      }
    }
    return text.trim();
  }

  onMessage(handler: IncomingMessageHandler): void {
    this.handlers.push(handler);
  }

  isConnected(): boolean {
    return this.connected;
  }

  private async setupWebhook(): Promise<void> {
    if (!this.config || !this.client) return;

    const { webhookPort, webhookSecret, webhookPath = '/webhook/telegram' } = this.config;
    
    // Determine webhook URL (assuming localhost for development)
    const webhookUrl = `http://localhost:${webhookPort}${webhookPath}`;
    
    try {
      // Set webhook with Telegram API
      await this.client.setWebhook(webhookUrl, webhookSecret);
      log.info(`Telegram webhook set to ${webhookUrl}`);
    } catch (error) {
      log.error('Failed to set Telegram webhook:', { error });
      throw error;
    }

    // Create HTTP server to handle webhook requests
    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST' || req.url !== webhookPath) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      // Verify secret token if configured
      if (webhookSecret) {
        const secretHeader = req.headers['x-telegram-bot-api-secret-token'];
        if (secretHeader !== webhookSecret) {
          log.warn('Invalid webhook secret token');
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }
      }

      try {
        // Read request body
        const body = await this.readRequestBody(req);
        const update: TelegramUpdate = JSON.parse(body);

        // Process the update
        await this.processUpdate(update);

        res.writeHead(200);
        res.end('OK');
      } catch (error) {
        log.error('Error processing Telegram webhook:', { error });
        res.writeHead(500);
        res.end('Internal Server Error');
      }
    });

    this.server.listen(webhookPort, () => {
      log.info(`Telegram webhook server listening on port ${webhookPort}`);
    });
  }

  private async processUpdate(update: TelegramUpdate): Promise<void> {
    // Handle different types of updates
    const message = update.message || update.edited_message || update.channel_post || update.edited_channel_post;
    
    if (!message || !message.text) {
      return; // Ignore non-text messages for now
    }

    // Format message for Markus
    const formattedMessage: Message = {
      id: msgId(),
      platform: 'telegram',
      direction: 'inbound',
      channelId: message.chat.id.toString(),
      senderId: message.from?.id.toString() || 'unknown',
      senderName: message.from?.username || message.from?.first_name || 'Unknown User',
      agentId: '', // Will be set by router
      content: {
        type: 'text',
        text: message.text || '',
      },
      timestamp: new Date(message.date * 1000).toISOString(),
    };

    // Call registered handlers
    for (const handler of this.handlers) {
      try {
        await handler(formattedMessage);
      } catch (error) {
        log.error('Error in Telegram message handler:', { error });
      }
    }
  }

  private readRequestBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        resolve(body);
      });
      req.on('error', reject);
    });
  }
}