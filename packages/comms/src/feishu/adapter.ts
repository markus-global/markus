import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createLogger, msgId, type Message } from '@markus/shared';
import type { CommAdapter, CommAdapterConfig, IncomingMessageHandler, SendOptions } from '../adapter.js';
import { FeishuClient, type ReceiveIdType } from './client.js';
import { createHmac, randomBytes, createCipheriv, createDecipheriv, scrypt } from 'node:crypto';
import { promisify } from 'node:util';

const log = createLogger('feishu-adapter');

/** Extended send options for Feishu adapter */
export interface FeishuSendOptions extends SendOptions {
  /** Target ID type for sending messages — 'chat_id' (default), 'open_id', 'user_id', 'union_id' */
  receiveIdType?: ReceiveIdType;
  /** Send as card/interactive message */
  asCard?: boolean;
  /** Rich text content (post format) */
  richText?: boolean;
  /** Send as image */
  asImage?: boolean;
}

export interface FeishuAdapterConfig extends CommAdapterConfig {
  platform: 'feishu';
  appId: string;
  appSecret: string;
  verificationToken?: string;
  encryptKey?: string;
  webhookPort?: number;
  /** Enable WebSocket event subscription instead of webhook */
  wsMode?: boolean;
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
  /** Encrypted payload — present when Feishu webhook encryption is enabled */
  encrypt?: string;
}

const scryptAsync = promisify(scrypt);

export class FeishuAdapter implements CommAdapter {
  readonly platform = 'feishu';
  private client?: FeishuClient;
  private config?: FeishuAdapterConfig;
  private handlers: IncomingMessageHandler[] = [];
  private server?: ReturnType<typeof createServer>;
  private ws?: any;
  private wsHeartbeatTimer?: ReturnType<typeof setInterval>;
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

    if (this.config.wsMode) {
      await this.setupWsSubscription();
    } else {
      const port = this.config.webhookPort ?? 9000;
      this.server = createServer((req, res) => this.handleWebhook(req, res));
      await new Promise<void>((resolve, reject) => {
        this.server!.once('error', reject);
        this.server!.listen(port, () => {
          this.server!.removeListener('error', reject);
          log.info(`Feishu webhook server listening on port ${port}`);
          resolve();
        });
      });
    }

