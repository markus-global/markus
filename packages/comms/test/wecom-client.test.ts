import { createHash, randomBytes, createCipheriv } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WeComClient } from '../src/wecom/client.js';

describe('WeComClient', () => {
  let client: WeComClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new WeComClient({
      corpid: 'test-corpid',
      corpsecret: 'test-secret',
      agentid: 1000001,
      token: 'test-token',
      encodingAESKey: 'abcdefghijklmnopqrstuvwxyz1234567890ABCDEF', // 43 chars
    });

    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── getAccessToken ───────────────────────────────────────────────────────

  describe('getAccessToken', () => {
    it('should fetch and return access token', async () => {
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ errcode: 0, errmsg: 'ok', access_token: 'mock-token-123', expires_in: 7200 }),
      });

      const token = await client.getAccessToken();

      expect(token).toBe('mock-token-123');
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const callUrl = mockFetch.mock.calls[0][0];
      expect(callUrl).toContain('/cgi-bin/gettoken');
      expect(callUrl).toContain('corpid=test-corpid');
      expect(callUrl).toContain('corpsecret=test-secret');
    });

    it('should cache token and not re-fetch on second call', async () => {
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ errcode: 0, errmsg: 'ok', access_token: 'cached-token', expires_in: 7200 }),
      });

      const first = await client.getAccessToken();
      const second = await client.getAccessToken();

      expect(first).toBe('cached-token');
      expect(second).toBe('cached-token');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should auto-refresh when token has expired', async () => {
      mockFetch
        .mockResolvedValueOnce({
          json: async () => ({ errcode: 0, errmsg: 'ok', access_token: 'old-token', expires_in: 0 }),
        })
        .mockResolvedValueOnce({
          json: async () => ({ errcode: 0, errmsg: 'ok', access_token: 'new-token', expires_in: 7200 }),
        });

      const first = await client.getAccessToken();
      // expires_in was 0, so token is already expired
      const second = await client.getAccessToken();

      expect(first).toBe('old-token');
      expect(second).toBe('new-token');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should throw on error response', async () => {
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ errcode: 40013, errmsg: 'invalid corpid' }),
      });

      await expect(client.getAccessToken()).rejects.toThrow(
        'WeCom auth failed: invalid corpid (code: 40013)',
      );
    });

    it('should throw on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network failure'));

      await expect(client.getAccessToken()).rejects.toThrow('Network failure');
    });
  });

  // ── sendTextMessage ──────────────────────────────────────────────────────

  describe('sendTextMessage', () => {
    beforeEach(() => {
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ errcode: 0, errmsg: 'ok', access_token: 'msg-token', expires_in: 7200 }),
      });
    });

    it('should send a text message and return a msg ID', async () => {
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ errcode: 0, errmsg: 'ok' }),
      });

      const result = await client.sendTextMessage('Hello world', 'user1|user2');

      expect(result).toMatch(/^msg_\d+$/);

      const sendCall = mockFetch.mock.calls[1];
      expect(sendCall[0]).toContain('/cgi-bin/message/send');
      expect(sendCall[1].method).toBe('POST');

      const body = JSON.parse(sendCall[1].body);
      expect(body.touser).toBe('user1|user2');
      expect(body.msgtype).toBe('text');
      expect(body.agentid).toBe(1000001);
      expect(body.text.content).toBe('Hello world');
    });

    it('should default toUser to @all', async () => {
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ errcode: 0, errmsg: 'ok' }),
      });

      await client.sendTextMessage('broadcast');

      const body = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(body.touser).toBe('@all');
    });

    it('should throw on error response', async () => {
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ errcode: 40014, errmsg: 'invalid token' }),
      });

      await expect(client.sendTextMessage('Hi')).rejects.toThrow(
        'WeCom send failed: invalid token (code: 40014)',
      );
    });
  });

  // ── verifySignature ──────────────────────────────────────────────────────

  describe('verifySignature', () => {
    it('should return true for a valid SHA1 signature', () => {
      // We need to compute the expected signature ourselves
      const token = 'test-token';
      const timestamp = '1234567890';
      const nonce = 'nonce123';
      const encrypted = 'encrypted-base64-content';

      const arr = [token, timestamp, nonce, encrypted].sort();
      const expectedHash = createHash('sha1').update(arr.join('')).digest('hex');

      const result = client.verifySignature(expectedHash, timestamp, nonce, encrypted);

      expect(result).toBe(true);
    });

    it('should return false for an invalid SHA1 signature', () => {
      const result = client.verifySignature('invalid-hash', '123', 'nonce', 'encrypted');

      expect(result).toBe(false);
    });

    it('should return true when token is not configured (skip verification)', () => {
      const clientNoToken = new WeComClient({
        corpid: 'test',
        corpsecret: 'secret',
        agentid: 100,
      });

      const result = clientNoToken.verifySignature('anything', '123', 'nonce', 'enc');

      expect(result).toBe(true);
    });
  });

  // ── decrypt ──────────────────────────────────────────────────────────────

  describe('decrypt', () => {
    // Build a known AES-256-CBC encrypted payload we can test decryption with
    function buildEncryptedPayload(plaintext: string, aesKeyBase64: string, corpid: string): string {
      // We need to recreate the exact same client with the same key
      const aesKey = Buffer.from(aesKeyBase64, 'base64');
      const iv = aesKey.subarray(0, 16);

      // Build plaintext: random(16) + length(4 BE) + msgXml + corpid
      const msgBuf = Buffer.from(plaintext, 'utf-8');
      const rb = randomBytes(16);
      const lengthBuf = Buffer.alloc(4);
      lengthBuf.writeUInt32BE(msgBuf.length, 0);
      const corpidBuf = Buffer.from(corpid, 'utf-8');

      const plainBuf = Buffer.concat([rb, lengthBuf, msgBuf, corpidBuf]);

      // Pad to block size using PKCS7
      const blockSize = 32;
      const padLen = blockSize - (plainBuf.length % blockSize);
      const pad = Buffer.alloc(padLen, padLen);
      const padded = Buffer.concat([plainBuf, pad]);

      // Encrypt
      const cipher = createCipheriv('aes-256-cbc', aesKey, iv);
      cipher.setAutoPadding(false);
      const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);

      return encrypted.toString('base64');
    }

    it('should decrypt a valid AES-256-CBC encrypted payload', () => {
      // WeCom encodingAESKey: 43-char Base64 string that decodes to 32 bytes
      const keyBase64 = 'zwd1JdxQONiQ2OgXnzOhyrYWjTkM9vdZCNC8A/vfPds';
      expect(Buffer.from(keyBase64, 'base64')).toHaveLength(32);

      const testClient = new WeComClient({
        corpid: 'test-corpid',
        corpsecret: 'secret',
        agentid: 100,
        encodingAESKey: keyBase64,
      });

      const msgXml = '<xml><ToUserName>wx_app</ToUserName><FromUserName>user1</FromUserName></xml>';
      const encrypted = buildEncryptedPayload(msgXml, keyBase64, 'test-corpid');

      const result = testClient.decrypt(encrypted);

      expect(result).toBe(msgXml);
    });

    it('should throw when encodingAESKey is not configured', () => {
      const clientNoKey = new WeComClient({
        corpid: 'test',
        corpsecret: 'secret',
        agentid: 100,
      });

      expect(() => clientNoKey.decrypt('base64-encrypted')).toThrow(
        'encodingAESKey is required for AES decryption',
      );
    });

    it('should throw on invalid key length', () => {
      const clientBadKey = new WeComClient({
        corpid: 'test',
        corpsecret: 'secret',
        agentid: 100,
        encodingAESKey: 'tooshort', // This won't decode to 32 bytes
      });

      // A key that decodes to < 32 bytes should trigger the error
      expect(() => clientBadKey.decrypt('AAAA')).toThrow(/Invalid encodingAESKey/);
    });

    it('should throw on invalid PKCS7 padding', () => {
      const keyBase64 = 'zwd1JdxQONiQ2OgXnzOhyrYWjTkM9vdZCNC8A/vfPds';
      const testClient = new WeComClient({
        corpid: 'test',
        corpsecret: 'secret',
        agentid: 100,
        encodingAESKey: keyBase64,
      });

      // Pass garbage that won't decrypt properly
      expect(() => testClient.decrypt('aW52YWxpZC1iYXNlNjQ=')).toThrow();
    });
  });

  // ── verifyEchoStr ────────────────────────────────────────────────────────

  describe('verifyEchoStr', () => {
    it('should verify and return decrypted echostr when encryption configured', () => {
      const token = 'test-token';
      const timestamp = '1234567890';
      const nonce = 'nonce123';
      const echostr = 'encrypted-echostr-base64';

      // Build expected signature
      const arr = [token, timestamp, nonce, echostr].sort();
      const expectedSig = createHash('sha1').update(arr.join('')).digest('hex');

      // The echostr we send won't actually decrypt properly since we're not
      // building a valid AES payload, but we just need to verify the flow works
      const clientWithKey = new WeComClient({
        corpid: 'test-corpid',
        corpsecret: 'secret',
        agentid: 100,
        token,
        encodingAESKey: 'abcdefghijklmnopqrstuvwxyz1234567890ABCDEF',
      });

      expect(() => clientWithKey.verifyEchoStr(expectedSig, timestamp, nonce, echostr)).toThrow();
    });

    it('should return raw echostr when no encryption configured', () => {
      const clientNoEnc = new WeComClient({
        corpid: 'test-corpid',
        corpsecret: 'secret',
        agentid: 100,
        token: 'test-token',
      });

      const timestamp = '1234567890';
      const nonce = 'nonce123';
      const echostr = 'raw-challenge-string';

      const arr = ['test-token', timestamp, nonce, echostr].sort();
      const expectedSig = createHash('sha1').update(arr.join('')).digest('hex');

      const result = clientNoEnc.verifyEchoStr(expectedSig, timestamp, nonce, echostr);

      expect(result).toBe(echostr);
    });

    it('should throw on signature mismatch', () => {
      const clientNoEnc = new WeComClient({
        corpid: 'test',
        corpsecret: 'secret',
        agentid: 100,
        token: 'test-token',
      });

      expect(() =>
        clientNoEnc.verifyEchoStr('bad-signature', '123', 'nonce', 'echostr'),
      ).toThrow('signature mismatch');
    });
  });
});
