import { createLogger } from '@markus/shared';

const log = createLogger('telegram-client');

export interface TelegramClientConfig {
  botToken: string;
  apiUrl?: string;
  webhookUrl?: string;
  pollingEnabled?: boolean;
}

export interface TelegramMessage {
  message_id: number;
  chat: {
    id: number;
    type: 'private' | 'group' | 'supergroup' | 'channel';
    title?: string;
    username?: string;
  };
  from?: {
    id: number;
    is_bot: boolean;
    first_name: string;
    last_name?: string;
    username?: string;
  };
  text?: string;
  date: number;
}

export interface SendMessageParams extends Record<string, unknown> {
  chat_id: number | string;
  text: string;
  parse_mode?: 'Markdown' | 'HTML';
  reply_to_message_id?: number;
  disable_notification?: boolean;
}

export class TelegramClient {
  private config: TelegramClientConfig;
  private baseUrl: string;

  constructor(config: TelegramClientConfig) {
    this.config = config;
    this.baseUrl = config.apiUrl || 'https://api.telegram.org';
  }

  async sendMessage(params: SendMessageParams): Promise<TelegramMessage> {
    const url = `${this.baseUrl}/bot${this.config.botToken}/sendMessage`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      const error = await response.text();
      log.error(`Failed to send Telegram message:`, { error });
      throw new Error(`Telegram API error: ${response.status} - ${error}`);
    }

    const result = await response.json() as any;
    
    if (!result.ok) {
      log.error(`Telegram API returned error: ${result.description}`);
      throw new Error(`Telegram API error: ${result.description}`);
    }

    log.info(`Telegram message sent to chat ${params.chat_id}: ${result.result.message_id}`);
    return result.result;
  }

  async getMe(): Promise<any> {
    const url = `${this.baseUrl}/bot${this.config.botToken}/getMe`;
    
    const response = await fetch(url);
    
    if (!response.ok) {
      const error = await response.text();
      log.error(`Failed to get bot info:`, { error });
      throw new Error(`Telegram API error: ${response.status} - ${error}`);
    }

    const result = await response.json() as any;
    
    if (!result.ok) {
      log.error(`Telegram API returned error: ${result.description}`);
      throw new Error(`Telegram API error: ${result.description}`);
    }

    return result.result;
  }

  async setWebhook(url: string, secretToken?: string): Promise<boolean> {
    const apiUrl = `${this.baseUrl}/bot${this.config.botToken}/setWebhook`;
    
    const body: any = { url };
    if (secretToken) {
      body.secret_token = secretToken;
    }

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      log.error(`Failed to set webhook:`, { error });
      throw new Error(`Telegram API error: ${response.status} - ${error}`);
    }

    const result = await response.json() as any;
    
    if (!result.ok) {
      log.error(`Telegram API returned error: ${result.description}`);
      throw new Error(`Telegram API error: ${result.description}`);
    }

    log.info(`Webhook set to ${url}`);
    return result.result;
  }

  async deleteWebhook(): Promise<boolean> {
    const url = `${this.baseUrl}/bot${this.config.botToken}/deleteWebhook`;
    
    const response = await fetch(url);
    
    if (!response.ok) {
      const error = await response.text();
      log.error(`Failed to delete webhook:`, { error });
      throw new Error(`Telegram API error: ${response.status} - ${error}`);
    }

    const result = await response.json() as any;
    
    if (!result.ok) {
      log.error(`Telegram API returned error: ${result.description}`);
      throw new Error(`Telegram API error: ${result.description}`);
    }

    log.info('Webhook deleted');
    return result.result;
  }
}