import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createLogger, msgId, type Message } from '@markus/shared';
import type {
  CommAdapter,
  CommAdapterConfig,
  InboundAction,
  InboundActionHandler,
  IncomingMessageHandler,
  SendCard,
  SendOptions,
} from '../adapter.js';
import { SlackClient, type SlackClientConfig, type SlackEventEnvelope, type SlackEvent } from './client.js';
import {
  SlackSocketMode,
  type SlackEnvelope,
  type SlackSocketRestTransport,
  type SlackSocketTransport,
} from './socket.js';
import { activeInboundMode, getManifest, type PlatformCapabilities } from '../platforms/registry.js';
import { renderMarkdown } from '../render/markdown.js';

const log = createLogger('slack-adapter');

/** Narrow an unknown to a record, or undefined — for reading raw platform payloads. */
function attemptRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

/**
 * Build a Block Kit payload from the gateway's platform-neutral card content
 * (slice T2). Slack renders rich cards as blocks; each action button carries its
 * signed `ref` as the button `value`, so a tap reaches the inbound action port
 * and completes the approval — the same loop Feishu's interactive card drives.
 */
function buildNotificationBlocks(card: SendCard): { blocks: unknown[]; text: string } {
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: card.title, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: card.body } },
  ];

  // Origin as a context block (Slack's own "extension" slot for metadata), so a
  // notification in a shared channel says which agent — and which team — sent it.
  const originText = slackOriginText(card.origin);
  if (originText) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: originText }] });
  }

  const actions = (card.actions ?? []).filter((a) => a.ref);
  if (actions.length > 0) {
    blocks.push({
      type: 'actions',
      elements: actions.map((a) => ({
        type: 'button',
        text: { type: 'plain_text', text: a.label, emoji: true },
        action_id: a.id,
        // The signed, opaque ref — verified inbound; never the raw approval id.
        value: a.ref,
        ...(a.style ? { style: a.style } : {}),
      })),
    });
  }

  return { blocks, text: `${card.title}\n${card.body}` };
}

/** `来自 X · 团队 Y`, or `来自 X`, or nothing when no agent is known. */
function slackOriginText(origin?: { agentName?: string; teamName?: string }): string | undefined {
  const name = origin?.agentName?.trim();
  if (!name) return undefined;
  // Slack mrkdwn: escape the characters Slack treats as syntax so a name
  // containing `&`, `<` or `>` cannot inject a mention/link into the message.
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const team = origin?.teamName?.trim();
  return team ? `来自 ${esc(name)} · 团队 ${esc(team)}` : `来自 ${esc(name)}`;
}

export interface SlackAdapterConfig extends CommAdapterConfig {
  platform: 'slack';
  // Slack Bot Token (starts with xoxb-)
  botToken: string;
  // Slack App Token (starts with xapp-) — required for Socket Mode
  appToken?: string;
  // Signing Secret for verifying requests
  signingSecret: string;
  // Webhook server port
  webhookPort?: number;
  // Webhook URL path (default: /webhook/slack)
  webhookPath?: string;
  // Optional: Custom API endpoint
  apiUrl?: string;
  // Socket Mode: dial Slack over a WebSocket instead of exposing a webhook.
  // Needs no public URL.
  socketMode?: boolean;
}

/** Injectable wire, so Socket Mode is testable without a Slack app. */
export interface SlackAdapterDeps {
  rest?: SlackSocketRestTransport;
  socket?: SlackSocketTransport;
  /**
   * Slack's capability table. Defaults to the manifest's — the adapter reads
   * *this* to decide socket-vs-webhook and the ACK window, so the platform's
   * transport policy has exactly one author (the registry), never a second
   * hard-coded copy here.
   */
  capabilities?: PlatformCapabilities;
}

interface SlackWebhookRequest {
  type: string;
  token?: string;
  challenge?: string;
  team_id?: string;
  event?: SlackEvent;
}

export class SlackAdapter implements CommAdapter {
  readonly platform = 'slack';
  private config?: SlackAdapterConfig;
  private client?: SlackClient;
  private handlers: IncomingMessageHandler[] = [];
  /**
   * Action port (design §6.5). A Block Kit button tap is a HITL state transition,
   * not a conversation, so it is handed to the registered action handler rather
   * than faked into a `Message`. This is what makes a card's buttons *tappable*
   * on the inbound side, closing the send-fidelity loop (slice T2).
   */
  private actionHandlers: InboundActionHandler[] = [];
  private server?: ReturnType<typeof createServer>;
  private socketMode?: SlackSocketMode;
  private connected = false;
  // Deduplicate events within a short window
  private processedEvents = new Set<string>();