    this.connected = true;
    log.info(`Feishu adapter connected (mode: ${this.config.wsMode ? 'websocket' : 'webhook'})`);
  }

  async disconnect(): Promise<void> {
    this.teardownWsSubscription();
    if (this.server) {
      this.server.close();
      this.server = undefined;
    }
    this.connected = false;
    log.info('Feishu adapter disconnected');
  }

  async sendMessage(channelId: string, content: string, options?: SendOptions): Promise<string> {
    if (!this.client) throw new Error('Feishu adapter not connected');
    const feishuOpts = options as FeishuSendOptions | undefined;
    const idType = feishuOpts?.receiveIdType ?? 'chat_id';

    if (feishuOpts?.asCard) {
      return this.client.sendInteractiveMessage(channelId, JSON.parse(content), idType);
    }
    if (options?.richText) {
      return this.client.sendInteractiveMessage(channelId, JSON.parse(content), idType);
    }
    if (feishuOpts?.asImage) {
      return this.client.sendTextMessage(channelId, content, idType);
    }
    return this.client.sendTextMessage(channelId, content, idType);
  }

  async sendCard(channelId: string, card: Record<string, unknown>): Promise<string> {
    if (!this.client) throw new Error('Feishu adapter not connected');
    return this.client.sendInteractiveMessage(channelId, card);
  }

  async sendReply(channelId: string, replyToId: string, content: string, options?: SendOptions): Promise<string> {
    if (!this.client) throw new Error('Feishu adapter not connected');
    const feishuOpts = options as FeishuSendOptions | undefined;
    const msgType = feishuOpts?.asCard ? 'interactive' : feishuOpts?.richText ? 'post' : 'text';

    if (msgType === 'interactive') {
      return this.client.replyCard(replyToId, JSON.parse(content));
    }
    // For rich text (post) and plain text, content format differs
    if (msgType === 'post') {
      return this.client.replyMessage(replyToId, content, 'post');
    }
    return this.client.replyMessage(replyToId, JSON.stringify({ text: content }));
  }

  async updateMessage(channelId: string, messageId: string, content: string): Promise<void> {
    if (!this.client) throw new Error('Feishu adapter not connected');

    try {
      await this.client.updateMessage(messageId, JSON.stringify({ text: content }));
      log.info(`Feishu message updated in channel ${channelId}: ${messageId}`);
    } catch (error) {
      log.error(`Failed to update Feishu message ${messageId} in ${channelId}:`, { error });
      throw error;
    }
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    if (!this.client) throw new Error('Feishu adapter not connected');

    try {
      await this.client.deleteMessage(messageId);
      log.info(`Feishu message deleted from channel ${channelId}: ${messageId}`);
    } catch (error) {
      log.error(`Failed to delete Feishu message ${messageId} from ${channelId}:`, { error });
      throw error;
    }
  }

  onMessage(handler: IncomingMessageHandler): void {
    this.handlers.push(handler);
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ─── WebSocket Event Subscription ────────────────────────────────────────────

  private async setupWsSubscription(): Promise<void> {
    if (!this.client || !this.config) return;
    const token = await this.client.getTenantToken();

    // Step 1: Get WebSocket URL from Feishu API
    const res = await fetch(`${this.config.domain ?? 'https://open.feishu.cn'}/open-apis/ws/v1/apps/${this.config.appId}/subscribe`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    const data = (await res.json()) as { code: number; data?: { url?: string } };
    if (data.code !== 0) {
      throw new Error(`Feishu WS subscribe failed: ${JSON.stringify(data)}`);
    }

    const wsUrl = data.data?.url;
    if (!wsUrl) {
      throw new Error('Feishu WS subscribe returned no URL');
    }

    // Step 2: Connect WebSocket
    this.ws = new (globalThis as any).WebSocket(wsUrl);

    this.ws.onopen = () => {
      log.info('Feishu WebSocket connected');
    };

    this.ws.onmessage = (event: { data: Buffer }) => {
      try {
        const payload = JSON.parse(event.data.toString()) as FeishuEvent;
        this.handleWsEvent(payload).catch((err) => {
          log.error('Failed to handle WS event', { error: err.message });
        });
      } catch (err) {
        log.error('Failed to parse WS message', { error: err instanceof Error ? err.message : String(err) });
      }
    };

    this.ws.onclose = (event: { code: number; reason: Buffer }) => {
      log.warn(`Feishu WebSocket closed: code=${event.code}, reason=${event.reason.toString()}`);
      // Auto-reconnect after 5 seconds
      setTimeout(() => {
        if (this.connected) {
          log.info('Feishu WebSocket reconnecting...');
          this.setupWsSubscription().catch((err) => {
            log.error('Feishu WS reconnect failed', { error: err.message });
          });
        }
      }, 5000);
    };

    this.ws.onerror = () => {
      log.error('Feishu WebSocket error occurred');
    };

    // Step 3: Heartbeat at 30s intervals (Feishu WS requirement)
    this.wsHeartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === (globalThis as any).WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'heartbeat' }));
      }
    }, 30_000);
  }

  private teardownWsSubscription(): void {
    if (this.wsHeartbeatTimer) {
      clearInterval(this.wsHeartbeatTimer);
      this.wsHeartbeatTimer = undefined;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }
  }

  private async handleWsEvent(event: FeishuEvent): Promise<void> {
    // Handle challenge/pong
    if (event.type === 'pong') return;

    // Deduplicate events
    const eventId = event.header?.event_id;
    if (eventId) {
      if (this.processedEvents.has(eventId)) return;
      this.processedEvents.add(eventId);
      if (this.processedEvents.size > 1000) {
        const arr = Array.from(this.processedEvents);
        this.processedEvents = new Set(arr.slice(-500));
      }
    }

    // Process message events
    if (event.header?.event_type === 'im.message.receive_v1') {
      await this.processMessageEvent(event);
    }

    // Card action callbacks
    if ((event as Record<string, unknown>)['action']) {
      await this.processCardAction(event as Record<string, unknown>);
    }
  }

  /**
   * Decrypt Feishu encrypted webhook payload using AES-256-CBC.
   * The encryptKey is derived via scrypt with salt='key' (Feishu convention).
   * The encrypted payload is base64-encoded; the first 16 bytes are the IV.
   */
  private async decryptFeishuPayload(encrypted: string): Promise<string> {
    if (!this.config?.encryptKey) throw new Error('encryptKey not configured');
    const keyBuffer = (await scryptAsync(this.config.encryptKey, 'key', 32)) as Buffer;
    const encryptedBuffer = Buffer.from(encrypted, 'base64');
    const iv = encryptedBuffer.subarray(0, 16);
    const data = encryptedBuffer.subarray(16);
    const decipher = createDecipheriv('aes-256-cbc', keyBuffer, iv);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString('utf8');
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
      const rawBody = Buffer.concat(chunks).toString();

      // Parse initial payload — may contain an encrypted event
      const raw = JSON.parse(rawBody) as FeishuEvent;

      // URL verification challenge (can come encrypted or plaintext)
      if (raw.challenge) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ challenge: raw.challenge }));
        return;
      }

      // If Feishu sent an encrypted payload, decrypt it first
      const processEvent = (event: FeishuEvent) => {
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
            const arr = Array.from(this.processedEvents);
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
      };

      (async () => {
        try {
          if (raw.encrypt && this.config?.encryptKey) {
            // Decrypt the encrypted payload
            const decrypted = await this.decryptFeishuPayload(raw.encrypt);
            const event = JSON.parse(decrypted) as FeishuEvent;
            processEvent(event);
          } else if (raw.encrypt && !this.config?.encryptKey) {
            log.warn('Received encrypted Feishu payload but no encryptKey configured');
            res.writeHead(200);
            res.end('ok');
          } else {
            // Plaintext payload
            processEvent(raw);
          }
        } catch (err) {
          log.error('Failed to process Feishu webhook', { error: err instanceof Error ? err.message : String(err) });
          res.writeHead(400);
          res.end('bad request');
        }
      })();
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
