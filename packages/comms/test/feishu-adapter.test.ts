import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServer, request as httpRequestRaw } from 'node:http';
import { FeishuAdapter } from '../src/feishu/adapter.js';
import type { FeishuClient } from '../src/feishu/client.js';

/**
 * The Feishu adapter receives events over the official Lark SDK **long
 * connection** (design §6.5). It is mocked so tests can (a) assert the long
 * connection is the default transport, and (b) drive `im.message.receive_v1` /
 * `card.action.trigger` payloads exactly as the SDK delivers them — the *inner*
 * event, with no envelope.
 */
const sdkState = vi.hoisted(() => ({
  dispatcher: undefined as undefined | { handlers: Record<string, (data: unknown) => void> },
  wsStarts: 0,
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  WSClient: class {
    constructor(_opts: unknown) {}
    async start(): Promise<void> {
      sdkState.wsStarts += 1;
    }
  },
  EventDispatcher: class {
    handlers: Record<string, (data: unknown) => void> = {};
    constructor(_opts?: unknown) {}
    register(map: Record<string, (data: unknown) => void>) {
      this.handlers = map;
      sdkState.dispatcher = this;
      return this;
    }
  },
  LoggerLevel: { error: 0, warn: 1, info: 2, debug: 3 },
  Client: class {},
}));

