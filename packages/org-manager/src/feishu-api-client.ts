import { createLogger } from '@markus/shared';

const log = createLogger('feishu-api-client');

/** Minimal HTTP client for the Feishu Open API — used by FeishuNotifier. */
export class FeishuApiClient {
  private token: string | null = null;
  private tokenExpiresAt = 0;
  private appId: string;
  private appSecret: string;
  private domain: string;

  constructor(opts: {
    appId: string;
    appSecret: string;
    domain?: string;
  }) {
    this.appId = opts.appId;
    this.appSecret = opts.appSecret;
    this.domain = opts.domain ?? 'https://open.feishu.cn';
  }

  /** Ensure a valid tenant access token is cached. */
  private async ensureToken(): Promise<string> {
    // 5 min buffer before expiry
    if (this.token && Date.now() < this.tokenExpiresAt - 300_000) {
      return this.token;
    }
    const resp = await fetch(`${this.domain}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Feishu auth failed (${resp.status}): ${text}`);
    }
    const data = (await resp.json()) as { tenant_access_token: string; expire: number };
    this.token = data.tenant_access_token;
    this.tokenExpiresAt = Date.now() + data.expire * 1000;
    log.info('Feishu tenant token refreshed');
    return this.token!;
  }

  /** Send a text message to a Feishu chat by chat_id. */
  async sendText(chatId: string, text: string): Promise<void> {
    const token = await this.ensureToken();
    const body = {
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    };
    const resp = await fetch(
      `${this.domain}/open-apis/im/v1/messages?receive_id_type=chat_id`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Feishu sendText failed (${resp.status}): ${text}`);
    }
  }

  /** Send an interactive card to a Feishu chat by chat_id. */
  async sendCard(chatId: string, card: Record<string, unknown>): Promise<void> {
    const token = await this.ensureToken();
    const body = {
      receive_id: chatId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    };
    const resp = await fetch(
      `${this.domain}/open-apis/im/v1/messages?receive_id_type=chat_id`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Feishu sendCard failed (${resp.status}): ${text}`);
    }
  }

  /** Clear the cached token (e.g. on config update). */
  clearToken(): void {
    this.token = null;
    this.tokenExpiresAt = 0;
  }
}
