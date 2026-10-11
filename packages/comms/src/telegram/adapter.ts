import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createLogger, msgId, type Message } from '@markus/shared';
import type { CommAdapter, CommAdapterConfig, IncomingMessageHandler, SendOptions } from '../adapter.js';
import { TelegramClient, type TelegramClientConfig, type TelegramUpdate } from './client.js';
// The inbound transport is declared in the capability table and read through the
// single `activeInboundMode` reader (the same mechanism Feishu/Slack use), so the
// adapter and the registry cannot disagree about how Telegram receives.
import { activeInboundMode, getManifest } from '../platforms/registry.js';
import { renderMarkdown } from '../render/markdown.js';

const log = createLogger('telegram-adapter');

/**
 * Telegram renders a **small HTML subset** (`<b> <i> <s> <u> <code> <pre> <a>`).
 * We convert markdown into *that*, deliberately not into MarkdownV2 — whose
 * mandatory escaping of `. - ! ( )` turns ordinary agent prose into a 400.
 */
function formatForTelegram(
  content: string,
  options?: SendOptions,
): { text: string; parseMode?: 'HTML' } {
  if (!options?.markdown) return { text: content };
  return { text: renderMarkdown(content, 'html'), parseMode: 'HTML' };
}

/** Server-side long-poll window. Kept below the client abort so an empty poll is not a timeout. */
const POLL_TIMEOUT_S = 30;
/** Backoff bounds for a failing poll loop — never a tight spin, never a give-up. */
const POLL_BACKOFF_MIN_MS = 1_000;
const POLL_BACKOFF_MAX_MS = 30_000;

export interface TelegramAdapterConfig extends CommAdapterConfig {
  platform: 'telegram';
  botToken: string;
  webhookPort?: number;
  webhookSecret?: string;
  webhookPath?: string;
  /** Public HTTPS URL Telegram should call. Required for webhook mode. */
  webhookUrl?: string;
  apiUrl?: string;
  pollingEnabled?: boolean;
}

export class TelegramAdapter implements CommAdapter {
  readonly platform = 'telegram';
  private config?: TelegramAdapterConfig;
  private client?: TelegramClient;
  private handlers: IncomingMessageHandler[] = [];
  private server?: ReturnType<typeof createServer>;
  private connected = false;
  /** Aborts the in-flight long poll and parks the loop on `disconnect()`. */
  private pollAbort?: AbortController;
  private pollLoop?: Promise<void>;

  async connect(config: CommAdapterConfig): Promise<void> {
    this.config = config as TelegramAdapterConfig;
    
    // Create Telegram client with the configuration
    const clientConfig: TelegramClientConfig = {
      botToken: this.config.botToken,
      apiUrl: this.config.apiUrl,
      pollingEnabled: this.config.pollingEnabled,
    };
    
    this.client = new TelegramClient(clientConfig);

    // Test connection by getting bot info
    try {
      const botInfo = await this.client.getMe();
      log.info(`Telegram bot connected: @${botInfo.username} (${botInfo.first_name})`);
    } catch (error) {
      log.error('Failed to connect to Telegram:', { error });
      throw error;
    }

    // The inbound transport is read from the capability table, not decided here.
    // Telegram declares `defaultInboundMode: 'polling'` because a desktop install
    // has no public HTTPS URL for Telegram to POST a webhook to, so polling is
    // the only path that works out of the box; an explicit `webhookPort` still
    // opts into the webhook server for tunnelled deployments.
    const capabilities = getManifest(this.platform)?.capabilities;
    const mode = activeInboundMode(capabilities, this.config as unknown as Record<string, unknown>);
    if (mode === 'webhook') {
      await this.setupWebhook();
    } else {
      this.startPolling();
    }

    this.connected = true;
    log.info(`Telegram adapter connected (mode: ${mode})`);
  }

  async disconnect(): Promise<void> {
    // Stop the poll loop first: abort the in-flight request, then await the loop
    // so it cannot deliver a message after we have reported disconnected.
    this.pollAbort?.abort();
    await this.pollLoop?.catch(() => {});
    this.pollAbort = undefined;
    this.pollLoop = undefined;

    // Clean up webhook if it was set up
    if (this.config?.webhookPort && this.server) {
      this.server.close();
      this.server = undefined;
      log.info('Telegram webhook server stopped');
    }

    this.client = undefined;
    this.connected = false;
    log.info('Telegram adapter disconnected');
  }