// Factory to create a mock FeishuClient
function makeMockClient(): Partial<FeishuClient> {
  return {
    getTenantToken: vi.fn().mockResolvedValue('mock-token'),
    sendTextMessage: vi.fn().mockResolvedValue('om_mock_sent'),
    sendInteractiveMessage: vi.fn().mockResolvedValue('om_mock_card'),
    sendLocalImage: vi.fn().mockResolvedValue('om_mock_image'),
    replyMessage: vi.fn().mockResolvedValue('om_mock_reply'),
    replyCard: vi.fn().mockResolvedValue('om_mock_reply_card'),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
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

async function httpRequest(port: number, method: string, path: string, body?: string) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = httpRequestRaw(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: body
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
          : undefined,
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

describe('FeishuAdapter', () => {
  let adapter: FeishuAdapter;
  let mockClient: ReturnType<typeof makeMockClient>;

  beforeEach(() => {
    adapter = new FeishuAdapter();
    mockClient = makeMockClient();
    // Inject mock client via property access (adapter's client is private, but we use duck-typing for tests)
    (adapter as Record<string, unknown>)['client'] = mockClient;
    (adapter as Record<string, unknown>)['connected'] = true;
  });

  describe('updateMessage', () => {
    it('should delegate to client.updateMessage', async () => {
      await adapter.updateMessage('oc_channel', 'om_msg', 'updated text');

      expect(mockClient.updateMessage).toHaveBeenCalledWith(
        'om_msg',
        JSON.stringify({ text: 'updated text' }),
      );
    });

    it('should throw if adapter is not connected', async () => {
      (adapter as Record<string, unknown>)['client'] = undefined;

      await expect(
        adapter.updateMessage('oc_channel', 'om_msg', 'text'),
      ).rejects.toThrow('Feishu adapter not connected');
    });

    it('should propagate client errors', async () => {
      mockClient.updateMessage = vi.fn().mockRejectedValue(new Error('update failed'));

      await expect(
        adapter.updateMessage('oc_channel', 'om_msg', 'text'),
      ).rejects.toThrow('update failed');
    });
  });

  describe('deleteMessage', () => {
    it('should delegate to client.deleteMessage', async () => {
      await adapter.deleteMessage('oc_channel', 'om_msg');

      expect(mockClient.deleteMessage).toHaveBeenCalledWith('om_msg');
    });

    it('should throw if adapter is not connected', async () => {
      (adapter as Record<string, unknown>)['client'] = undefined;

      await expect(
        adapter.deleteMessage('oc_channel', 'om_msg'),
      ).rejects.toThrow('Feishu adapter not connected');
    });

    it('should propagate client errors', async () => {
      mockClient.deleteMessage = vi.fn().mockRejectedValue(new Error('delete failed'));

      await expect(
        adapter.deleteMessage('oc_channel', 'om_msg'),
      ).rejects.toThrow('delete failed');
    });
  });

  describe('sendReply', () => {
    it('should send a text reply via client.replyMessage', async () => {
      const result = await adapter.sendReply('oc_channel', 'om_original', 'Hello reply');

      expect(result).toBe('om_mock_reply');
      expect(mockClient.replyMessage).toHaveBeenCalledWith(
        'om_original',
        JSON.stringify({ text: 'Hello reply' }),
      );
    });

    it('should send an interactive card reply via client.replyCard when asCard is set', async () => {
      const card = { config: { wide_screen_mode: true } };
      const result = await adapter.sendReply('oc_channel', 'om_original', JSON.stringify(card), {
        asCard: true,
      });

      expect(result).toBe('om_mock_reply_card');
      expect(mockClient.replyCard).toHaveBeenCalledWith('om_original', card);
    });

    it('should send a post reply when richText is set', async () => {
      const result = await adapter.sendReply('oc_channel', 'om_original', '{"zh_cn":{"title":"Test"}}', {
        richText: true,
      });

      expect(result).toBe('om_mock_reply');
      expect(mockClient.replyMessage).toHaveBeenCalledWith(
        'om_original',
        '{"zh_cn":{"title":"Test"}}',
        'post',
      );
    });

    it('should throw if adapter is not connected', async () => {
      (adapter as Record<string, unknown>)['client'] = undefined;

      await expect(
        adapter.sendReply('oc_channel', 'om_original', 'text'),
      ).rejects.toThrow('Feishu adapter not connected');
    });
  });

  describe('sendMessage with options', () => {
    it('should send as card when asCard is set', async () => {
      const cardStr = JSON.stringify({ config: { wide_screen_mode: true } });
      await adapter.sendMessage('oc_channel', cardStr, { asCard: true });

      expect(mockClient.sendInteractiveMessage).toHaveBeenCalledWith(
        'oc_channel',
        JSON.parse(cardStr),
        'chat_id',
      );
    });

    it('should send with custom receiveIdType', async () => {
      await adapter.sendMessage('oc_channel', 'Hello', {
        receiveIdType: 'open_id',
      });

      expect(mockClient.sendTextMessage).toHaveBeenCalledWith('oc_channel', 'Hello', 'open_id');
    });
  });

  describe('sendCard', () => {
    it('should delegate to client.sendInteractiveMessage', async () => {
      const card = { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: 'Test' } } };
      const result = await adapter.sendCard('oc_channel', card);

      expect(result).toBe('om_mock_card');
      expect(mockClient.sendInteractiveMessage).toHaveBeenCalledWith('oc_channel', card);
    });
    it('should throw if adapter is not connected', async () => {
      (adapter as Record<string, unknown>)['client'] = undefined;

      await expect(adapter.sendCard('oc_channel', {})).rejects.toThrow('Feishu adapter not connected');
    });
  });

  describe('isConnected', () => {
    it('returns connection state', () => {
      expect(adapter.isConnected()).toBe(true);
      (adapter as Record<string, unknown>)['connected'] = false;
      expect(adapter.isConnected()).toBe(false);
    });
  });

  describe('connect and disconnect', () => {
    it('connect authenticates and starts webhook listener', async () => {
      const fresh = new FeishuAdapter();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ code: 0, tenant_access_token: 'tok', expire: 7200 }),
        }),
      );

      await fresh.connect({
        platform: 'feishu',
        appId: 'cli_test',
        appSecret: 'secret',
        wsMode: false,
        webhookPort: 0,
      });
      expect(fresh.isConnected()).toBe(true);
      await fresh.disconnect();
      vi.unstubAllGlobals();
    });

    it('disconnect closes server and clears state', async () => {
      const closeMock = vi.fn();
      (adapter as Record<string, unknown>)['server'] = { close: closeMock };
      await adapter.disconnect();
      expect(closeMock).toHaveBeenCalled();
      expect(adapter.isConnected()).toBe(false);
    });
  });

  describe('sendMessage', () => {
    it('sends plain text by default', async () => {
      await adapter.sendMessage('oc_channel', 'Hello');
      expect(mockClient.sendTextMessage).toHaveBeenCalledWith('oc_channel', 'Hello', 'chat_id');
    });

    it('throws when not connected', async () => {
      (adapter as Record<string, unknown>)['client'] = undefined;
      await expect(adapter.sendMessage('oc_channel', 'Hello')).rejects.toThrow(
        'Feishu adapter not connected',
      );
    });
  });

  describe('onMessage', () => {
    it('registers inbound handlers', () => {
      const handler = vi.fn();
      adapter.onMessage(handler);
      const handlers = (adapter as Record<string, unknown>)['handlers'] as unknown[];
      expect(handlers).toContain(handler);
    });
  });

  describe('webhook server', () => {
    let port: number;

    beforeEach(async () => {
      port = await getFreePort();
    });

    it('POST challenge returns challenge echo', async () => {
      const fresh = new FeishuAdapter();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ code: 0, tenant_access_token: 'tok', expire: 7200 }),
        }),
      );

      await fresh.connect({
        platform: 'feishu',
        appId: 'cli_test',
        appSecret: 'secret',
        wsMode: false,
        webhookPort: port,
      });
      await new Promise(r => setTimeout(r, 50));

      const res = await httpRequest(
        port,
        'POST',
        '/',
        JSON.stringify({ challenge: 'verify-challenge' }),
      );
      expect(res.status).toBe(200);
      expect(JSON.parse(res.text)).toEqual({ challenge: 'verify-challenge' });
      await fresh.disconnect();
      vi.unstubAllGlobals();
    });

    it('POST message event invokes handler', async () => {
      const fresh = new FeishuAdapter();
      const handler = vi.fn().mockResolvedValue(undefined);
      fresh.onMessage(handler);

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ code: 0, tenant_access_token: 'tok', expire: 7200 }),
        }),
      );

      await fresh.connect({
        platform: 'feishu',
        appId: 'cli_test',
        appSecret: 'secret',
        wsMode: false,
        webhookPort: port,
      });
      await new Promise(r => setTimeout(r, 50));

      const body = JSON.stringify({
        header: { event_id: 'evt-1', event_type: 'im.message.receive_v1' },
        event: {
          sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
          message: {
            message_id: 'om_msg1',
            chat_id: 'oc_chat',
            chat_type: 'group',
            message_type: 'text',
            content: JSON.stringify({ text: '@bot hello world' }),
            mentions: [{ key: '@bot', id: { open_id: 'ou_bot' }, name: 'Bot' }],
          },
        },
      });

      const res = await httpRequest(port, 'POST', '/', body);
      expect(res.status).toBe(200);
      await new Promise(r => setTimeout(r, 50));
      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0].content.text).toBe('hello world');
      await fresh.disconnect();
      vi.unstubAllGlobals();
    });

    it('POST rejects non-POST methods', async () => {
      const fresh = new FeishuAdapter();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ code: 0, tenant_access_token: 'tok', expire: 7200 }),
        }),
      );

      await fresh.connect({
        platform: 'feishu',
        appId: 'cli_test',
        appSecret: 'secret',
        wsMode: false,
        webhookPort: port,
      });
      await new Promise(r => setTimeout(r, 50));

      const res = await httpRequest(port, 'GET', '/');
      expect(res.status).toBe(405);
      await fresh.disconnect();
      vi.unstubAllGlobals();
    });

    it('sendMessage with richText uses interactive message', async () => {
      await adapter.sendMessage('oc_channel', '{"zh_cn":{}}', { richText: true });
      expect(mockClient.sendInteractiveMessage).toHaveBeenCalled();
    });

    it('sendMessage with asImage uploads local image path', async () => {
      await adapter.sendMessage('oc_channel', '/tmp/poster.webp', { asImage: true });
      expect(mockClient.sendLocalImage).toHaveBeenCalledWith('oc_channel', '/tmp/poster.webp', 'chat_id');
    });

    it('skips duplicate events', async () => {
      const fresh = new FeishuAdapter();
      const handler = vi.fn().mockResolvedValue(undefined);
      fresh.onMessage(handler);

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ code: 0, tenant_access_token: 'tok', expire: 7200 }),
        }),
      );

      await fresh.connect({
        platform: 'feishu',
        appId: 'cli_test',
        appSecret: 'secret',
        wsMode: false,
        webhookPort: port,
      });
      await new Promise(r => setTimeout(r, 50));

      const body = JSON.stringify({
        header: { event_id: 'evt-dup', event_type: 'im.message.receive_v1' },
        event: {
          sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
          message: {
            message_id: 'om_msg1',
            chat_id: 'oc_chat',
            chat_type: 'group',
            message_type: 'text',
            content: JSON.stringify({ text: 'hello' }),
          },
        },
      });

      await httpRequest(port, 'POST', '/', body);
      await httpRequest(port, 'POST', '/', body);
      await new Promise(r => setTimeout(r, 80));
      expect(handler).toHaveBeenCalledTimes(1);
      await fresh.disconnect();
      vi.unstubAllGlobals();
    });

    it('POST card action goes to the action port, not the message handler', async () => {
      const fresh = new FeishuAdapter();
      const onMessage = vi.fn().mockResolvedValue(undefined);
      const onAction = vi.fn().mockResolvedValue(undefined);
      fresh.onMessage(onMessage);
      fresh.onAction(onAction);

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ code: 0, tenant_access_token: 'tok', expire: 7200 }),
        }),
      );

      await fresh.connect({
        platform: 'feishu',
        instanceId: 'bi_secretary',
        appId: 'cli_test',
        appSecret: 'secret',
        wsMode: false,
        webhookPort: port,
      });
      await new Promise(r => setTimeout(r, 50));

      const body = JSON.stringify({
        header: { event_id: 'evt-card', event_type: 'card.action.trigger' },
        operator: { open_id: 'ou_user' },
        action: {
          value: { action: 'approve', agent: 'Secretary' },
        },
      });

      await httpRequest(port, 'POST', '/', body);
      await new Promise(r => setTimeout(r, 50));
      // A card tap is a HITL transition, not a conversation (design §6.5).
      expect(onAction).toHaveBeenCalledOnce();
      expect(onMessage).not.toHaveBeenCalled();
      const action = onAction.mock.calls[0][0];
      expect(action.instanceId).toBe('bi_secretary');
      expect(action.actorId).toBe('ou_user');
      expect(action.payload.action.value.action).toBe('approve');
      await fresh.disconnect();
      vi.unstubAllGlobals();
    });

    it('skips bot sender messages', async () => {
      const fresh = new FeishuAdapter();
      const handler = vi.fn().mockResolvedValue(undefined);
      fresh.onMessage(handler);

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ code: 0, tenant_access_token: 'tok', expire: 7200 }),
        }),
      );

      await fresh.connect({
        platform: 'feishu',
        appId: 'cli_test',
        appSecret: 'secret',
        wsMode: false,
        webhookPort: port,
      });
      await new Promise(r => setTimeout(r, 50));

      const body = JSON.stringify({
        header: { event_id: 'evt-bot', event_type: 'im.message.receive_v1' },
        event: {
          sender: { sender_id: { open_id: 'ou_bot' }, sender_type: 'bot' },
          message: {
            message_id: 'om_msg2',
            chat_id: 'oc_chat',
            chat_type: 'group',
            message_type: 'text',
            content: JSON.stringify({ text: 'bot msg' }),
          },
        },
      });

      await httpRequest(port, 'POST', '/', body);
      await new Promise(r => setTimeout(r, 50));
      expect(handler).not.toHaveBeenCalled();
      await fresh.disconnect();
      vi.unstubAllGlobals();
    });

    it('POST encrypted payload decrypts and invokes handler', async () => {
      const { createCipheriv, randomBytes, scryptSync } = await import('node:crypto');
      const encryptKey = 'test-encrypt-key-12345';
      const fresh = new FeishuAdapter();
      const handler = vi.fn().mockResolvedValue(undefined);
      fresh.onMessage(handler);

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ code: 0, tenant_access_token: 'tok', expire: 7200 }),
        }),
      );

      await fresh.connect({
        platform: 'feishu',
        appId: 'cli_test',
        appSecret: 'secret',
        wsMode: false,
        encryptKey,
        webhookPort: port,
      });
      await new Promise(r => setTimeout(r, 50));

      const eventPayload = JSON.stringify({
        header: { event_id: 'evt-enc', event_type: 'im.message.receive_v1' },
        event: {
          sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
          message: {
            message_id: 'om_enc',
            chat_id: 'oc_chat',
            chat_type: 'group',
            message_type: 'text',
            content: JSON.stringify({ text: 'encrypted hello' }),
          },
        },
      });

      const keyBuffer = scryptSync(encryptKey, 'key', 32);
      const iv = randomBytes(16);
      const cipher = createCipheriv('aes-256-cbc', keyBuffer, iv);
      const encryptedBody = Buffer.concat([iv, cipher.update(eventPayload, 'utf8'), cipher.final()]);
      const body = JSON.stringify({ encrypt: encryptedBody.toString('base64') });

      const res = await httpRequest(port, 'POST', '/', body);
      expect(res.status).toBe(200);
      await new Promise(r => setTimeout(r, 80));
      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0].content.text).toBe('encrypted hello');
      await fresh.disconnect();
      vi.unstubAllGlobals();
    });

    it('POST encrypted payload without encryptKey returns ok without handler', async () => {
      const fresh = new FeishuAdapter();
      const handler = vi.fn().mockResolvedValue(undefined);
      fresh.onMessage(handler);

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ code: 0, tenant_access_token: 'tok', expire: 7200 }),
        }),
      );

      await fresh.connect({
        platform: 'feishu',
        appId: 'cli_test',
        appSecret: 'secret',
        wsMode: false,
        webhookPort: port,
      });
      await new Promise(r => setTimeout(r, 50));

      const res = await httpRequest(port, 'POST', '/', JSON.stringify({ encrypt: 'abc123' }));
      expect(res.status).toBe(200);
      await new Promise(r => setTimeout(r, 50));
      expect(handler).not.toHaveBeenCalled();
      await fresh.disconnect();
      vi.unstubAllGlobals();
    });

    it('POST message with non-JSON content uses raw content', async () => {
      const fresh = new FeishuAdapter();
      const handler = vi.fn().mockResolvedValue(undefined);
      fresh.onMessage(handler);

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ code: 0, tenant_access_token: 'tok', expire: 7200 }),
        }),
      );

      await fresh.connect({
        platform: 'feishu',
        appId: 'cli_test',
        appSecret: 'secret',
        wsMode: false,
        webhookPort: port,
      });
      await new Promise(r => setTimeout(r, 50));

      const body = JSON.stringify({
        header: { event_id: 'evt-raw', event_type: 'im.message.receive_v1' },
        event: {
          sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
          message: {
            message_id: 'om_raw',
            chat_id: 'oc_chat',
            chat_type: 'group',
            message_type: 'text',
            content: 'plain text content',
          },
        },
      });

      await httpRequest(port, 'POST', '/', body);
      await new Promise(r => setTimeout(r, 80));
      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0].content.text).toBe('plain text content');
      await fresh.disconnect();
      vi.unstubAllGlobals();
    });

    it('rejects non-POST webhook requests with 405', async () => {
      const fresh = new FeishuAdapter();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ code: 0, tenant_access_token: 'tok', expire: 7200 }),
        }),
      );

      await fresh.connect({
        platform: 'feishu',
        appId: 'cli_test',
        appSecret: 'secret',
        wsMode: false,
        webhookPort: port,
      });
      await new Promise(r => setTimeout(r, 50));

      const res = await httpRequest(port, 'GET', '/');
      expect(res.status).toBe(405);
      await fresh.disconnect();
      vi.unstubAllGlobals();
    });

    it('skips duplicate webhook events', async () => {
      const fresh = new FeishuAdapter();
      const handler = vi.fn().mockResolvedValue(undefined);
      fresh.onMessage(handler);

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ code: 0, tenant_access_token: 'tok', expire: 7200 }),
        }),
      );

      await fresh.connect({
        platform: 'feishu',
        appId: 'cli_test',
        appSecret: 'secret',
        wsMode: false,
        webhookPort: port,
      });
      await new Promise(r => setTimeout(r, 50));

      const body = JSON.stringify({
        header: { event_id: 'evt-dup', event_type: 'im.message.receive_v1' },
        event: {
          sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
          message: {
            message_id: 'om_dup',
            chat_id: 'oc_chat',
            chat_type: 'group',
            message_type: 'text',
            content: JSON.stringify({ text: 'dup msg' }),
          },
        },
      });

      await httpRequest(port, 'POST', '/', body);
      await httpRequest(port, 'POST', '/', body);
      await new Promise(r => setTimeout(r, 80));
      expect(handler).toHaveBeenCalledTimes(1);
      await fresh.disconnect();
      vi.unstubAllGlobals();
    });

    it('handler errors are swallowed without crashing webhook', async () => {
      const fresh = new FeishuAdapter();
      fresh.onMessage(vi.fn().mockRejectedValue(new Error('handler boom')));

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ code: 0, tenant_access_token: 'tok', expire: 7200 }),
        }),
      );

      await fresh.connect({
        platform: 'feishu',
        appId: 'cli_test',
        appSecret: 'secret',
        wsMode: false,
        webhookPort: port,
      });
      await new Promise(r => setTimeout(r, 50));

      const body = JSON.stringify({
        header: { event_id: 'evt-err', event_type: 'im.message.receive_v1' },
        event: {
          sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
          message: {
            message_id: 'om_err',
            chat_id: 'oc_chat',
            chat_type: 'group',
            message_type: 'text',
            content: JSON.stringify({ text: 'trigger error' }),
          },
        },
      });

      const res = await httpRequest(port, 'POST', '/', body);
      expect(res.status).toBe(200);
      await fresh.disconnect();
      vi.unstubAllGlobals();
    });
  });

  describe('long connection (official Lark SDK)', () => {
    it('is the default receiver — the SDK long connection starts, no webhook server', async () => {
      sdkState.wsStarts = 0;
      const fresh = new FeishuAdapter();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ code: 0, tenant_access_token: 'tok', expire: 7200 }),
        }),
      );

      await fresh.connect({ platform: 'feishu', appId: 'cli_test', appSecret: 'secret' });

      expect(sdkState.wsStarts).toBe(1);
      expect((fresh as Record<string, unknown>)['server']).toBeUndefined();
      expect(fresh.isConnected()).toBe(true);

      await fresh.disconnect();
      vi.unstubAllGlobals();
    });

    it('normalises SDK payloads and reports instanceId + channelKind (p2p → dm)', async () => {
      const fresh = new FeishuAdapter();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ code: 0, tenant_access_token: 'tok', expire: 7200 }),
        }),
      );
      const handler = vi.fn().mockResolvedValue(undefined);
      fresh.onMessage(handler);

      await fresh.connect({
        platform: 'feishu',
        instanceId: 'bi_support',
        appId: 'cli_test',
        appSecret: 'secret',
      });

      // The SDK hands us the inner event — no envelope.
      sdkState.dispatcher!.handlers['im.message.receive_v1']({
        sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
        message: {
          message_id: 'om_lc',
          chat_id: 'oc_dm',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: 'lc hello' }),
        },
      });
      await new Promise((r) => setTimeout(r, 20));

      expect(handler).toHaveBeenCalledOnce();
      const msg = handler.mock.calls[0][0];
      expect(msg.content.text).toBe('lc hello');
      expect(msg.instanceId).toBe('bi_support');
      expect(msg.channelKind).toBe('dm');

      await fresh.disconnect();
      vi.unstubAllGlobals();
    });

    it('routes card actions to the action port, never to the message handler', async () => {
      const fresh = new FeishuAdapter();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ code: 0, tenant_access_token: 'tok', expire: 7200 }),
        }),
      );
      const onMessage = vi.fn().mockResolvedValue(undefined);
      const onAction = vi.fn().mockResolvedValue(undefined);
      fresh.onMessage(onMessage);
      fresh.onAction(onAction);

      await fresh.connect({
        platform: 'feishu',
        instanceId: 'bi_secretary',
        appId: 'cli_test',
        appSecret: 'secret',
      });

      sdkState.dispatcher!.handlers['card.action.trigger']({
        action: { value: { approval_id: 'appr_1', action: 'approve' } },
        operator: { open_id: 'ou_boss' },
      });
      await new Promise((r) => setTimeout(r, 20));

      expect(onAction).toHaveBeenCalledOnce();
      expect(onMessage).not.toHaveBeenCalled();
      const action = onAction.mock.calls[0][0];
      expect(action.platform).toBe('feishu');
      expect(action.instanceId).toBe('bi_secretary');
      expect(action.actorId).toBe('ou_boss');
      expect((action.payload as Record<string, any>).action.value.approval_id).toBe('appr_1');

      await fresh.disconnect();
      vi.unstubAllGlobals();
    });

    it('drops a card action when no action handler is registered (no throw)', async () => {
      const fresh = new FeishuAdapter();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ code: 0, tenant_access_token: 'tok', expire: 7200 }),
        }),
      );
      await fresh.connect({ platform: 'feishu', appId: 'cli_test', appSecret: 'secret' });

      expect(() =>
        sdkState.dispatcher!.handlers['card.action.trigger']({
          action: { value: { approval_id: 'appr_1' } },
        }),
      ).not.toThrow();

      await fresh.disconnect();
      vi.unstubAllGlobals();
    });
  });
});
