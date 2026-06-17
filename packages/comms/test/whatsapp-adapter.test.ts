import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, request as httpRequestRaw } from 'node:http';
import { createHmac } from 'node:crypto';
import { WhatsAppAdapter } from '../src/whatsapp/adapter.js';

function makeMockWhatsAppClient() {
  return {
    sendTextMessage: vi.fn().mockResolvedValue('wamid.mock123'),
  };
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(err => (err ? reject(err) : resolve(port)));
    });
  });
}

async function httpRequest(
  port: number,
  method: string,
  path: string,
  body?: string,
  headers?: Record<string, string>,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequestRaw(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: body
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers }
          : headers,
      },
      res => {
        let text = '';
        res.on('data', chunk => {
          text += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('WhatsAppAdapter', () => {
  let adapter: WhatsAppAdapter;
  let mockClient: ReturnType<typeof makeMockWhatsAppClient>;

  beforeEach(() => {
    adapter = new WhatsAppAdapter();
    mockClient = makeMockWhatsAppClient();
    (adapter as Record<string, unknown>)['client'] = mockClient;
    (adapter as Record<string, unknown>)['config'] = {
      platform: 'whatsapp',
      phoneNumberId: '123456789',
      accessToken: 'test-token',
      businessAccountId: 'biz123',
    };
    (adapter as Record<string, unknown>)['connected'] = true;
  });

  it('has platform whatsapp', () => {
    expect(adapter.platform).toBe('whatsapp');
  });

  it('sendMessage delegates to client', async () => {
    const id = await adapter.sendMessage('15551234567', 'Hello');
    expect(id).toBe('wamid.mock123');
    expect(mockClient.sendTextMessage).toHaveBeenCalledWith('15551234567', 'Hello');
  });

  it('sendMessage throws when not connected', async () => {
    (adapter as Record<string, unknown>)['client'] = undefined;
    await expect(adapter.sendMessage('15551234567', 'hi')).rejects.toThrow(
      'WhatsApp adapter not connected',
    );
  });

  it('sendReply delegates to sendTextMessage', async () => {
    await adapter.sendReply('15551234567', 'wamid.original', 'Reply');
    expect(mockClient.sendTextMessage).toHaveBeenCalledWith('15551234567', 'Reply');
  });

  it('sendBlocks converts blocks to text', async () => {
    const blocks = [
      { type: 'header', text: { text: 'Title' } },
      { type: 'section', text: { text: 'Body' } },
      { type: 'divider' },
    ];
    await adapter.sendBlocks('15551234567', blocks);
    expect(mockClient.sendTextMessage).toHaveBeenCalledWith(
      '15551234567',
      expect.stringContaining('*Title*'),
    );
  });

  it('updateMessage sends prefixed text', async () => {
    await adapter.updateMessage('15551234567', 'wamid.old', 'new text');
    expect(mockClient.sendTextMessage).toHaveBeenCalledWith('15551234567', '(Updated) new text');
  });

  it('deleteMessage is a no-op', async () => {
    await expect(adapter.deleteMessage('15551234567', 'wamid.old')).resolves.toBeUndefined();
  });

  it('onMessage registers handlers', () => {
    const handler = vi.fn();
    adapter.onMessage(handler);
    const handlers = (adapter as Record<string, unknown>)['handlers'] as unknown[];
    expect(handlers).toContain(handler);
  });

  it('isConnected reflects state', () => {
    expect(adapter.isConnected()).toBe(true);
    (adapter as Record<string, unknown>)['connected'] = false;
    expect(adapter.isConnected()).toBe(false);
  });

  describe('connect and webhook lifecycle', () => {
    let port: number;

    beforeEach(async () => {
      port = await getFreePort();
    });

    afterEach(async () => {
      if (adapter.isConnected()) await adapter.disconnect();
    });

    it('connect starts webhook server', async () => {
      const fresh = new WhatsAppAdapter();
      await fresh.connect({
        platform: 'whatsapp',
        phoneNumberId: '123456789',
        accessToken: 'test-token',
        businessAccountId: 'biz123',
        webhookPort: port,
        webhookVerifyToken: 'verify-me',
      });
      expect(fresh.isConnected()).toBe(true);
      await fresh.disconnect();
    });

    it('GET verifies webhook challenge', async () => {
      const fresh = new WhatsAppAdapter();
      await fresh.connect({
        platform: 'whatsapp',
        phoneNumberId: '123456789',
        accessToken: 'test-token',
        businessAccountId: 'biz123',
        webhookPort: port,
        webhookVerifyToken: 'verify-me',
      });

      const res = await httpRequest(
        port,
        'GET',
        '/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=abc123',
      );
      expect(res.status).toBe(200);
      expect(res.text).toBe('abc123');
      await fresh.disconnect();
    });

    it('GET rejects wrong verify token', async () => {
      const fresh = new WhatsAppAdapter();
      await fresh.connect({
        platform: 'whatsapp',
        phoneNumberId: '123456789',
        accessToken: 'test-token',
        businessAccountId: 'biz123',
        webhookPort: port,
        webhookVerifyToken: 'verify-me',
      });

      const res = await httpRequest(
        port,
        'GET',
        '/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123',
      );
      expect(res.status).toBe(403);
      await fresh.disconnect();
    });

    it('POST delivers inbound text messages to handlers', async () => {
      const fresh = new WhatsAppAdapter();
      const handler = vi.fn().mockResolvedValue(undefined);
      fresh.onMessage(handler);

      await fresh.connect({
        platform: 'whatsapp',
        phoneNumberId: '123456789',
        accessToken: 'test-token',
        businessAccountId: 'biz123',
        webhookPort: port,
      });

      const body = JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'biz123',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { display_phone_number: '15550001111', phone_number_id: '123456789' },
                  contacts: [{ profile: { name: 'Alice' }, wa_id: '15551234567' }],
                  messages: [
                    {
                      from: '15551234567',
                      id: 'wamid.inbound1',
                      timestamp: '1700000000',
                      type: 'text',
                      text: { body: 'Hello bot' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      });

      const res = await httpRequest(port, 'POST', '/webhook/whatsapp', body);
      expect(res.status).toBe(200);
      await new Promise(r => setTimeout(r, 50));
      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0].content.text).toBe('Hello bot');
      expect(handler.mock.calls[0][0].senderName).toBe('Alice');
      await fresh.disconnect();
    });

    it('POST rejects invalid signature when appSecret configured', async () => {
      const fresh = new WhatsAppAdapter();
      await fresh.connect({
        platform: 'whatsapp',
        phoneNumberId: '123456789',
        accessToken: 'test-token',
        businessAccountId: 'biz123',
        webhookPort: port,
        appSecret: 'super-secret',
      });

      const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
      const res = await httpRequest(port, 'POST', '/webhook/whatsapp', body, {
        'x-hub-signature-256': 'sha256=deadbeef',
      });
      expect(res.status).toBe(403);
      await fresh.disconnect();
    });

    it('POST accepts valid HMAC signature', async () => {
      const fresh = new WhatsAppAdapter();
      const appSecret = 'super-secret';
      await fresh.connect({
        platform: 'whatsapp',
        phoneNumberId: '123456789',
        accessToken: 'test-token',
        businessAccountId: 'biz123',
        webhookPort: port,
        appSecret,
      });

      const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
      const sig =
        'sha256=' + createHmac('sha256', appSecret).update(body, 'utf8').digest('hex');
      const res = await httpRequest(port, 'POST', '/webhook/whatsapp', body, {
        'x-hub-signature-256': sig,
      });
      expect(res.status).toBe(200);
      await fresh.disconnect();
    });

    it('POST returns 400 for invalid JSON', async () => {
      const fresh = new WhatsAppAdapter();
      await fresh.connect({
        platform: 'whatsapp',
        phoneNumberId: '123456789',
        accessToken: 'test-token',
        businessAccountId: 'biz123',
        webhookPort: port,
      });

      const res = await httpRequest(port, 'POST', '/webhook/whatsapp', '{bad json');
      expect(res.status).toBe(400);
      await fresh.disconnect();
    });

    it('returns 404 for unknown routes', async () => {
      const fresh = new WhatsAppAdapter();
      await fresh.connect({
        platform: 'whatsapp',
        phoneNumberId: '123456789',
        accessToken: 'test-token',
        businessAccountId: 'biz123',
        webhookPort: port,
      });

      const res = await httpRequest(port, 'GET', '/unknown');
      expect(res.status).toBe(404);
      await fresh.disconnect();
    });
  });
});
