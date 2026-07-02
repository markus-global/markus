import { createHash, createDecipheriv } from 'node:crypto';
import { createLogger } from '@markus/shared';

const log = createLogger('wecom-client');

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WeComConfig {
  corpid: string;
  corpsecret: string;
  agentid: number;
  /** Callback verification token (configured in WeCom admin console) */
  token?: string;
  /** Callback AES encoding key — 43 chars, Base64 (configured in WeCom admin console) */
  encodingAESKey?: string;
}

interface TokenResponse {
  errcode: number;
  errmsg: string;
  access_token?: string;
  expires_in?: number;
}

interface SendMessageResponse {
  errcode: number;
  errmsg: string;
  invaliduser?: string;
}

// ─── Client ──────────────────────────────────────────────────────────────────

export class WeComClient {
  private config: WeComConfig;
  private apiBase = 'https://qyapi.weixin.qq.com';
  private accessToken?: string;
  private tokenExpiresAt = 0;

  constructor(config: WeComConfig) {
    this.config = config;
  }

  /**
   * Get a valid access token. Caches and auto-refreshes before expiry.
   */
  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }

    const url = `${this.apiBase}/cgi-bin/gettoken?corpid=${encodeURIComponent(this.config.corpid)}&corpsecret=${encodeURIComponent(this.config.corpsecret)}`;
    const res = await fetch(url, { method: 'POST' });
    const data = (await res.json()) as TokenResponse;

    if (data.errcode !== 0) {
      throw new Error(`WeCom auth failed: ${data.errmsg} (code: ${data.errcode})`);
    }

    this.accessToken = data.access_token!;
    // Refresh 60 seconds before actual expiry (expires_in is typically 7200s)
    this.tokenExpiresAt = Date.now() + (data.expires_in! - 60) * 1000;

    return this.accessToken;
  }

  /**
   * Send a text message to a WeCom user or party.
   *
   * @param content - The text content to send.
   * @param toUser - Target users ("@all" for broadcast, "user1|user2" for specific users).
   * @returns The message ID on success.
   */
  async sendTextMessage(content: string, toUser = '@all'): Promise<string> {
    const token = await this.getAccessToken();

    const body = {
      touser: toUser,
      msgtype: 'text' as const,
      agentid: this.config.agentid,
      text: { content },
      safe: 0,
      enable_id_trans: 0,
      enable_duplicate_check: 0,
    };

    const res = await fetch(`${this.apiBase}/cgi-bin/message/send?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = (await res.json()) as SendMessageResponse;
    if (data.errcode !== 0) {
      throw new Error(`WeCom send failed: ${data.errmsg} (code: ${data.errcode})`);
    }

    return `msg_${Date.now()}`;
  }

  // ─── Callback Crypto (企业微信回调协议) ──────────────────────────────────

  /**
   * Verify WeCom callback signature using SHA1.
   *
   * Per the official WeCom callback protocol:
   *   msg_signature = SHA1( sort([token, timestamp, nonce, encrypted]) )
   *
   * The four values are sorted alphabetically, concatenated, and SHA1-hashed.
   */
  verifySignature(msgSignature: string, timestamp: string, nonce: string, encrypted: string): boolean {
    if (!this.config.token) {
      log.warn('WeCom callback token not configured — skipping signature verification');
      return true;
    }

    const arr = [this.config.token, timestamp, nonce, encrypted].sort();
    const str = arr.join('');
    const hash = createHash('sha1').update(str).digest('hex');

    const valid = hash === msgSignature.toLowerCase();
    if (!valid) {
      log.error('WeCom callback signature mismatch', {
        expected: hash,
        received: msgSignature,
      });
    }
    return valid;
  }

  /**
   * AES-256-CBC decrypt a WeCom encrypted message payload.
   *
   * Key derivation:
   *   - encodingAESKey is a 43-character Base64 string
   *   - Base64 decode → 32 bytes (256-bit AES key)
   *   - IV = first 16 bytes of the AES key
   *
   * Decrypted binary layout:
   *   [0..15]   random bytes (16 bytes, discarded)
   *   [16..19]  message length (4 bytes, big-endian uint32)
   *   [20..N]   message XML content (N = 20 + msgLen)
   *   [N..end]  corpid (for validation)
   *
   * After decryption, PKCS7 padding is removed and the message XML is returned.
   */
  decrypt(encryptedBase64: string): string {
    if (!this.config.encodingAESKey) {
      throw new Error('encodingAESKey is required for AES decryption — configure it in WeCom admin console');
    }

    // Decode key: Base64(43 chars) → 32 bytes
    const aesKey = Buffer.from(this.config.encodingAESKey, 'base64');
    if (aesKey.length !== 32) {
      throw new Error(`Invalid encodingAESKey: expected 32 bytes after Base64 decode, got ${aesKey.length}`);
    }

    // IV = first 16 bytes of AES key (WeCom protocol convention)
    const iv = aesKey.subarray(0, 16);
    const decipher = createDecipheriv('aes-256-cbc', aesKey, iv);
    decipher.setAutoPadding(false);

    const encrypted = Buffer.from(encryptedBase64, 'base64');
    let decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

    // Remove PKCS7 padding
    const pad = decrypted[decrypted.length - 1];
    if (pad < 1 || pad > 32) {
      throw new Error(`Invalid PKCS7 padding value: ${pad}`);
    }
    decrypted = decrypted.subarray(0, decrypted.length - pad);

    // Parse: random(16) + msgLen(4 BE) + msgXml + corpid
    const msgLen = decrypted.readUInt32BE(16);
    if (msgLen < 1 || msgLen > decrypted.length - 20) {
      throw new Error(`Invalid message length in decrypted payload: ${msgLen}`);
    }

    const msgXml = decrypted.subarray(20, 20 + msgLen).toString('utf-8');

    // (Optional) Validate corpid suffix — the remaining bytes should match the configured corpid
    const suffix = decrypted.subarray(20 + msgLen).toString('utf-8');
    if (suffix !== this.config.corpid) {
      log.warn('WeCom decrypted payload corpid mismatch', { expected: this.config.corpid, got: suffix });
    }

    log.info('WeCom AES-256-CBC decryption succeeded');
    return msgXml;
  }

  /**
   * Verify the callback URL verification challenge (echostr) from WeCom.
   *
   * Called when WeCom sends a GET /webhook/wecom?msg_signature=&timestamp=&nonce=&echostr=
   * during URL configuration in the WeCom admin console.
   *
   * Steps per official protocol:
   *   1. Verify SHA1 signature
   *   2. Decrypt echostr using AES-256-CBC (if encodingAESKey is configured)
   *   3. Return the decrypted plaintext challenge
   */
  verifyEchoStr(msgSignature: string, timestamp: string, nonce: string, echostr: string): string {
    // Step 1: Verify SHA1 signature
    const valid = this.verifySignature(msgSignature, timestamp, nonce, echostr);
    if (!valid) {
      throw new Error(
        `WeCom callback URL verification FAILED — signature mismatch. ` +
        `This usually means the token configured in WeCom admin console doesn't match. ` +
        `Check your WeCom app callback settings.`
      );
    }

    // Step 2: Decrypt echostr if encryption is enabled
    if (this.config.encodingAESKey) {
      const decrypted = this.decrypt(echostr);
      // The decrypted result for URL verification should be the plaintext challenge string,
      // not XML. It follows the same format: random(16)+len(4)+plaintext+corpid
      log.info('WeCom callback URL verified successfully (SHA1 + AES-256-CBC)');
      return decrypted;
    }

    // No encryption — return raw echostr (URL-only verification, no message content)
    log.info('WeCom callback URL verified successfully (SHA1, no encryption)');
    return echostr;
  }
}
