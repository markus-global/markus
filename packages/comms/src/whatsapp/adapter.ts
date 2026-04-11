import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac } from 'node:crypto';
import { createLogger, msgId, type Message } from '@markus/shared';
import type { CommAdapter, CommAdapterConfig, IncomingMessageHandler, SendOptions } from '../adapter.js';
import { WhatsAppClient, type WhatsAppClientConfig } from './client.js';

const log = createLogger('whatsapp-adapter');

export interface WhatsAppAdapterConfig extends CommAdapterConfig {
  platform: 'whatsapp';
  phoneNumberId: string;
  accessToken: string;
  businessAccountId: string;
  // Webhook configuration
  webhookVerifyToken?: string;
  webhookPort?: number;
  webhookPath?: string;
  appSecret?: string;
  apiVersion?: string;
  baseUrl?: string;
}

interface WhatsAppWebhookBody {
  object: string;
  entry: WhatsAppEntry[];
}

interface WhatsAppEntry {
  id: string;
  changes: WhatsAppChange[];
}

interface WhatsAppChange {
  value: WhatsAppValue;
  field: string;
}

interface WhatsAppValue {
  messaging_product: string;
  metadata: { display_phone_number: string; phone_number_id: string };
  contacts?: Array<{ profile: { name: string }; wa_id: string }>;
  messages?: WhatsAppMessage[];
  statuses?: WhatsAppStatus[];
}

interface WhatsAppMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  context?: { from: string; id: string };
}

interface WhatsAppStatus {
  id: string;
  recipient_id: string;
  status: string;
  timestamp: string;
}

export class WhatsAppAdapter implements CommAdapter {
  readonly platform = 'whatsapp';
  private config?: WhatsAppAdapterConfig;
  private client?: WhatsAppClient;
  private handlers: IncomingMessageHandler[] = [];
  private server?: ReturnType<typeof createServer>;
  private connected = false;
  private processedMessages = new Set<string>();