  constructor(private readonly deps: SlackAdapterDeps = {}) {}

  async connect(config: CommAdapterConfig): Promise<void> {
    this.config = config as SlackAdapterConfig;

    const clientConfig: SlackClientConfig = {
      botToken: this.config.botToken,
      appToken: this.config.appToken,
      signingSecret: this.config.signingSecret,
      apiUrl: this.config.apiUrl,
      socketMode: this.config.socketMode,
    };

    this.client = new SlackClient(clientConfig);

    // Test connection by fetching auth.test
    try {
      await this.callAPI('auth.test', {});
      log.info('Slack bot authenticated successfully');
    } catch (error) {
      log.error('Slack authentication failed:', { error });
      throw error;
    }

    // Inbound is one of two paths, chosen from the capability table — not from
    // a bare `config.socketMode` read in here. Socket Mode dials Slack (no
    // public URL); the webhook path binds a local server the platform must be
    // able to reach.
    const capabilities = this.deps.capabilities ?? getManifest(this.platform)?.capabilities;
    const inboundMode = activeInboundMode(capabilities, this.config as unknown as Record<string, unknown>);
    if (inboundMode === 'socket') {
      if (typeof this.config.appToken !== 'string' || !this.config.appToken.trim()) {
        throw new Error('Slack Socket Mode requires an appToken (xapp-)');
      }
      const mode = new SlackSocketMode(
        {
          appToken: this.config.appToken,
          apiUrl: this.config.apiUrl,
          // The ACK window comes from the capability table — one writer.
          ackDeadlineMs: capabilities?.ackDeadlineMs,
        },
        this.deps.rest,
        this.deps.socket,
      );
      await mode.connect((envelope) => this.handleSocketEnvelope(envelope));
      this.socketMode = mode;
    } else if (this.config.webhookPort) {
      await this.setupWebhookServer();
    } else {
      log.warn('No webhookPort configured — Slack adapter will only send messages');
    }

    this.connected = true;
    log.info('Slack adapter connected', {
      mode: inboundMode,
      webhookPort: this.config.webhookPort ?? 'none',
    });
  }

  async disconnect(): Promise<void> {
    if (this.socketMode) {
      this.socketMode.disconnect();
      this.socketMode = undefined;
      log.info('Slack socket stopped');
    }
    if (this.server) {
      this.server.close();
      this.server = undefined;
      log.info('Slack webhook server stopped');
    }
    this.client = undefined;
    this.connected = false;
    log.info('Slack adapter disconnected');
  }

  async sendMessage(channelId: string, content: string, options?: SendOptions): Promise<string> {
    if (!this.config || !this.client) throw new Error('Slack adapter not connected');

    try {
      const slackOptions: Record<string, unknown> = {};
      if (options?.threadId) {
        slackOptions.thread_ts = options.threadId;
      }

      // Slice T2 — the renderer chose a card and handed us platform-neutral
      // content: send a real Block Kit card (header + body + a row of buttons)
      // instead of degrading every notification to plain text.
      if (options?.format === 'card' && options.card) {
        const { blocks, text } = buildNotificationBlocks(options.card);
        const messageId = await this.client.sendBlocksMessage(
          channelId,
          blocks,
          options.markdown ? renderMarkdown(text, 'mrkdwn') : text,
          slackOptions,
        );
        log.info(`Slack notification card sent to channel ${channelId}: ${messageId}`);
        return messageId;
      }

      // Slack speaks mrkdwn, not markdown: `**bold**` would render with literal
      // asterisks. `renderMarkdown` maps the dialect (and escapes `<`/`>` so an
      // agent's prose cannot inject a Slack link or mention).
      const text = options?.markdown ? renderMarkdown(content, 'mrkdwn') : content;
      const messageId = await this.client.sendTextMessage(channelId, text, slackOptions);
      log.info(`Slack message sent to channel ${channelId}: ${messageId}`);
      return messageId;
    } catch (error) {
      log.error(`Failed to send Slack message to ${channelId}:`, { error });
      throw error;
    }
  }

  async sendReply(channelId: string, replyToId: string, content: string, options?: SendOptions): Promise<string> {
    if (!this.config || !this.client) throw new Error('Slack adapter not connected');

    try {
      const slackOptions: Record<string, unknown> = {
        thread_ts: replyToId,
        reply_broadcast: false,
      };
      if (options?.markdown) slackOptions.text = renderMarkdown(content, 'mrkdwn');
      const text = options?.markdown ? (slackOptions.text as string) : content;
      const messageId = await this.client.sendTextMessage(channelId, text, slackOptions);
      log.info(`Slack reply sent to channel ${channelId} (in thread ${replyToId}): ${messageId}`);
      return messageId;
    } catch (error) {
      log.error(`Failed to send Slack reply to ${channelId}:`, { error });
      throw error;
    }
  }

