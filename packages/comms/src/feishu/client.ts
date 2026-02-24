import { createLogger } from '@markus/shared';

const log = createLogger('feishu-client');

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  domain?: string;
}

interface TokenResponse {
  code: number;
  msg: string;
  tenant_access_token?: string;
  expire?: number;
}

interface SendMessageResponse {
  code: number;
  msg: string;
  data?: {
    message_id: string;
  };
}

export class FeishuClient {
  private appId: string;
  private appSecret: string;
  private domain: string;
  private tenantToken?: string;
  private tokenExpiresAt = 0;

  constructor(config: FeishuConfig) {
    this.appId = config.appId;
    this.appSecret = config.appSecret;
    this.domain = config.domain ?? 'https://open.feishu.cn';
  }

  async getTenantToken(): Promise<string> {
    if (this.tenantToken && Date.now() < this.tokenExpiresAt) {
      return this.tenantToken;
    }

    const res = await fetch(`${this.domain}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: this.appId,
        app_secret: this.appSecret,
      }),
    });

    const data = (await res.json()) as TokenResponse;
    if (data.code !== 0) {
      throw new Error(`Feishu auth failed: ${data.msg}`);
    }

    this.tenantToken = data.tenant_access_token!;
    this.tokenExpiresAt = Date.now() + (data.expire! - 300) * 1000;
    log.info('Feishu tenant token refreshed');

    return this.tenantToken;
  }

  async sendTextMessage(chatId: string, text: string): Promise<string> {
    return this.sendMessage(chatId, 'text', JSON.stringify({ text }));
  }

  async sendRichTextMessage(chatId: string, title: string, content: Array<Array<Record<string, unknown>>>): Promise<string> {
    return this.sendMessage(chatId, 'post', JSON.stringify({
      zh_cn: { title, content },
    }));
  }

  async sendInteractiveMessage(chatId: string, card: Record<string, unknown>): Promise<string> {
    return this.sendMessage(chatId, 'interactive', JSON.stringify(card));
  }

  async replyMessage(messageId: string, text: string): Promise<string> {
    const token = await this.getTenantToken();

    const res = await fetch(`${this.domain}/open-apis/im/v1/messages/${messageId}/reply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        msg_type: 'text',
        content: JSON.stringify({ text }),
      }),
    });

    const data = (await res.json()) as SendMessageResponse;
    if (data.code !== 0) {
      throw new Error(`Feishu reply failed: ${data.msg}`);
    }

    return data.data!.message_id;
  }

  async getMessageList(chatId: string, pageSize = 20): Promise<unknown[]> {
    const token = await this.getTenantToken();

    const res = await fetch(
      `${this.domain}/open-apis/im/v1/messages?container_id_type=chat&container_id=${chatId}&page_size=${pageSize}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    const data = (await res.json()) as { code: number; data?: { items?: unknown[] } };
    return data.data?.items ?? [];
  }

  async getChatList(): Promise<unknown[]> {
    const token = await this.getTenantToken();

    const res = await fetch(`${this.domain}/open-apis/im/v1/chats?page_size=50`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const data = (await res.json()) as { code: number; data?: { items?: unknown[] } };
    return data.data?.items ?? [];
  }

  private async sendMessage(receiveIdType: string, msgType: string, content: string): Promise<string> {
    const token = await this.getTenantToken();

    const res = await fetch(`${this.domain}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: receiveIdType,
        msg_type: msgType,
        content,
      }),
    });

    const data = (await res.json()) as SendMessageResponse;
    if (data.code !== 0) {
      throw new Error(`Feishu send failed: ${data.msg}`);
    }

    return data.data!.message_id;
  }
}
