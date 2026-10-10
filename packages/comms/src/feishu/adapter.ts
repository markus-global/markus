import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import * as Lark from '@larksuiteoapi/node-sdk';
import { createLogger, msgId, type Message } from '@markus/shared';
import type {
  CommAdapter,
  CommAdapterConfig,
  InboundAction,
  InboundActionHandler,
  IncomingMessageHandler,
  SendOptions,
} from '../adapter.js';
import { FeishuClient, type ReceiveIdType } from './client.js';
import { activeInboundMode, getManifest } from '../platforms/registry.js';
import { createHmac, randomBytes, createCipheriv, createDecipheriv, scrypt } from 'node:crypto';
import { promisify } from 'node:util';

const log = createLogger('feishu-adapter');

/**
 * Wrap markdown in the smallest card Feishu will render as rich text. Feishu's
 * plain `text` message shows `**bold**` literally; a `div` element with
 * `tag: 'lark_md'` renders standard markdown, which is exactly what agents emit.
 */
function buildMarkdownCard(markdown: string): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: markdown } }],
  };
}

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
  /**
   * The official Feishu long connection (`@larksuiteoapi/node-sdk` `WSClient`).
   * This — not the webhook server — is the default receiver: a desktop install
   * has no public URL for Feishu to POST to (design §6.5).
   */
  private wsClient?: Lark.WSClient;
  private actionHandlers: InboundActionHandler[] = [];
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

    // The **long connection** (official Lark SDK `WSClient`) is the default
    // receiver: a desktop install has no public URL for Feishu to POST events
    // to, so the webhook server is opt-in (design §6.5). That default is not
    // decided here — it is declared in the capability table (`defaultInboundMode:
    // 'socket'`) and read through the single `activeInboundMode` reader, so the
    // adapter and the registry cannot disagree about Feishu's transport.
    const capabilities = getManifest(this.platform)?.capabilities;
    const useWebhook =
      activeInboundMode(capabilities, this.config as unknown as Record<string, unknown>) === 'webhook';
    if (useWebhook) {
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
    } else {
      await this.setupLongConnection();
    }

    this.connected = true;
    log.info(`Feishu adapter connected (mode: ${useWebhook ? 'webhook' : 'long-connection'})`);
  }

  async disconnect(): Promise<void> {
    this.teardownLongConnection();
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
    // Feishu `text` messages do not render markdown at all — the agent's `**bold**`
    // would arrive literally. A `lark_md` card element *does*, so markdown is sent
    // as a minimal card; if card delivery fails, fall back to plain text so the
    // message is never lost over formatting.
    if (options?.markdown) {
      try {
        return await this.client.sendInteractiveMessage(channelId, buildMarkdownCard(content), idType);
      } catch (error) {
        log.warn('Feishu rejected the markdown card; falling back to plain text', { error: String(error) });
        return this.client.sendTextMessage(channelId, content, idType);
      }
    }
    if (options?.richText) {
      return this.client.sendInteractiveMessage(channelId, JSON.parse(content), idType);
    }
    if (feishuOpts?.asImage) {
      // `content` is treated as a local filesystem path to the image.
      return this.client.sendLocalImage(channelId, content, idType);
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
    if (options?.markdown) {
      try {
        return await this.client.replyCard(replyToId, buildMarkdownCard(content));
      } catch (error) {
        log.warn('Feishu rejected the markdown reply card; falling back to plain text', { error: String(error) });
        return this.client.replyMessage(replyToId, JSON.stringify({ text: content }));
      }
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

  /**
   * Action port (design §6.5). A card-button tap is a HITL state transition, not
   * a conversation, so it is handed to the registered action handler rather than
   * being faked into a {@link Message} for the agent.
   */
  onAction(handler: InboundActionHandler): void {
    this.actionHandlers.push(handler);
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ─── Long connection (official Lark SDK) ─────────────────────────────────────

  /**
   * Establish the official Feishu **long connection** — the single inbound
   * receiver for Feishu (design §6.5). The retired legacy notifier privately
   * owned this transport; owning it here means one receiver, one routing path,
   * no public URL required.
   *
   * SDK-shaped payloads are normalised into the same `FeishuEvent` envelope the
   * webhook path uses, so exactly one `processMessageEvent` / `processCardAction`
   * runs regardless of transport.
   */
  private async setupLongConnection(): Promise<void> {
    if (!this.config) return;
    const eventDispatcher = new Lark.EventDispatcher({
      loggerLevel: Lark.LoggerLevel.info,
    }).register({
      'im.message.receive_v1': (data: unknown) => {
        const inner = (data ?? {}) as { message?: { message_id?: string } };
        const envelope: FeishuEvent = {
          header: {
            event_id: inner.message?.message_id ?? `lc-${Date.now()}`,
            event_type: 'im.message.receive_v1',
            create_time: String(Date.now()),
            token: '',
          },
          event: inner as FeishuEvent['event'],
        };
        this.processMessageEvent(envelope).catch((err) => {
          log.error('Failed to process Feishu message event', { error: String(err) });
        });
      },
      'card.action.trigger': (data: unknown) => {
        this.processCardAction((data ?? {}) as Record<string, unknown>).catch((err) => {
          log.error('Failed to process card action', { error: String(err) });
        });
      },
    });

    this.wsClient = new Lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain: this.config.domain,
      loggerLevel: Lark.LoggerLevel.info,
      onError: (err: Error) => log.error('Feishu long connection error', { error: err.message }),
    });
    await this.wsClient.start({ eventDispatcher });
    log.info('Feishu long connection established');
  }

  private teardownLongConnection(): void {
    // The SDK's WSClient exposes no clean stop(); nulling the ref lets a later
    // connect() recreate it, and the socket is reclaimed by the SDK/GC.
    this.wsClient = undefined;
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
      // Bot identity + social context (design §6.5): the resolver needs both to
      // pick the bound agent (instance) and the isolated session (kind). A p2p
      // chat is a `dm`; everything else is a `group` — isolation stays the default.
      instanceId: this.config?.instanceId ?? this.platform,
      channelKind: msgEvent.chat_type === 'p2p' ? 'dm' : 'group',
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

    const value = action['value'] as Record<string, unknown> | undefined;
    if (!value) return;

    const operatorId =
      ((event['operator'] as Record<string, unknown> | undefined)?.['open_id'] as string | undefined) ??
      (event['open_id'] as string | undefined) ??
      'unknown';

    const inbound: InboundAction = {
      platform: this.platform,
      instanceId: this.config?.instanceId ?? this.platform,
      payload: event,
      actorId: operatorId,
      timestamp: new Date().toISOString(),
    };

    if (this.actionHandlers.length === 0) {
      log.warn('Card action received but no action handler is registered — dropping', {
        action: value['action'],
      });
      return;
    }

    for (const handler of this.actionHandlers) {
      try {
        await handler(inbound);
      } catch (error) {
        log.error('Card action handler failed', { error });
      }
    }
  }
}
