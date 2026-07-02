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
  /** Callback verification token (configured in WeCom admin console URL settings) */
  token?: string;
  /** AES encoding key — 43-character Base64 string (configured in WeCom admin console URL settings) */
  encodingAESKey?: string;
  /** Webhook server port (default: 8059) */
  webhookPort?: number;
  /** Webhook URL path (default: /webhook/wecom) */
  webhookPath?: string;
}

/** Structured representation of a decrypted WeCom callback XML message */
interface WeComIncomingMessage {
  fromUserName: string;
  toUserName: string;
  msgType: string;
  content: string;
  msgId: string;
  agentId: number;
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
    };

    this.client = new WeComClient(clientConfig);

    // Test connection by getting access token (validates corpid + corpsecret)
    try {
      await this.client.getAccessToken();
      log.info('WeCom bot authenticated successfully');
    } catch (error) {
      log.error('WeCom authentication failed', { error: String(error) });
      throw error;
    }

    // Set up webhook server for callback messages
    if (this.config.webhookPort) {
      await this.setupWebhookServer();
    } else {
      log.warn('No webhookPort configured — WeCom adapter will only send messages, cannot receive');
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

  async sendMessage(channelId: string, content: string, _options?: SendOptions): Promise<string> {
    if (!this.client) throw new Error('WeCom adapter not connected');

    try {
      const messageId = await this.client.sendTextMessage(content, channelId);
      log.info(`WeCom message sent to ${channelId}: ${messageId}`);
      return messageId;
    } catch (error) {
      log.error(`Failed to send WeCom message to ${channelId}:`, { error: String(error) });
      throw error;
    }
  }

  async sendReply(channelId: string, _replyToId: string, content: string): Promise<string> {
    // WeCom doesn't support thread replies like Slack/Telegram.
    // Send a new message to the same user/channel.
    if (!this.client) throw new Error('WeCom adapter not connected');

    try {
      const messageId = await this.client.sendTextMessage(content, channelId);
      log.info(`WeCom reply sent to ${channelId}: ${messageId}`);
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

  // ─── XML helpers ───────────────────────────────────────────────────────────

  /**
   * Extract a CDATA-wrapped XML field value.
   *
   * WeCom uses CDATA sections:
   *   <FromUserName><![CDATA[value]]></FromUserName>
   *
   * Falls back to non-CDATA format if no CDATA wrapper is found.
   */
  private extractCdata(xml: string, tag: string): string {
    // Try CDATA-wrapped format first
    const cdataRe = new RegExp(`<${tag}>\\s*<!\\[CDATA\\[(.*?)\\]\\]>\\s*</${tag}>`, 's');
    const cdataMatch = xml.match(cdataRe);
    if (cdataMatch) return cdataMatch[1].trim();

    // Fallback: plain text
    const plainRe = new RegExp(`<${tag}>\\s*(.*?)\\s*</${tag}>`, 's');
    const plainMatch = xml.match(plainRe);
    return plainMatch ? plainMatch[1].trim() : '';
  }

  /**
   * Parse incoming message XML (already decrypted) into a structured object.
   */
  private parseMessageXml(xml: string): WeComIncomingMessage {
    return {
      fromUserName: this.extractCdata(xml, 'FromUserName'),
      toUserName: this.extractCdata(xml, 'ToUserName'),
      msgType: this.extractCdata(xml, 'MsgType'),
      content: this.extractCdata(xml, 'Content'),
      msgId: this.extractCdata(xml, 'MsgId'),
      agentId: Number(this.extractCdata(xml, 'AgentID')) || 0,
      createTime: this.extractCdata(xml, 'CreateTime'),
    };
  }

  /**
   * Parse the outer encrypted callback XML envelope.
   * WeCom wraps encrypted content in:
   *   <xml><ToUserName>...</ToUserName><Encrypt>...</Encrypt><AgentID>...</AgentID></xml>
   */
  private parseEncryptedXml(xml: string): { toUserName: string; encrypt: string; agentId: string } {
    return {
      toUserName: this.extractCdata(xml, 'ToUserName'),
      encrypt: this.extractCdata(xml, 'Encrypt'),
      agentId: this.extractCdata(xml, 'AgentID'),
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

  // ─── Webhook server ─────────────────────────────────────────────────────────

  private async setupWebhookServer(): Promise<void> {
    if (!this.client || !this.config) return;

    const { webhookPort, webhookPath = '/webhook/wecom' } = this.config;

    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      // ─── Route: GET /webhook/wecom → URL verification (echostr challenge) ──
      if (req.method === 'GET' && url.pathname === webhookPath) {
        await this.handleEchoVerify(req, res, url);
        return;
      }

      // ─── Route: POST /webhook/wecom → incoming messages (encrypted) ────────
      if (req.method === 'POST' && url.pathname === webhookPath) {
        await this.handleIncomingMessage(req, res, url);
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(webhookPort!, () => {
        log.info(`WeCom webhook server listening on port ${webhookPort}`);
        resolve();
      });
      this.server!.on('error', reject);
    });

    log.info(`WeCom webhook endpoint: ${webhookPath}`);
    log.info(`Configure URL in WeCom admin console: http://<public-host>:${webhookPort}${webhookPath}`);
  }

  /**
   * Handle WeCom URL verification (echostr challenge).
   *
   * WeCom sends: GET /webhook/wecom?msg_signature=xxx&timestamp=xxx&nonce=xxx&echostr=xxx
   *
   * Per official protocol:
   * 1. Verify SHA1 signature using configured token
   * 2. Decrypt echostr using AES-256-CBC (if encodingAESKey configured)
   * 3. Return the decrypted plaintext challenge as response body
   */
  private async handleEchoVerify(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const msgSignature = url.searchParams.get('msg_signature') ?? '';
    const timestamp = url.searchParams.get('timestamp') ?? '';
    const nonce = url.searchParams.get('nonce') ?? '';
    const echostr = url.searchParams.get('echostr') ?? '';

    if (!echostr) {
      log.warn('WeCom webhook GET missing echostr parameter');
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing echostr parameter');
      return;
    }

    try {
      const replyEchoStr = this.client!.verifyEchoStr(msgSignature, timestamp, nonce, echostr);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(replyEchoStr);
      log.info('WeCom webhook URL verification challenge succeeded');
    } catch (error) {
      log.error('WeCom webhook URL verification challenge FAILED', { error: String(error) });
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Signature verification failed');
    }
  }

  /**
   * Handle an incoming encrypted WeCom callback message.
   *
   * WeCom sends a POST with:
   *   URL params: msg_signature, timestamp, nonce
   *   XML body: <xml><ToUserName>..</ToUserName><Encrypt>base64..</Encrypt><AgentID>..</AgentID></xml>
   *
   * Processing flow per official protocol:
   * 1. Parse the outer XML envelope to extract the Encrypt field
   * 2. Verify SHA1 signature: SHA1(sort(token, timestamp, nonce, Encrypt_value))
   * 3. Decrypt the Encrypt field with AES-256-CBC
   * 4. Parse the decrypted inner XML for message fields (FromUserName, MsgType, Content, etc.)
   * 5. Respond with SUCCESS immediately (WeCom requires fast response)
   * 6. Process the message asynchronously through registered handlers
   */
  private async handleIncomingMessage(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const msgSignature = url.searchParams.get('msg_signature') ?? '';
    const timestamp = url.searchParams.get('timestamp') ?? '';
    const nonce = url.searchParams.get('nonce') ?? '';

    // Step 1: Read and parse the outer encrypted XML envelope
    const rawBody = await this.readRawBody(req);

    let envelope: { toUserName: string; encrypt: string; agentId: string };
    try {
      envelope = this.parseEncryptedXml(rawBody);
    } catch (error) {
      log.error('Failed to parse WeCom encrypted XML envelope', { error: String(error) });
      res.writeHead(400, { 'Content-Type': 'application/xml' });
      res.end('<xml><return_code><![CDATA[FAIL]]></return_code><return_msg><![CDATA[XML parse error]]></return_msg></xml>');
      return;
    }

    if (!envelope.encrypt) {
      log.warn('WeCom callback POST missing Encrypt field');
      res.writeHead(400, { 'Content-Type': 'application/xml' });
      res.end('<xml><return_code><![CDATA[FAIL]]></return_code><return_msg><![CDATA[Missing Encrypt]]></return_msg></xml>');
      return;
    }

    // Step 2: Verify SHA1 signature
    try {
      const valid = this.client!.verifySignature(msgSignature, timestamp, nonce, envelope.encrypt);
      if (!valid) {
        throw new Error('Signature verification failed');
      }
    } catch (error) {
      log.error('WeCom callback signature verification FAILED', { error: String(error) });
      res.writeHead(403, { 'Content-Type': 'application/xml' });
      res.end('<xml><return_code><![CDATA[FAIL]]></return_code><return_msg><![CDATA[Signature verification failed]]></return_msg></xml>');
      return;
    }

    // Step 3: Decrypt the message
    let decryptedXml: string;
    try {
      decryptedXml = this.client!.decrypt(envelope.encrypt);
    } catch (error) {
      log.error('WeCom message decryption FAILED', { error: String(error) });
      res.writeHead(403, { 'Content-Type': 'application/xml' });
      res.end('<xml><return_code><![CDATA[FAIL]]></return_code><return_msg><![CDATA[Decryption failed]]></return_msg></xml>');
      return;
    }

    // Step 4: Parse the decrypted inner XML
    let incoming: WeComIncomingMessage;
    try {
      incoming = this.parseMessageXml(decryptedXml);
    } catch (error) {
      log.error('Failed to parse WeCom decrypted message XML', { error: String(error) });
      res.writeHead(400, { 'Content-Type': 'application/xml' });
      res.end('<xml><return_code><![CDATA[FAIL]]></return_code><return_msg><![CDATA[Message parse error]]></return_msg></xml>');
      return;
    }

    // Step 5: Acknowledge immediately (WeCom requires fast response)
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end('<xml><return_code><![CDATA[SUCCESS]]></return_code><return_msg><![CDATA[OK]]></return_msg></xml>');

    // Step 6: Process message asynchronously
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
  }
}
