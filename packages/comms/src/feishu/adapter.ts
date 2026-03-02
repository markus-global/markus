import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createLogger, msgId } from '@markus/shared';
import type { Message } from '@markus/shared';
import type { CommAdapter, CommAdapterConfig, IncomingMessageHandler, SendOptions } from '../adapter.js';
import { FeishuClient } from './client.js';
import { createHmac } from 'node:crypto';

const log = createLogger('feishu-adapter');

export interface FeishuAdapterConfig extends CommAdapterConfig {
  platform: 'feishu';
  appId: string;
  appSecret: string;
  verificationToken?: string;
  encryptKey?: string;
  webhookPort?: number;
  domain?: string;
}

interface FeishuEvent {
  schema?: string;
  header?: {
    event_id: string;
    event_type: string;
    create_time: string;
    token: string;
  };
  event?: {
    sender?: { sender_id?: { open_id?: string; user_id?: string }; sender_type?: string };
    message?: {
      message_id: string;
      chat_id: string;
      chat_type: string;
      content: string;
      message_type: string;
      mentions?: Array<{ key: string; id: { open_id?: string }; name: string }>;
    };
  };
  challenge?: string;
  type?: string;
}

export class FeishuAdapter implements CommAdapter {
  readonly platform = 'feishu';
  private client?: FeishuClient;
  private config?: FeishuAdapterConfig;
  private handlers: IncomingMessageHandler[] = [];
  private server?: ReturnType<typeof createServer>;
  private connected = false;
  private processedEvents = new Set<string>();

  async connect(config: CommAdapterConfig): Promise<void> {
    this.config = config as FeishuAdapterConfig;
    this.client = new FeishuClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain: this.config.domain,
    });

    await this.client.getTenantToken();

    const port = this.config.webhookPort ?? 9000;
    this.server = createServer((req, res) => this.handleWebhook(req, res));
    this.server.listen(port, () => {
      log.info(`Feishu webhook server listening on port ${port}`);
    });

    this.connected = true;
    log.info('Feishu adapter connected');
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = undefined;
    }
    this.connected = false;
    log.info('Feishu adapter disconnected');
  }

  async sendMessage(channelId: string, content: string, options?: SendOptions): Promise<string> {
    if (!this.client) throw new Error('Feishu adapter not connected');
    if (options?.richText) {
      return this.client.sendInteractiveMessage(channelId, JSON.parse(content));
    }
    return this.client.sendTextMessage(channelId, content);
  }

  async sendCard(channelId: string, card: Record<string, unknown>): Promise<string> {
    if (!this.client) throw new Error('Feishu adapter not connected');
    return this.client.sendInteractiveMessage(channelId, card);
  }

  async sendReply(channelId: string, replyToId: string, content: string): Promise<string> {
    if (!this.client) throw new Error('Feishu adapter not connected');
    return this.client.replyMessage(replyToId, content);
  }

  onMessage(handler: IncomingMessageHandler): void {
    this.handlers.push(handler);
  }

  isConnected(): boolean {
    return this.connected;
  }

  private handleWebhook(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();

      try {
        const event = JSON.parse(body) as FeishuEvent;

        // URL verification challenge
        if (event.challenge) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ challenge: event.challenge }));
          return;
        }

        // Deduplicate events
        const eventId = event.header?.event_id;
        if (eventId) {
          if (this.processedEvents.has(eventId)) {
            res.writeHead(200);
            res.end('ok');
            return;
          }
          this.processedEvents.add(eventId);
          // Cleanup old events (keep last 1000)
          if (this.processedEvents.size > 1000) {
            const arr = [...this.processedEvents];
            this.processedEvents = new Set(arr.slice(-500));
          }
        }

        res.writeHead(200);
        res.end('ok');

        if (event.header?.event_type === 'im.message.receive_v1') {
          this.processMessageEvent(event).catch((err) => {
            log.error('Failed to process Feishu message event', { error: err.message });
          });
        }

        // Card action callback
        if ((event as Record<string, unknown>)['action']) {
          this.processCardAction(event as Record<string, unknown>).catch((err) => {
            log.error('Failed to process card action', { error: err.message });
          });
        }
      } catch (error) {
        log.error('Failed to parse webhook body', { error });
        res.writeHead(400);
        res.end('bad request');
      }
    });
  }

  private async processMessageEvent(event: FeishuEvent): Promise<void> {
    const msgEvent = event.event?.message;
    const sender = event.event?.sender;
    if (!msgEvent || !sender) return;

    // Skip messages from bots
    if (sender.sender_type === 'bot') return;

    let text = '';
    try {
      const content = JSON.parse(msgEvent.content) as { text?: string };
      text = content.text ?? '';
    } catch {
      text = msgEvent.content;
    }

    // Remove @mentions of the bot from the text
    if (msgEvent.mentions) {
      for (const mention of msgEvent.mentions) {
        text = text.replace(mention.key, '').trim();
      }
    }

    if (!text) return;

    const message: Message = {
      id: msgId(),
      platform: 'feishu',
      direction: 'inbound',
      channelId: msgEvent.chat_id,
      senderId: sender.sender_id?.open_id ?? 'unknown',
      senderName: 'User',
      agentId: '',
      content: { type: 'text', text },
      replyToId: undefined,
      threadId: msgEvent.message_id,
      timestamp: new Date().toISOString(),
    };

    for (const handler of this.handlers) {
      try {
        await handler(message);
      } catch (error) {
        log.error('Message handler failed', { error });
      }
    }
  }

  private async processCardAction(event: Record<string, unknown>): Promise<void> {
    const action = event['action'] as Record<string, unknown> | undefined;
    if (!action) return;

    const value = action['value'] as Record<string, string> | undefined;
    if (!value) return;

    const operatorId = ((event['operator'] as Record<string, unknown>)?.['open_id'] as string) ?? 'unknown';

    const message: Message = {
      id: msgId(),
      platform: 'feishu',
      direction: 'inbound',
      channelId: value['agent'] ?? '',
      senderId: operatorId,
      senderName: 'User',
      agentId: value['agent'] ?? '',
      content: {
        type: 'action_card',
        text: `[Card Action] ${value['action'] ?? 'unknown'}`,
        actionCard: {
          title: 'Card Action',
          text: JSON.stringify(value),
          actions: [],
        },
      },
      timestamp: new Date().toISOString(),
    };

    for (const handler of this.handlers) {
      try {
        await handler(message);
      } catch (error) {
        log.error('Card action handler failed', { error });
      }
    }
  }
}