  async connect(config: CommAdapterConfig): Promise<void> {
    this.config = config as WhatsAppAdapterConfig;

    const clientConfig: WhatsAppClientConfig = {
      phoneNumberId: this.config.phoneNumberId,
      accessToken: this.config.accessToken,
      businessAccountId: this.config.businessAccountId,
      apiVersion: this.config.apiVersion,
      baseUrl: this.config.baseUrl,
    };

    this.client = new WhatsAppClient(clientConfig);

    // Start webhook server if port is configured
    const webhookPort = this.config.webhookPort ?? 3001;
    const webhookPath = this.config.webhookPath ?? '/webhook/whatsapp';
    const verifyToken = this.config.webhookVerifyToken ?? '';
    const appSecret = this.config.appSecret ?? '';

    await this.startWebhookServer(webhookPort, webhookPath, verifyToken, appSecret);

    this.connected = true;
    log.info('WhatsApp adapter connected');
    log.info(`WhatsApp webhook endpoint: POST http://localhost:${webhookPort}${webhookPath}`);
    log.info(`URL verification endpoint: GET http://localhost:${webhookPort}${webhookPath}`);
    log.info(`Configure webhook URL in Meta Developer Portal → Webhooks`);
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      await new Promise<void>(resolve => this.server!.close(() => resolve()));
      this.server = undefined;
    }
    this.client = undefined;
    this.connected = false;
    log.info('WhatsApp adapter disconnected');
  }

  async sendMessage(channelId: string, content: string, options?: SendOptions): Promise<string> {
    if (!this.config || !this.client) throw new Error('WhatsApp adapter not connected');

    try {
      const messageId = await this.client.sendTextMessage(channelId, content);
      log.info(`WhatsApp message sent to ${channelId}: ${messageId}`);
      return messageId;
    } catch (error) {
      log.error(`Failed to send WhatsApp message to ${channelId}:`, { error });
      throw error;
    }
  }

  async sendReply(channelId: string, replyToId: string, content: string): Promise<string> {
    if (!this.config || !this.client) throw new Error('WhatsApp adapter not connected');
    // WhatsApp doesn't have native reply — use context to reference original
    try {
      const messageId = await this.client.sendTextMessage(channelId, content);
      log.info(`WhatsApp reply sent to ${channelId} (in response to ${replyToId})`);
      return messageId;
    } catch (error) {
      log.error(`Failed to send WhatsApp reply to ${channelId}:`, { error });
      throw error;
    }
  }

  async sendBlocks(channelId: string, blocks: any[], text?: string, options?: SendOptions): Promise<string> {
    if (!this.config || !this.client) throw new Error('WhatsApp adapter not connected');
    const content = text || this.blocksToText(blocks);
    const messageId = await this.client.sendTextMessage(channelId, content);
    log.info(`WhatsApp blocks message sent to ${channelId}: ${messageId}`);
    return messageId;
  }

  async updateMessage(channelId: string, messageId: string, content: string): Promise<void> {
    if (!this.config || !this.client) throw new Error('WhatsApp adapter not connected');
    // WhatsApp doesn't support edit — send as new message with prefix
    await this.client.sendTextMessage(channelId, `(Updated) ${content}`);
    log.warn(`WhatsApp message update simulated — no native edit API`);
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    if (!this.config || !this.client) throw new Error('WhatsApp adapter not connected');
    log.warn(`WhatsApp message deletion not supported — no delete API`);
  }

  private blocksToText(blocks: any[]): string {
    let text = '';
    for (const block of blocks) {
      if (block.type === 'section' && block.text?.text) text += block.text.text + '\n';
      else if (block.type === 'header' && block.text?.text) text += `*${block.text.text}*\n`;
      else if (block.type === 'divider') text += '---\n';
    }
    return text.trim();
  }

  onMessage(handler: IncomingMessageHandler): void {
    this.handlers.push(handler);
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ── Webhook server ──────────────────────────────────────────────────────────

  private async startWebhookServer(
    port: number,
    webhookPath: string,
    verifyToken: string,
    appSecret: string,
  ): Promise<void> {
    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? '';

      // GET /webhook/whatsapp → URL verification
      if (req.method === 'GET' && url.startsWith(webhookPath)) {
        const params = new URL(url, `http://localhost:${port}`).searchParams;
        const mode = params.get('hub.mode');
        const token = params.get('hub.verify_token');
        const challenge = params.get('hub.challenge');

        if (mode === 'subscribe') {
          if (token === verifyToken) {
            log.info('WhatsApp webhook URL verification succeeded');
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end(challenge ?? 'ok');
            return;
          }
          log.warn(`WhatsApp webhook verify token mismatch`);
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }
        res.writeHead(200);
        res.end('ok');
        return;
      }

      // POST /webhook/whatsapp → message events
      if (req.method === 'POST' && url.startsWith(webhookPath)) {
        const rawBody = await this.readRawBody(req);
        const signature = req.headers['x-hub-signature-256'] as string | undefined;

        // Verify HMAC-SHA256 signature if appSecret is configured
        if (appSecret && signature) {
          const valid = this.verifySignature(rawBody, signature, appSecret);
          if (!valid) {
            log.warn('WhatsApp webhook signature verification failed');
            res.writeHead(403);
            res.end('Forbidden');
            return;
          }
        } else if (appSecret && !signature) {
          log.warn('WhatsApp webhook missing signature — rejecting');
          res.writeHead(401);
          res.end('Unauthorized');
          return;
        }

        let body: WhatsAppWebhookBody;
        try {
          body = JSON.parse(rawBody) as WhatsAppWebhookBody;
        } catch {
          res.writeHead(400);
          res.end('Bad Request');
          return;
        }

        // Acknowledge immediately (Meta requires < 5s response)
        res.writeHead(200);
        res.end('ok');

        // Process events asynchronously
        this.processWebhookBody(body).catch(err => {
          log.error('WhatsApp webhook processing error', { error: err.message });
        });
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(port, () => resolve());
      this.server!.on('error', reject);
    });

    log.info(`WhatsApp webhook server listening on port ${port}`);
  }

  private async processWebhookBody(body: WhatsAppWebhookBody): Promise<void> {
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry) {
      for (const change of entry.changes) {
        if (change.field !== 'messages') continue;

        const messages = change.value.messages ?? [];
        const contacts = change.value.contacts ?? [];

        for (const msg of messages) {
          // Deduplicate
          if (this.processedMessages.has(msg.id)) {
            log.debug(`Duplicate WhatsApp message ${msg.id}, skipping`);
            continue;
          }
          this.processedMessages.add(msg.id);
          if (this.processedMessages.size > 500) {
            const arr = Array.from(this.processedMessages);
            this.processedMessages = new Set(arr.slice(-250));
          }

          const contact = contacts.find(c => c.wa_id === msg.from);
          const senderName = contact?.profile?.name ?? 'WhatsApp User';

          const text = msg.text?.body ?? '';
          const content = msg.type === 'text' ? { type: 'text' as const, text } : { type: 'text' as const, text: `[${msg.type}]` };

          const message: Message = {
            id: msgId(),
            platform: 'whatsapp',
            direction: 'inbound',
            channelId: msg.from,
            senderId: msg.from,
            senderName,
            agentId: '',
            content,
            replyToId: msg.context?.id,
            threadId: undefined,
            timestamp: new Date(parseInt(msg.timestamp) * 1000).toISOString(),
          };

          for (const handler of this.handlers) {
            try {
              await handler(message);
            } catch (err) {
              log.error('WhatsApp message handler error', { error: err instanceof Error ? err.message : String(err) });
            }
          }
        }

        // Handle status updates (delivery receipts)
        for (const status of change.value.statuses ?? []) {
          log.debug(`WhatsApp message status: ${status.id} → ${status.status}`);
        }
      }
    }
  }

  private verifySignature(rawBody: string, signature: string, appSecret: string): boolean {
    // Meta signature format: sha256=<hash>
    const expected = 'sha256=' + this.computeHmacSha256(rawBody, appSecret);
    // Constant-time comparison to prevent timing attacks
    if (expected.length !== signature.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    }
    return diff === 0;
  }

  private computeHmacSha256(data: string, secret: string): string {
    return createHmac('sha256', secret).update(data, 'utf8').digest('hex');
  }

  private readRawBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString()));
      req.on('error', reject);
    });
  }
}