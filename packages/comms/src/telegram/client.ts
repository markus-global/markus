import { createLogger } from '@markus/shared';
// Route outbound calls through the platform's proxy-aware fetch (../net/http.ts).
import { httpFetch } from '../net/http.js';

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

/**
 * One Telegram `Update`. Lives here rather than in the adapter because it is the
 * transport's wire shape: `getUpdates` returns it and the adapter only consumes
 * it. Keeping one definition is what stops the two from drifting.
 */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
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
    
    const response = await httpFetch(url, {
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
    
    const response = await httpFetch(url);
    
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

  /**
   * Long-poll `getUpdates`.
   *
   * Telegram's Bot API has exactly two inbound transports — webhook and
   * long polling — and they are mutually exclusive: `getUpdates` returns
   * HTTP 409 `Conflict` while a webhook is registered. A desktop install has no
   * public HTTPS URL for Telegram to POST to, so polling is the only inbound
   * path that can work out of the box; the adapter clears any stale webhook
   * before it starts polling (see `TelegramAdapter.startPolling`).
   *
   * `timeout` is the *server-side* long-poll window: the request is held open
   * until an update arrives or the window elapses, which is what makes this a
   * push-like stream instead of a busy loop. It is deliberately a couple of
   * seconds shorter than the client-side abort so a normal empty result is not
   * mistaken for a timeout.
   *
   * `signal` aborts the in-flight request on `disconnect()`.
   */
  async getUpdates(
    offset?: number,
    timeout = 30,
    signal?: AbortSignal,
  ): Promise<TelegramUpdate[]> {
    const url = `${this.baseUrl}/bot${this.config.botToken}/getUpdates`;
    const payload: Record<string, unknown> = {
      timeout,
      allowed_updates: ['message', 'edited_message', 'channel_post', 'edited_channel_post'],
    };
    if (offset !== undefined) payload['offset'] = offset;

    const response = await httpFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      ...(signal ? { signal } : {}),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Telegram API error: ${response.status} - ${error}`);
    }

    const result = (await response.json()) as { ok?: boolean; result?: TelegramUpdate[]; description?: string };
    if (!result.ok) {
      throw new Error(`Telegram API error: ${result.description ?? 'unknown'}`);
    }
    return result.result ?? [];
  }

  async setWebhook(url: string, secretToken?: string): Promise<boolean> {
    const apiUrl = `${this.baseUrl}/bot${this.config.botToken}/setWebhook`;
    
    const body: any = { url };
    if (secretToken) {
      body.secret_token = secretToken;
    }

    const response = await httpFetch(apiUrl, {
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
    
    const response = await httpFetch(url);
    
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