  /**
   * Long-poll `getUpdates` and feed each update through {@link processUpdate}.
   *
   * This is the inbound leg Telegram actually needed: without it the adapter
   * could only receive via a webhook pointed at a `localhost` URL, which
   * Telegram never calls — so a message to the bot produced nothing at all.
   *
   * `offset = lastUpdateId + 1` is what acknowledges an update to Telegram;
   * without advancing it, every poll would replay the same batch forever.
   */
  private startPolling(): void {
    const controller = new AbortController();
    this.pollAbort = controller;

    const run = async (): Promise<void> => {
      const client = this.client;
      if (!client) return;

      // A webhook registered by an earlier run makes `getUpdates` fail with HTTP
      // 409 Conflict until it is removed. Clearing it is best-effort: a transient
      // failure must not stop the bot from coming up.
      try {
        await client.deleteWebhook();
      } catch (error) {
        log.warn('Could not clear a previously-set Telegram webhook (continuing)', {
          error: String(error),
        });
      }

      let offset: number | undefined;
      let backoff = POLL_BACKOFF_MIN_MS;

      while (!controller.signal.aborted) {
        try {
          const updates = await client.getUpdates(offset, POLL_TIMEOUT_S, controller.signal);
          backoff = POLL_BACKOFF_MIN_MS;
          for (const update of updates) {
            if (typeof update.update_id === 'number') offset = update.update_id + 1;
            await this.processUpdate(update);
          }
        } catch (error) {
          // Aborting on disconnect is the normal exit, not a failure.
          if (controller.signal.aborted) break;
          log.error('Telegram getUpdates failed; retrying', { error: String(error), backoff });
          await new Promise((resolve) => setTimeout(resolve, backoff));
          backoff = Math.min(backoff * 2, POLL_BACKOFF_MAX_MS);
        }
      }
    };

    this.pollLoop = run().catch((error) => {
      if (!controller.signal.aborted) log.error('Telegram poll loop stopped', { error: String(error) });
    });
    log.info('Telegram long polling started');
  }

  async sendMessage(channelId: string, content: string, options?: SendOptions): Promise<string> {
    if (!this.config || !this.client) throw new Error('Telegram adapter not connected');
    const chatId = channelId.startsWith('@') ? channelId : Number(channelId);
    const formatted = formatForTelegram(content, options);

    try {
      const message = await this.client.sendMessage({
        chat_id: chatId,
        text: formatted.text,
        parse_mode: formatted.parseMode,
        disable_notification: false,
      });

      log.info(`Telegram message sent to ${channelId}: ${message.message_id}`);
      return message.message_id.toString();
    } catch (error) {
      // Telegram rejects the *whole* message when entities do not parse. Content
      // outranks formatting, so a formatted send that fails is retried verbatim
      // rather than lost.
      if (formatted.parseMode && (await this.retryPlain(chatId, content))) {
        log.warn('Telegram rejected the formatted message; re-sent as plain text', { channelId });
        return (await this.retryPlainId(chatId, content))!.toString();
      }
      log.error(`Failed to send Telegram message to ${channelId}:`, { error });
      throw error;
    }
  }

  /** Send `content` with no parse mode; returns the message id, or undefined on failure. */
  private async retryPlain(chatId: number | string, content: string): Promise<boolean> {
    return (await this.retryPlainId(chatId, content)) !== undefined;
  }

  private async retryPlainId(chatId: number | string, content: string): Promise<string | undefined> {
    try {
      const message = await this.client!.sendMessage({ chat_id: chatId, text: content });
      return message.message_id.toString();
    } catch {
      return undefined;
    }
  }

  async sendReply(channelId: string, replyToId: string, content: string, options?: SendOptions): Promise<string> {
    if (!this.config || !this.client) throw new Error('Telegram adapter not connected');
    const chatId = channelId.startsWith('@') ? channelId : Number(channelId);
    const replyToMessageId = Number(replyToId);
    const formatted = formatForTelegram(content, options);

    try {
      const message = await this.client.sendMessage({
        chat_id: chatId,
        text: formatted.text,
        parse_mode: formatted.parseMode,
        reply_to_message_id: replyToMessageId,
      });

      log.info(`Telegram reply sent to ${channelId} (in response to ${replyToId}): ${message.message_id}`);
      return message.message_id.toString();
    } catch (error) {
      if (formatted.parseMode) {
        try {
          const message = await this.client.sendMessage({
            chat_id: chatId,
            text: content,
            reply_to_message_id: replyToMessageId,
          });
          log.warn('Telegram rejected the formatted reply; re-sent as plain text', { channelId });
          return message.message_id.toString();
        } catch {
          /* fall through to rethrow the original error */
        }
      }
      log.error(`Failed to send Telegram reply to ${channelId}:`, { error });
      throw error;
    }
  }

  async sendBlocks(channelId: string, blocks: any[], text?: string, options?: SendOptions): Promise<string> {
    if (!this.config || !this.client) throw new Error('Telegram adapter not connected');
    
    try {
      // Telegram doesn't support rich blocks like Slack, so we send text content
      const content = text || this.blocksToText(blocks);
      const chatId = channelId.startsWith('@') ? channelId : Number(channelId);
      
      const message = await this.client.sendMessage({
        chat_id: chatId,
        text: content,
        parse_mode: 'HTML', // Use HTML for basic formatting
      });
      
      log.info(`Telegram blocks message sent to channel ${channelId}: ${message.message_id}`);
      return message.message_id.toString();
    } catch (error) {
      log.error(`Failed to send Telegram blocks message to ${channelId}:`, { error });
      throw error;
    }
  }