  async sendBlocks(channelId: string, blocks: any[], text?: string, options?: SendOptions): Promise<string> {
    if (!this.config || !this.client) throw new Error('Slack adapter not connected');

    try {
      const slackOptions: Record<string, unknown> = {};
      if (options?.threadId) {
        slackOptions.thread_ts = options.threadId;
      }
      const messageId = await this.client.sendBlocksMessage(channelId, blocks, text, slackOptions);
      log.info(`Slack blocks message sent to channel ${channelId}: ${messageId}`);
      return messageId;
    } catch (error) {
      log.error(`Failed to send Slack blocks message to ${channelId}:`, { error });
      throw error;
    }
  }

  async updateMessage(channelId: string, messageId: string, content: string): Promise<void> {
    if (!this.config || !this.client) throw new Error('Slack adapter not connected');

    try {
      await this.client.updateMessage(channelId, messageId, content, undefined);
      log.info(`Slack message updated in channel ${channelId}: ${messageId}`);
    } catch (error) {
      log.error(`Failed to update Slack message ${messageId} in ${channelId}:`, { error });
      throw error;
    }
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    if (!this.config || !this.client) throw new Error('Slack adapter not connected');

    try {
      await this.client.deleteMessage(channelId, messageId);
      log.info(`Slack message deleted from channel ${channelId}: ${messageId}`);
    } catch (error) {
      log.error(`Failed to delete Slack message ${messageId} from ${channelId}:`, { error });
      throw error;
    }
  }

  onMessage(handler: IncomingMessageHandler): void {
    this.handlers.push(handler);
  }

  /**
   * Action port (design §6.5). A Block Kit button tap arrives as an `interactive`
   * envelope; the adapter normalises it into an {@link InboundAction} so the
   * wiring layer can verify the signed ref and resolve the approval — the same
   * downstream path a Feishu card tap takes.
   */
  onAction(handler: InboundActionHandler): void {
    this.actionHandlers.push(handler);
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ─── Webhook server ─────────────────────────────────────────────────────────

  private async setupWebhookServer(): Promise<void> {
    if (!this.client || !this.config) return;

    const { webhookPort, webhookPath = '/webhook/slack', signingSecret } = this.config;

    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      // Route: GET /webhook/slack → URL verification challenge
      if (req.method === 'GET' && req.url === webhookPath) {
        log.info('Slack webhook GET — URL verification');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Slack webhook endpoint active');
        return;
      }

      // Route: POST /webhook/slack → event dispatch
      if (req.method !== 'POST' || req.url !== webhookPath) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      // Read raw body for signature verification
      const rawBody = await this.readRawBody(req);

      // Verify signature
      const slackSignature = req.headers['x-slack-signature'] as string | undefined;
      const slackTimestamp = req.headers['x-slack-request-timestamp'] as string | undefined;

      if (signingSecret && slackSignature && slackTimestamp) {
        const valid = this.client!.verifySignature(slackSignature, slackTimestamp, rawBody);
        if (!valid) {
          log.warn('Slack webhook signature verification failed');
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }
      } else if (signingSecret) {
        log.warn('Slack webhook missing signature headers — rejecting');
        res.writeHead(401);
        res.end('Unauthorized');
        return;
      }

      let body: SlackWebhookRequest;
      try {
        body = JSON.parse(rawBody) as SlackWebhookRequest;
      } catch {
        res.writeHead(400);
        res.end('Bad Request');
        return;
      }

      // URL verification challenge
      if (body.type === 'url_verification') {
        log.info('Slack webhook URL verification challenge');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(body.challenge ?? '');
        return;
      }

      // Acknowledge immediately (Slack requires < 3s response). De-duplication
      // lives in processEvent so the webhook and Socket Mode paths share exactly
      // one copy of it.
      res.writeHead(200);
      res.end('ok');

      // Process async
      if (body.type === 'event_callback' && body.event) {
        this.processEvent(body.event).catch((err) => {
          log.error('Failed to process Slack event', { error: err.message });
        });
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(webhookPort!, () => {
        log.info(`Slack webhook server listening on port ${webhookPort}`);
        resolve();
      });
      this.server!.on('error', reject);
    });

    log.info(`Slack webhook endpoint: POST http://localhost:${webhookPort}${webhookPath}`);
    log.info('Configure this URL in your Slack App "Event Subscriptions" settings');
  }

