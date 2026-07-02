import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { createLogger, msgId, type Message } from '@markus/shared';
import type { CommAdapter, CommAdapterConfig, IncomingMessageHandler, SendOptions } from '../adapter.js';
import { WeComClient, type WeComConfig } from './client.js';

const log = createLogger('wecom-adapter');

export interface WeComAdapterConfig extends CommAdapterConfig {
  platform: 'wecom';
  corpid: string;
  corpsecret: string;
  agentid: number;
  /** Optional: callback verification token */
  token?: string;
  /** Optional: AES encoding key for message decryption */
  encodingAESKey?: string;
  /** Webhook server port (default: 8059) */
  webhookPort?: number;
  /** Webhook URL path (default: /webhook/wecom) */
  webhookPath?: string;
}

/** Simplified WeCom incoming message XML structure (parsed manually) */
interface WeComIncomingMessage {
  /** Message sender (UserID) */
  fromUserName: string;
  /** Recipient (corpid) */
  toUserName: string;
  /** Message type (text, image, voice, etc.) */
  msgType: string;
  /** Message content for text messages */
  content: string;
  /** Message ID */
  msgId: string;
  /** Agent ID */
  agentId: number;
  /** Message timestamp */
  createTime: string;
}

export class WeComAdapter implements CommAdapter {
  readonly platform = 'wecom';
  private config?: WeComAdapterConfig;
  private client?: WeComClient;
  private handlers: IncomingMessageHandler[] = [];
  private server?: ReturnType<typeof createServer>;
  private connected = false;

  async connect(config: CommAdapterConfig): Promise<void> {
    this.config = config as WeComAdapterConfig;

    const clientConfig: WeComConfig = {
      corpid: this.config.corpid,
      corpsecret: this.config.corpsecret,
      agentid: this.config.agentid,
      token: this.config.token,
      encodingAESKey: this.config.encodingAESKey,
      webhookPort: this.config.webhookPort,
      webhookPath: this.config.webhookPath,
    };

    this.client = new WeComClient(clientConfig);

    // Test connection by getting access token
    try {
      await this.client.getAccessToken();
      log.info('WeCom bot authenticated successfully');
    } catch (error) {
      log.error('WeCom authentication failed:', { error: String(error) });
      throw error;
    }

    // Set up webhook server for callback messages
    if (this.config.webhookPort) {
      await this.setupWebhookServer();
    } else {
      log.warn('No webhookPort configured — WeCom adapter will only send messages');
    }

    this.connected = true;
    log.info('WeCom adapter connected', {
      webhookPort: this.config.webhookPort ?? 'none',
    });
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = undefined;
      log.info('WeCom webhook server stopped');
    }
    this.client = undefined;
    this.connected = false;
    log.info('WeCom adapter disconnected');
  }

  async sendMessage(channelId: string, content: string, options?: SendOptions): Promise<string> {
    if (!this.config || !this.client) throw new Error('WeCom adapter not connected');

    try {
      const messageId = await this.client.sendTextMessage(content, channelId);
      log.info(`WeCom message sent to ${channelId}: ${messageId}`);
      return messageId;
    } catch (error) {
      log.error(`Failed to send WeCom message to ${channelId}:`, { error: String(error) });
      throw error;
    }
  }

  async sendReply(channelId: string, replyToId: string, content: string): Promise<string> {
    // WeCom doesn't support threading in the same way as Slack/Telegram.
    // We send a new message to the same user/channel.
    if (!this.config || !this.client) throw new Error('WeCom adapter not connected');

    try {
      const messageId = await this.client.sendTextMessage(content, channelId);
      log.info(`WeCom reply sent to ${channelId} (in response to ${replyToId}): ${messageId}`);
      return messageId;
    } catch (error) {
      log.error(`Failed to send WeCom reply to ${channelId}:`, { error: String(error) });
      throw error;
    }
  }

  onMessage(handler: IncomingMessageHandler): void {
    this.handlers.push(handler);
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ─── Webhook server ─────────────────────────────────────────────────────────

  private async setupWebhookServer(): Promise<void> {
    if (!this.client || !this.config) return;

    const { webhookPort, webhookPath = '/webhook/wecom' } = this.config;

    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      // Route: GET /webhook/wecom → URL verification challenge (echostr)
      if (req.method === 'GET' && url.pathname === webhookPath) {
        const msgSignature = url.searchParams.get('msg_signature') ?? '';
        const timestamp = url.searchParams.get('timestamp') ?? '';
        const nonce = url.searchParams.get('nonce') ?? '';
        const echostr = url.searchParams.get('echostr') ?? '';

        if (!echostr) {
          log.warn('WeCom webhook GET missing echostr parameter');
          res.writeHead(400);
          res.end('Bad Request');
          return;
        }

        const reply = this.client!.verifyEchoStr(msgSignature, timestamp, nonce, echostr);
        log.info('WeCom webhook URL verification challenge succeeded');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(reply);
        return;
      }

      // Route: POST /webhook/wecom → incoming messages
      if (req.method !== 'POST' || url.pathname !== webhookPath) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      const rawBody = await this.readRawBody(req);

      // Parse XML body into a WeCom incoming message
      let incoming: WeComIncomingMessage;
      try {
        incoming = this.parseIncomingXml(rawBody);
      } catch (error) {
        log.error('Failed to parse WeCom XML message:', { error: String(error) });
        res.writeHead(400);
        res.end('Bad Request');
        return;
      }

      // Acknowledge immediately (WeCom requires fast response)
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end('<xml><return_code><![CDATA[SUCCESS]]></return_code><return_msg><![CDATA[OK]]></return_msg></xml>');

      // Process message asynchronously
      if (incoming.msgType === 'text' && incoming.content) {
        const message: Message = {
          id: msgId(),
          platform: 'wecom',
          direction: 'inbound',
          channelId: incoming.fromUserName,
          senderId: incoming.fromUserName,
          senderName: incoming.fromUserName,
          agentId: '',
          content: { type: 'text', text: incoming.content },
          timestamp: incoming.createTime
            ? new Date(Number(incoming.createTime) * 1000).toISOString()
            : new Date().toISOString(),
        };

        for (const handler of this.handlers) {
          try {
            await handler(message);
          } catch (error) {
            log.error('WeCom message handler failed', { error: String(error) });
          }
        }
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(webhookPort!, () => {
        log.info(`WeCom webhook server listening on port ${webhookPort}`);
        resolve();
      });
      this.server!.on('error', reject);
    });

    log.info(`WeCom webhook endpoint: POST http://localhost:${webhookPort}${webhookPath}`);
    log.info('Configure this URL in your WeCom app callback settings');
  }

  /**
   * Parse a simple WeCom XML message body into a structured object.
   * WeCom uses CDATA-wrapped XML fields.
   */
  private parseIncomingXml(xml: string): WeComIncomingMessage {
    const extract = (tag: string): string => {
      const match = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[(.*?)\\]\\]></${tag}>`));
      if (match) return match[1];
      // Fallback: try without CDATA
      const fallback = xml.match(new RegExp(`<${tag}>(.*?)</${tag}>`));
      return fallback ? fallback[1] : '';
    };

    return {
      fromUserName: extract('FromUserName'),
      toUserName: extract('ToUserName'),
      msgType: extract('MsgType'),
      content: extract('Content'),
      msgId: extract('MsgId'),
      agentId: Number(extract('AgentID')) || 0,
      createTime: extract('CreateTime'),
    };
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
