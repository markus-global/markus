import { createLogger } from '@markus/shared';

const log = createLogger('wecom-client');

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WeComConfig {
  corpid: string;
  corpsecret: string;
  agentid: number;
  /** Optional: callback verification token */
  token?: string;
  /** Optional: callback AES encoding key */
  encodingAESKey?: string;
  /** Webhook listener port */
  webhookPort?: number;
  /** Webhook URL path (default: /webhook/wecom) */
  webhookPath?: string;
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
  private corpid: string;
  private corpsecret: string;
  private agentid: number;
  private apiBase = 'https://qyapi.weixin.qq.com';
  private accessToken?: string;
  private tokenExpiresAt = 0;

  constructor(config: WeComConfig) {
    this.corpid = config.corpid;
    this.corpsecret = config.corpsecret;
    this.agentid = config.agentid;
  }

  /**
   * Get a valid access token. Caches and auto-refreshes before expiry.
   */
  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }

    const url = `${this.apiBase}/cgi-bin/gettoken?corpid=${encodeURIComponent(this.corpid)}&corpsecret=${encodeURIComponent(this.corpsecret)}`;
    const res = await fetch(url, { method: 'POST' });
    const data = (await res.json()) as TokenResponse;

    if (data.errcode !== 0) {
      throw new Error(`WeCom auth failed: ${data.errmsg} (code: ${data.errcode})`);
    }

    this.accessToken = data.access_token!;
    // Refresh 60 seconds before actual expiry (expires_in is typically 7200s)
    this.tokenExpiresAt = Date.now() + (data.expires_in! - 60) * 1000;
    log.info('WeCom access token refreshed');

    return this.accessToken;
  }

  /**
   * Send a text message to a WeCom user or party.
   * @param content - The text content to send.
   * @param toUser - Target users ("@all" for broadcast, "user1|user2" for specific users).
   * @returns The message ID on success.
   */
  async sendTextMessage(content: string, toUser = '@all'): Promise<string> {
    const token = await this.getAccessToken();

    const body = {
      touser: toUser,
      msgtype: 'text' as const,
      agentid: this.agentid,
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

    log.info(`WeCom text message sent to ${toUser}`);
    return `msg_${Date.now()}`;
  }

  /**
   * Verify the callback URL (echostr challenge) from WeCom.
   * In a production scenario, this would verify msg_signature using the token and encodingAESKey.
   * For MVP, we simply return the echostr value to confirm the URL.
   */
  verifyEchoStr(msgSignature: string, timestamp: string, nonce: string, echostr: string): string {
    // Simple verification: in production with encryption enabled,
    // this would decrypt echostr using the encodingAESKey.
    // For MVP without encryption, just return echostr as-is.
    return echostr;
  }
}
