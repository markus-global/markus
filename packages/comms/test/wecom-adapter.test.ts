import { createServer, request as httpRequestRaw } from 'node:http';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WeComAdapter } from '../src/wecom/adapter.js';
import type { WeComClient } from '../src/wecom/client.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeMockClient(): Partial<WeComClient> {
  return {
    getAccessToken: vi.fn().mockResolvedValue('mock-access-token'),
    sendTextMessage: vi.fn().mockResolvedValue('msg_1234567890'),
    verifySignature: vi.fn().mockReturnValue(true),
    decrypt: vi.fn().mockReturnValue(
      '<xml><ToUserName><![CDATA[wx_app]]></ToUserName><FromUserName><![CDATA[user1]]></FromUserName><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[hello]]></Content><MsgId><![CDATA[123456]]></MsgId><AgentID><![CDATA[1000001]]></AgentID><CreateTime><![CDATA[1234567890]]></CreateTime></xml>',
    ),
    verifyEchoStr: vi.fn().mockReturnValue('decrypted-challenge'),
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
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequestRaw(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: body
          ? { 'Content-Type': 'application/xml', 'Content-Length': Buffer.byteLength(body) }
          : undefined,
      },
      res => {
        let text = '';
        res.on('data', (chunk: string) => {
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

// ── Tests ──────────────────────────────────────────────────────────────────

describe('WeComAdapter', () => {
  let adapter: WeComAdapter;
  let mockClient: ReturnType<typeof makeMockClient>;

  beforeEach(() => {
    adapter = new WeComAdapter();
    mockClient = makeMockClient();
    (adapter as Record<string, unknown>)['client'] = mockClient;
    (adapter as Record<string, unknown>)['config'] = {
      platform: 'wecom',
      corpid: 'test-corpid',
      corpsecret: 'test-secret',
      agentid: 1000001,
      token: 'test-token',
      encodingAESKey: 'abcdefghijklmnopqrstuvwxyz1234567890ABCDEF',
    };
    (adapter as Record<string, unknown>)['connected'] = true;
  });

  // ── Basic ────────────────────────────────────────────────────────────────

  describe('platform', () => {
    it('should be set to wecom', () => {
      expect(adapter.platform).toBe('wecom');
    });
  });

  describe('isConnected', () => {
    it('should reflect connection state', () => {
      expect(adapter.isConnected()).toBe(true);
      (adapter as Record<string, unknown>)['connected'] = false;
      expect(adapter.isConnected()).toBe(false);
    });
  });

  // ── connect ──────────────────────────────────────────────────────────────

  describe('connect', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('should authenticate and connect successfully', async () => {
      const fresh = new WeComAdapter();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          json: async () => ({ errcode: 0, errmsg: 'ok', access_token: 'tok', expires_in: 7200 }),
        }),
      );

      await fresh.connect({
        platform: 'wecom',
        corpid: 'test-corpid',
        corpsecret: 'test-secret',
        agentid: 1000001,
      });

      expect(fresh.isConnected()).toBe(true);
      await fresh.disconnect();
    });

    it('should throw on auth failure', async () => {
      const fresh = new WeComAdapter();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          json: async () => ({ errcode: 40013, errmsg: 'invalid corpid' }),
        }),
      );

      await expect(
        fresh.connect({
          platform: 'wecom',
          corpid: 'bad',
          corpsecret: 'bad',
          agentid: 1,
        }),
      ).rejects.toThrow('WeCom auth failed: invalid corpid (code: 40013)');
    });

    it('should connect without webhookPort (send-only mode)', async () => {
      const fresh = new WeComAdapter();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          json: async () => ({ errcode: 0, errmsg: 'ok', access_token: 'tok', expires_in: 7200 }),
        }),
      );

      await fresh.connect({
        platform: 'wecom',
        corpid: 'test-corpid',
        corpsecret: 'test-secret',
        agentid: 1000001,
        // no webhookPort
      });

      expect(fresh.isConnected()).toBe(true);
      await fresh.disconnect();
    });
  });

  // ── disconnect ───────────────────────────────────────────────────────────

  describe('disconnect', () => {
    it('should close server and clear state', async () => {
      const closeMock = vi.fn();
      (adapter as Record<string, unknown>)['server'] = { close: closeMock };

      await adapter.disconnect();

      expect(closeMock).toHaveBeenCalled();
      expect(adapter.isConnected()).toBe(false);
      expect((adapter as Record<string, unknown>)['client']).toBeUndefined();
    });

    it('should handle disconnect without a server', async () => {
      (adapter as Record<string, unknown>)['server'] = undefined;

      await adapter.disconnect();

      expect(adapter.isConnected()).toBe(false);
    });
  });

  // ── sendMessage ──────────────────────────────────────────────────────────

  describe('sendMessage', () => {
    it('should delegate to client.sendTextMessage', async () => {
      const result = await adapter.sendMessage('user1|user2', 'Hello');

      expect(result).toBe('msg_1234567890');
      expect(mockClient.sendTextMessage).toHaveBeenCalledWith('Hello', 'user1|user2');
    });

    it('should throw when not connected', async () => {
      (adapter as Record<string, unknown>)['client'] = undefined;

      await expect(adapter.sendMessage('user', 'Hi')).rejects.toThrow('WeCom adapter not connected');
    });

    it('should propagate client errors', async () => {
      mockClient.sendTextMessage = vi.fn().mockRejectedValue(new Error('API error'));

      await expect(adapter.sendMessage('user', 'Hi')).rejects.toThrow('API error');
    });
  });

  // ── sendReply ────────────────────────────────────────────────────────────

  describe('sendReply', () => {
    it('should delegate to client.sendTextMessage (no thread support)', async () => {
      const result = await adapter.sendReply('user1', 'original-msg-id', 'Reply text');

      expect(result).toBe('msg_1234567890');
      expect(mockClient.sendTextMessage).toHaveBeenCalledWith('Reply text', 'user1');
    });

    it('should throw when not connected', async () => {
      (adapter as Record<string, unknown>)['client'] = undefined;

      await expect(adapter.sendReply('user', 'reply', 'Hi')).rejects.toThrow('WeCom adapter not connected');
    });

    it('should propagate client errors', async () => {
      mockClient.sendTextMessage = vi.fn().mockRejectedValue(new Error('send failed'));

      await expect(adapter.sendReply('user', 'reply', 'Hi')).rejects.toThrow('send failed');
    });
  });

  // ── onMessage ────────────────────────────────────────────────────────────

  describe('onMessage', () => {
    it('should register handlers', () => {
      const handler = vi.fn();
      adapter.onMessage(handler);

      const handlers = (adapter as Record<string, unknown>)['handlers'] as unknown[];
      expect(handlers).toContain(handler);
    });
  });

  // ── XML helpers ──────────────────────────────────────────────────────────

  describe('extractCdata', () => {
    it('should extract CDATA-wrapped values', () => {
      const adapterWithMethod = new WeComAdapter();
      const extractCdata = (adapterWithMethod as Record<string, unknown>)['extractCdata'] as (
        xml: string,
        tag: string,
      ) => string;

      const xml = '<xml><FromUserName><![CDATA[user1]]></FromUserName></xml>';
      const result = extractCdata(xml, 'FromUserName');
      expect(result).toBe('user1');
    });

    it('should fall back to plain text when no CDATA', () => {
      const adapterWithMethod = new WeComAdapter();
      const extractCdata = (adapterWithMethod as Record<string, unknown>)['extractCdata'] as (
        xml: string,
        tag: string,
      ) => string;

      const xml = '<xml><MsgType>text</MsgType></xml>';
      const result = extractCdata(xml, 'MsgType');
      expect(result).toBe('text');
    });

    it('should return empty string for missing tag', () => {
      const adapterWithMethod = new WeComAdapter();
      const extractCdata = (adapterWithMethod as Record<string, unknown>)['extractCdata'] as (
        xml: string,
        tag: string,
      ) => string;

      const result = extractCdata('<xml></xml>', 'NonExistent');
      expect(result).toBe('');
    });
  });

  describe('parseMessageXml', () => {
    it('should parse a decrypted message XML into structured object', () => {
      const adapterWithMethod = new WeComAdapter();
      const parseMessageXml = (adapterWithMethod as Record<string, unknown>)['parseMessageXml'] as (
        xml: string,
      ) => {
        fromUserName: string;
        toUserName: string;
        msgType: string;
        content: string;
        msgId: string;
        agentId: number;
        createTime: string;
      };

      const xml =
        '<xml><ToUserName><![CDATA[wx_app]]></ToUserName><FromUserName><![CDATA[user1]]></FromUserName><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[hello world]]></Content><MsgId><![CDATA[123456789]]></MsgId><AgentID><![CDATA[1000001]]></AgentID><CreateTime><![CDATA[1234567890]]></CreateTime></xml>';

      // Use .call() to preserve this context for this.extractCdata() calls
      const result = parseMessageXml.call(adapterWithMethod, xml);

      expect(result.fromUserName).toBe('user1');
      expect(result.toUserName).toBe('wx_app');
      expect(result.msgType).toBe('text');
      expect(result.content).toBe('hello world');
      expect(result.msgId).toBe('123456789');
      expect(result.agentId).toBe(1000001);
      expect(result.createTime).toBe('1234567890');
    });
  });

  // ── Webhook server ───────────────────────────────────────────────────────

  describe('webhook server', () => {
    let port: number;

    beforeEach(async () => {
      port = await getFreePort();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    async function createConnectedAdapter(
      clientOverrides?: Partial<ReturnType<typeof makeMockClient>>,
    ): Promise<{ fresh: WeComAdapter; handler: ReturnType<typeof vi.fn> }> {
      const fresh = new WeComAdapter();
      const mergedClient = { ...mockClient, ...clientOverrides };
      (fresh as Record<string, unknown>)['client'] = mergedClient;
      (fresh as Record<string, unknown>)['config'] = {
        platform: 'wecom',
        corpid: 'test-corpid',
        corpsecret: 'test-secret',
        agentid: 1000001,
        token: 'test-token',
        encodingAESKey: 'abcdefghijklmnopqrstuvwxyz1234567890ABCDEF',
        webhookPort: port,
      };
      (fresh as Record<string, unknown>)['connected'] = true;

      await (fresh as Record<string, unknown>)['setupWebhookServer']();

      const handler = vi.fn().mockResolvedValue(undefined);
      fresh.onMessage(handler);

      // Give server time to start listening
      await new Promise(r => setTimeout(r, 100));

      return { fresh, handler };
    }

    it('GET /webhook/wecom with echostr should return decrypted challenge', async () => {
      const { fresh } = await createConnectedAdapter();
      const path = '/webhook/wecom?msg_signature=sig&timestamp=123&nonce=nonce&echostr=echostr_base64';

      const res = await httpRequest(port, 'GET', path);

      expect(res.status).toBe(200);
      expect(res.text).toBe('decrypted-challenge');
      await fresh.disconnect();
    });

    it('GET /webhook/wecom without echostr should return 400', async () => {
      const { fresh } = await createConnectedAdapter();

      const res = await httpRequest(port, 'GET', '/webhook/wecom');

      expect(res.status).toBe(400);
      expect(res.text).toBe('Missing echostr parameter');
      await fresh.disconnect();
    });

    it('POST /webhook/wecom with encrypted message should invoke handler', async () => {
      const { fresh, handler } = await createConnectedAdapter();
      const xmlBody =
        '<xml><ToUserName><![CDATA[wx_app]]></ToUserName><Encrypt><![CDATA[encrypted-base64]]></Encrypt><AgentID><![CDATA[1000001]]></AgentID></xml>';

      const res = await httpRequest(port, 'POST', '/webhook/wecom?msg_signature=sig&timestamp=123&nonce=nonce', xmlBody);

      expect(res.status).toBe(200);
      expect(res.text).toContain('SUCCESS');
      await new Promise(r => setTimeout(r, 50));

      expect(mockClient.verifySignature).toHaveBeenCalledWith('sig', '123', 'nonce', 'encrypted-base64');
      expect(mockClient.decrypt).toHaveBeenCalledWith('encrypted-base64');
      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0].content.text).toBe('hello');
      expect(handler.mock.calls[0][0].platform).toBe('wecom');
      await fresh.disconnect();
    });

    it('POST /webhook/wecom with missing Encrypt should return 400', async () => {
      const { fresh } = await createConnectedAdapter();
      const xmlBody = '<xml><ToUserName><![CDATA[wx_app]]></ToUserName><AgentID><![CDATA[1000001]]></AgentID></xml>';

      const res = await httpRequest(port, 'POST', '/webhook/wecom?msg_signature=sig&timestamp=123&nonce=nonce', xmlBody);

      expect(res.status).toBe(400);
      expect(res.text).toContain('Missing Encrypt');
      await fresh.disconnect();
    });

    it('POST /webhook/wecom with bad signature should return 403', async () => {
      const { fresh } = await createConnectedAdapter({
        verifySignature: vi.fn().mockReturnValue(false),
      });
      const xmlBody =
        '<xml><ToUserName><![CDATA[wx_app]]></ToUserName><Encrypt><![CDATA[enc]]></Encrypt><AgentID><![CDATA[1000001]]></AgentID></xml>';

      const res = await httpRequest(port, 'POST', '/webhook/wecom?msg_signature=bad&timestamp=123&nonce=nonce', xmlBody);

      expect(res.status).toBe(403);
      expect(res.text).toContain('Signature verification failed');
      await fresh.disconnect();
    });

    it('POST /webhook/wecom with non-text message type should not invoke handler', async () => {
      const { fresh, handler } = await createConnectedAdapter({
        decrypt: vi.fn().mockReturnValue(
          '<xml><ToUserName><![CDATA[wx_app]]></ToUserName><FromUserName><![CDATA[user1]]></FromUserName><MsgType><![CDATA[image]]></MsgType><Content><![CDATA[image.jpg]]></Content><MsgId><![CDATA[123]]></MsgId><AgentID><![CDATA[1000001]]></AgentID><CreateTime><![CDATA[1234567890]]></CreateTime></xml>',
        ),
      });
      const xmlBody =
        '<xml><ToUserName><![CDATA[wx_app]]></ToUserName><Encrypt><![CDATA[enc]]></Encrypt><AgentID><![CDATA[1000001]]></AgentID></xml>';

      const res = await httpRequest(port, 'POST', '/webhook/wecom?msg_signature=sig&timestamp=123&nonce=nonce', xmlBody);

      expect(res.status).toBe(200);
      await new Promise(r => setTimeout(r, 50));
      expect(handler).not.toHaveBeenCalled();
      await fresh.disconnect();
    });

    it('POST /webhook/wecom should return 200 even when handler throws (error swallowed)', async () => {
      const { fresh, handler } = await createConnectedAdapter();
      handler.mockRejectedValue(new Error('handler crash'));

      const xmlBody =
        '<xml><ToUserName><![CDATA[wx_app]]></ToUserName><Encrypt><![CDATA[enc]]></Encrypt><AgentID><![CDATA[1000001]]></AgentID></xml>';

      const res = await httpRequest(port, 'POST', '/webhook/wecom?msg_signature=sig&timestamp=123&nonce=nonce', xmlBody);

      expect(res.status).toBe(200);
      await fresh.disconnect();
    });

    it('GET /unknown should return 404', async () => {
      const { fresh } = await createConnectedAdapter();

      const res = await httpRequest(port, 'GET', '/unknown');

      expect(res.status).toBe(404);
      await fresh.disconnect();
    });

    it('POST /webhook/wecom with verifyEcho throwing should return 403 on GET', async () => {
      const { fresh } = await createConnectedAdapter({
        verifyEchoStr: vi.fn().mockImplementation(() => {
          throw new Error('signature mismatch');
        }),
      });
      const path = '/webhook/wecom?msg_signature=bad&timestamp=123&nonce=nonce&echostr=echostr';

      const res = await httpRequest(port, 'GET', path);

      expect(res.status).toBe(403);
      expect(res.text).toBe('Signature verification failed');
      await fresh.disconnect();
    });
  });
});