  /**
   * Socket Mode delivers Slack's `events_api` envelopes here. The ACK already
   * left on the socket (see `SlackSocketMode`), so this is pure projection:
   * envelope → `Message` → handlers.
   */
  private async handleSocketEnvelope(envelope: SlackEnvelope): Promise<void> {
    const payload = envelope.payload;
    if (!payload || typeof payload !== 'object') return;
    const callback = payload as { type?: string; event?: SlackEvent };
    if (callback.type === 'event_callback' && callback.event) {
      await this.processEvent(callback.event);
      return;
    }
    // `interactive` carries a Block Kit action (button tap) — a HITL transition,
    // routed to the action port rather than the conversation handler (slice T2).
    if (envelope.type === 'interactive') {
      await this.processInteractive(payload as Record<string, unknown>);
      return;
    }
    // slash_commands / other platform-unique payloads remain an unimplemented
    // capability (see capabilities.extra) — nothing to project yet.
    log.debug(`Slack socket envelope '${envelope.type}' carries no channel message`);
  }

  private async processEvent(event: SlackEvent): Promise<void> {
    // Skip bot messages to prevent echo
    if (event.bot_id) return;

    // De-duplicate by event timestamp — the single copy, shared by both inbound
    // paths (Slack redelivers when an ACK is late).
    if (event.ts) {
      if (this.processedEvents.has(event.ts)) {
        log.debug(`Duplicate Slack event ${event.ts}, skipping`);
        return;
      }
      this.processedEvents.add(event.ts);
      if (this.processedEvents.size > 1000) {
        this.processedEvents = new Set([...this.processedEvents].slice(-500));
      }
    }

    // Handle message events (including thread replies)
    if (event.type === 'message' || event.type === 'app_mention') {
      // Determine the text — handle submessage for app_mention
      let text = event.text ?? '';
      const subtype = event.subtype;

      // Skip message_changed, message_deleted, etc.
      if (subtype && !['bot_message', 'thread_broadcast'].includes(subtype)) return;

      // Strip @mention of the bot from text
      if (event.text) {
        text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
      }

      if (!text) return;

      const message: Message = {
        id: msgId(),
        platform: 'slack',
        direction: 'inbound',
        channelId: event.channel ?? '',
        senderId: event.user ?? 'unknown',
        senderName: 'Slack User',
        agentId: '',
        content: { type: 'text', text },
        replyToId: event.thread_ts,
        threadId: event.ts,
        timestamp: new Date().toISOString(),
      };

      for (const handler of this.handlers) {
        try {
          await handler(message);
        } catch (error) {
          log.error('Slack message handler failed', { error });
        }
      }
    }
  }

  /**
   * Normalise a Slack Block Kit action (button tap) into the gateway's action
   * port. The signed ref the card carried in the button `value` is preserved and
   * the actor is the Slack user — the wiring layer verifies the ref and calls
   * `respondToApproval`.
   */
  private async processInteractive(payload: Record<string, unknown>): Promise<void> {
    if (payload['type'] !== 'block_actions') return;

    const actions = Array.isArray(payload['actions'])
      ? (payload['actions'] as Array<Record<string, unknown>>)
      : [];
    const first = actions[0];
    if (!first) return;

    const ref = typeof first['value'] === 'string' ? first['value'] : undefined;
    if (!ref) return;
    const commandId = typeof first['action_id'] === 'string' ? (first['action_id'] as string) : undefined;

    const user = attemptRecord(payload['user']);
    const inbound: InboundAction = {
      platform: this.platform,
      instanceId: this.config?.instanceId ?? this.platform,
      // Normalised shape the wiring reads: a flat string map under `value`
      // (mirrors a Feishu button's `action.value`), so the same verifier applies.
      payload: { value: { ref, ...(commandId ? { action: commandId } : {}) }, raw: payload },
      actorId: typeof user?.['id'] === 'string' ? (user['id'] as string) : undefined,
      timestamp: new Date().toISOString(),
    };

    if (this.actionHandlers.length === 0) {
      log.warn('Slack action received but no action handler is registered — dropping', {
        action: commandId,
      });
      return;
    }
    for (const handler of this.actionHandlers) {
      try {
        await handler(inbound);
      } catch (error) {
        log.error('Slack action handler failed', { error });
      }
    }
  }

  private readRawBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString()));
      req.on('error', reject);
    });
  }

  private async callAPI(endpoint: string, body: Record<string, unknown>): Promise<any> {
    if (!this.client) throw new Error('Slack client not initialized');

    const url = `${this.config?.apiUrl ?? 'https://slack.com/api'}/${endpoint}`;
    const doFetch = this.deps.rest?.fetch ?? fetch;
    const response = await doFetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config?.botToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });

    const result = await response.json() as any;
    if (!result.ok) {
      throw new Error(`Slack API error: ${result.error}`);
    }
    return result;
  }
}
