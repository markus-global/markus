import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createLogger, msgId, type Message } from '@markus/shared';
import type { CommAdapter, CommAdapterConfig, IncomingMessageHandler, SendOptions } from '../adapter.js';

const log = createLogger('webui-adapter');

interface WebUIMessage {
  agentId: string;
  text: string;
  senderId?: string;
  senderName?: string;
}

export class WebUIAdapter implements CommAdapter {
  readonly platform = 'webui';
  private handlers: IncomingMessageHandler[] = [];
  private server?: ReturnType<typeof createServer>;
  private connected = false;
  private port = 3002;
  private outbox: Array<{ channelId: string; content: string; timestamp: string }> = [];

  async connect(config: CommAdapterConfig): Promise<void> {
    this.port = (config['port'] as number) ?? 3002;

    this.server = createServer((req, res) => this.handleRequest(req, res));
    this.server.listen(this.port, () => {
      log.info(`WebUI comm server listening on port ${this.port}`);
    });

    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = undefined;
    }
    this.connected = false;
  }

  async sendMessage(channelId: string, content: string, _options?: SendOptions): Promise<string> {
    const id = msgId();
    this.outbox.push({ channelId, content, timestamp: new Date().toISOString() });
    if (this.outbox.length > 100) this.outbox.shift();
    return id;
  }

  async sendReply(_channelId: string, _replyToId: string, content: string): Promise<string> {
    return this.sendMessage(_channelId, content);
  }

  onMessage(handler: IncomingMessageHandler): void {
    this.handlers.push(handler);
  }

  isConnected(): boolean {
    return this.connected;
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://localhost:${this.port}`);

    if (req.method === 'POST' && url.pathname === '/api/message') {
      this.handleIncomingMessage(req, res);
    } else if (req.method === 'GET' && url.pathname === '/api/messages') {
      const channelId = url.searchParams.get('channelId') ?? '';
      const msgs = this.outbox.filter((m) => !channelId || m.channelId === channelId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messages: msgs }));
    } else if (req.method === 'GET' && url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  }

  private handleIncomingMessage(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as WebUIMessage;

        const message: Message = {
          id: msgId(),
          platform: 'webui',
          direction: 'inbound',
          channelId: body.agentId,
          senderId: body.senderId ?? 'webui-user',
          senderName: body.senderName ?? 'User',
          agentId: body.agentId,
          content: { type: 'text', text: body.text },
          timestamp: new Date().toISOString(),
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true, messageId: message.id }));

        for (const handler of this.handlers) {
          handler(message).catch((err) => {
            log.error('WebUI message handler failed', { error: String(err) });
          });
        }
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request body' }));
      }
    });
  }
}