  async updateMessage(channelId: string, messageId: string, content: string): Promise<void> {
    if (!this.config || !this.client) throw new Error('Telegram adapter not connected');
    
    try {
      const chatId = channelId.startsWith('@') ? channelId : Number(channelId);
      const msgId = Number(messageId);
      
      // Telegram doesn't have a direct update message API, so we send a new message
      // and optionally delete the old one
      await this.client.sendMessage({
        chat_id: chatId,
        text: `(Updated) ${content}`,
      } as any);
      
      log.info(`Telegram message update simulated for message ${messageId} in channel ${channelId}`);
    } catch (error) {
      log.error(`Failed to update Telegram message ${messageId} in ${channelId}:`, { error });
      throw error;
    }
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    if (!this.config || !this.client) throw new Error('Telegram adapter not connected');
    
    try {
      // Telegram doesn't have a delete message API in this client
      // We'll log it but not actually delete
      log.warn(`Telegram message deletion requested for message ${messageId} in channel ${channelId}, but not implemented`);
    } catch (error) {
      log.error(`Failed to delete Telegram message ${messageId} in ${channelId}:`, { error });
      throw error;
    }
  }

  private blocksToText(blocks: any[]): string {
    // Convert blocks to plain text for Telegram
    let text = '';
    for (const block of blocks) {
      if (block.type === 'section') {
        if (block.text?.text) {
          text += block.text.text + '\n';
        }
      } else if (block.type === 'header') {
        if (block.text?.text) {
          text += `# ${block.text.text}\n`;
        }
      } else if (block.type === 'divider') {
        text += '---\n';
      }
    }
    return text.trim();
  }

  onMessage(handler: IncomingMessageHandler): void {
    this.handlers.push(handler);
  }

  isConnected(): boolean {
    return this.connected;
  }

  private async setupWebhook(): Promise<void> {
    if (!this.config || !this.client) return;

    const { webhookPort, webhookSecret, webhookPath = '/webhook/telegram', webhookUrl } = this.config;

    // A non-positive/absent port means "unset" — `??` alone would keep a stored
    // `0` and then `server.listen(0)` would bind a random port.
    const port = typeof webhookPort === 'number' && webhookPort > 0 ? webhookPort : 9000;

    // Telegram only calls a publicly reachable HTTPS URL. `webhookUrl` is the
    // deployment's real address (e.g. behind a tunnel); the localhost fallback
    // is kept for the local HTTP server but will be rejected by Telegram, so it
    // is logged loudly rather than silently registered as a broken webhook.
    const publicUrl = webhookUrl?.trim() || `http://localhost:${port}${webhookPath}`;
    if (!/^https:\/\//i.test(publicUrl)) {
      log.warn(
        `Telegram webhook URL "${publicUrl}" is not a public HTTPS URL; Telegram will reject it. ` +
          'Set "Public webhook URL" or turn long polling back on.',
      );
    }

    try {
      await this.client.setWebhook(publicUrl, webhookSecret);
      log.info(`Telegram webhook set to ${publicUrl}`);
    } catch (error) {
      log.error('Failed to set Telegram webhook:', { error });
      throw error;
    }

    // The local HTTP server receives the forwarded calls; the public URL is
    // what Telegram is told to use.
    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST' || req.url !== webhookPath) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      // Verify secret token if configured
      if (webhookSecret) {
        const secretHeader = req.headers['x-telegram-bot-api-secret-token'];
        if (secretHeader !== webhookSecret) {
          log.warn('Invalid webhook secret token');
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }
      }

      try {
        // Read request body
        const body = await this.readRequestBody(req);
        const update: TelegramUpdate = JSON.parse(body);

        // Process the update
        await this.processUpdate(update);

        res.writeHead(200);
        res.end('OK');
      } catch (error) {
        log.error('Error processing Telegram webhook:', { error });
        res.writeHead(500);
        res.end('Internal Server Error');
      }
    });

    this.server.listen(webhookPort, () => {
      log.info(`Telegram webhook server listening on port ${webhookPort}`);
    });
  }

  private async processUpdate(update: TelegramUpdate): Promise<void> {
    // Handle different types of updates
    const message = update.message || update.edited_message || update.channel_post || update.edited_channel_post;
    
    if (!message || !message.text) {
      return; // Ignore non-text messages for now
    }

    // Format message for Markus
    const formattedMessage: Message = {
      id: msgId(),
      platform: 'telegram',
      direction: 'inbound',
      channelId: message.chat.id.toString(),
      senderId: message.from?.id.toString() || 'unknown',
      senderName: message.from?.username || message.from?.first_name || 'Unknown User',
      agentId: '', // Will be set by router
      content: {
        type: 'text',
        text: message.text || '',
      },
      timestamp: new Date(message.date * 1000).toISOString(),
    };

    // Call registered handlers
    for (const handler of this.handlers) {
      try {
        await handler(formattedMessage);
      } catch (error) {
        log.error('Error in Telegram message handler:', { error });
      }
    }
  }

  private readRequestBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        resolve(body);
      });
      req.on('error', reject);
    });
  }
}