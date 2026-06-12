import * as Lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '@markus/shared';

const log = createLogger('feishu-api-client');

/**
 * Feishu API client backed by the official @larksuiteoapi/node-sdk.
 * Uses the SDK's Client for REST API calls and WSClient for long-connection event receiving.
 */
export class FeishuApiClient {
  private client: Lark.Client;
  private wsClient: Lark.WSClient | null = null;
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
    this.client = new Lark.Client({
      appId: opts.appId,
      appSecret: opts.appSecret,
      domain: this.domain,
    });
  }

  /** Get the underlying Lark Client instance. */
  getClient(): Lark.Client {
    return this.client;
  }

  /**
   * Start the long-connection WebSocket client to receive events.
   * Returns the WSClient instance so the caller can stop it later.
   */
  async startWSClient(eventDispatcher: Lark.EventDispatcher): Promise<Lark.WSClient> {
    if (this.wsClient) {
      log.warn('WSClient already running, stopping existing one');
      this.stopWSClient();
    }
    this.wsClient = new Lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: this.domain,
      loggerLevel: Lark.LoggerLevel.debug,
      onReady: () => {
        log.info('Feishu WSClient onReady callback fired — connection is live');
      },
      onError: (err: Error) => {
        log.error('Feishu WSClient onError callback', { error: err.message });
      },
    });
    await this.wsClient.start({ eventDispatcher });
    log.info('Feishu WSClient started (long connection mode)');
    return this.wsClient;
  }

  /** Stop the WebSocket client. */
  stopWSClient(): void {
    // The SDK's WSClient doesn't expose a clean stop(), but we null it out
    // so we can recreate on next start. The GC will close the socket.
    this.wsClient = null;
    log.info('Feishu WSClient stopped');
  }

  /** Send a text message to a Feishu chat by chat_id. */
  async sendText(chatId: string, text: string): Promise<void> {
    try {
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
    } catch (err) {
      log.error('Feishu sendText failed', { chatId, error: String(err) });
      throw err;
    }
  }

  /** Send a text message to a user by open_id (direct/P2P message). */
  async sendTextToUser(openId: string, text: string): Promise<void> {
    try {
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: openId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
    } catch (err) {
      log.error('Feishu sendTextToUser failed', { openId, error: String(err) });
      throw err;
    }
  }

  /** Send an interactive card to a user by open_id (direct/P2P message). Returns message_id if available. */
  async sendCardToUser(openId: string, card: Record<string, unknown>): Promise<string | undefined> {
    try {
      const resp = await this.client.im.v1.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: openId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });
      return (resp?.data?.message_id as string) ?? undefined;
    } catch (err) {
      log.error('Feishu sendCardToUser failed', { openId, error: String(err) });
      throw err;
    }
  }

  /** Send an interactive card to a Feishu chat by chat_id. Returns message_id if available. */
  async sendCard(chatId: string, card: Record<string, unknown>): Promise<string | undefined> {
    try {
      const resp = await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });
      return (resp?.data?.message_id as string) ?? undefined;
    } catch (err) {
      log.error('Feishu sendCard failed', { chatId, error: String(err) });
      throw err;
    }
  }

  /** List groups where the bot is a member. */
  async listBotChats(): Promise<Array<{ chatId: string; name: string; description?: string; avatar?: string; ownerIdType?: string; ownerId?: string }>> {
    const results: Array<{ chatId: string; name: string; description?: string; avatar?: string; ownerIdType?: string; ownerId?: string }> = [];
    let pageToken: string | undefined;
    try {
      do {
        const resp = await this.client.im.v1.chat.list({
          params: { page_size: 50, page_token: pageToken },
        });
        const items = (resp?.data?.items ?? []) as Array<{
          chat_id?: string;
          name?: string;
          description?: string;
          avatar?: string;
          owner_id_type?: string;
          owner_id?: string;
        }>;
        for (const item of items) {
          if (item.chat_id) {
            results.push({
              chatId: item.chat_id,
              name: item.name ?? '',
              description: item.description,
              avatar: item.avatar,
              ownerIdType: item.owner_id_type,
              ownerId: item.owner_id,
            });
          }
        }
        pageToken = resp?.data?.page_token as string | undefined;
      } while (pageToken);
    } catch (err) {
      log.error('Feishu listBotChats failed', { error: String(err) });
      throw err;
    }
    return results;
  }

  /** Verify credentials by fetching a tenant access token. */
  async verifyCredentials(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.domain}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
      });
      const data = (await resp.json()) as { tenant_access_token?: string; code?: number };
      return !!(resp.ok && data.tenant_access_token);
    } catch {
      return false;
    }
  }

  /** Clear internal state (for config updates). */
  clearToken(): void {
    // SDK handles token lifecycle internally; this is a no-op now but kept for API compat.
  }
}
