/**
 * Platform manifest registry — the single source of truth for "which external
 * communication platforms exist, how they are configured, and how to build
 * their adapter".
 *
 * ── Why this exists (issue #340) ────────────────────────────────────────────
 *
 * The comms layer already ships Telegram / Slack / WhatsApp / Discord adapters
 * that are implemented, exported and unit-tested — but nothing ever
 * instantiated them. The gap was never the adapter; it was every layer above
 * it: runtime registration, config schema, Settings API, Settings UI. Each of
 * those layers used to hard-code a per-platform branch, so adding a platform
 * meant editing five places and hoping none was missed.
 *
 * A manifest collapses that into one record per platform. Everything above the
 * adapter can then iterate `PLATFORM_MANIFESTS` instead of branching, and a new
 * platform becomes a single additive entry. S1/S2 introduced this module with
 * only the platform that was external at the time (feishu); S5 revived Telegram
 * / Slack / WhatsApp / Discord by adding their manifests here, and no consumer
 * code changed — `createAdapter()` returns the existing adapter classes, so
 * declaring a platform is a pure *data* increment.
 *
 * Only platforms a user configures from Settings belong here. The built-in Web
 * UI channel is neither external nor user-configurable — it was briefly a
 * manifest and surfaced as a phantom "Web UI" integration card, which only
 * confused users — so it is deliberately *not* a manifest.
 *
 * See `packages/comms/docs/platform-manifest.md` for the design write-up and the
 * "how to add a platform" walkthrough.
 */

import type { CommAdapter } from '../adapter.js';
import type { NotifyDestinationKind } from '../gateway/notify-route.js';
import { FeishuAdapter } from '../feishu/adapter.js';
import { FeishuClient } from '../feishu/client.js';
import { TelegramAdapter } from '../telegram/adapter.js';
import { SlackAdapter } from '../slack/adapter.js';
import { WhatsAppAdapter } from '../whatsapp/adapter.js';
import { DiscordAdapter } from '../discord/adapter.js';
import { httpFetch, classifyFetchFailure, type ProbeFailureCode } from '../net/http.js';

/**
 * Input widget a settings form should render for a single field.
 *
 * `agent` is a *semantic* type, not a widget: it says "the value is the id of
 * one of this org's agents". The client resolves it to whatever control fits
 * (currently a searchable picker fed by `GET /agents`) — which is why a new
 * platform that binds agents still needs zero UI code.
 */
export type PlatformFieldType = 'text' | 'password' | 'number' | 'boolean' | 'select' | 'agent';

/** One choice for a `select` field. */
export interface PlatformFieldOption {
  value: string;
  label: string;
}

/**
 * One configurable knob of a platform.
 *
 * `secret` marks values that must never be echoed back to a client (the
 * Settings API drops them; the UI renders `type: 'password'`).
 */
export interface PlatformField {
  /** Stable config key, e.g. `appSecret`. */
  key: string;
  /** Human-readable label for the settings form. */
  label: string;
  type: PlatformFieldType;
  /** Whether the platform cannot be configured without this field. */
  required: boolean;
  /** Never round-trip the value to a client. Implies `type: 'password'`. */
  secret?: boolean;
  placeholder?: string;
  /** One-line guidance rendered under the input. */
  help?: string;
  /** Choices for `type: 'select'`. */
  options?: PlatformFieldOption[];  /**
   * `select` accepting a set rather than one choice — the value is a
   * `string[]`. Added for Feishu's notification-priority filter, which is
   * genuinely a set; every other select stays single-valued.
   */
  multiple?: boolean;
  /** Value the settings form starts from when nothing is stored yet. */
  default?: string | number | boolean | string[];
  /**
   * Declares this field as a **notification destination** and its semantic kind.
   *
   * The resolver scans an instance's config for fields carrying this annotation
   * (see `RepoNotifyTargetLookup.instanceDeclaredTarget`) — so "point
   * notifications at a chat / a user" is expressed by *data on the manifest*, not
   * a `if (platform === …)` branch anywhere in the gateway (fixes R5). It is also
   * what makes a destination reachable without any agent binding (fixes R1).
   *
   * The value is the platform-neutral kind (`chat` = channel/group, `user` = a
   * person); the concrete wire receive-id type is derived from it.
   */
  notifyTarget?: NotifyDestinationKind;
}

/** How inbound traffic reaches us. */
export type InboundMode = 'webhook' | 'socket' | 'polling' | 'gateway';

/** What we can put on the wire outbound, richest last. */
export type OutboundKind =
  | 'text'
  | 'markdown'
  | 'rich'
  | 'buttons'
  | 'cards'
  | 'media'
  | 'thread'
  | 'replyRef';

/**
 * What a platform can do on the wire — drives capability-aware UI/behaviour.
 *
 * The two model eras coexist here on purpose. The v1 booleans are already on the
 * Settings API wire and read as booleans by the UI, so they stay. The `G7`
 * additions answer *how*, not just *whether* — and they are **the only place**
 * that knows a platform's transport. Core must never write
 * `if (platform === 'slack')` to decide socket-vs-webhook; it reads this table
 * (see `activeInboundMode`).
 */
export interface PlatformCapabilities {
  /** Can receive messages from the platform. */
  inbound: boolean;
  /** Can send messages to the platform. */
  outbound: boolean;
  /** Supports replying inside a thread. */
  threads: boolean;
  /** Supports interactive cards / rich interactive payloads. */
  cards?: boolean;
  /**
   * Can collect free text *back* from the user (a card input, a form, a modal).
   * Absent ⇒ no. This is what decides whether an approval choice that requires a
   * written reason (打回) may be offered on that platform at all — a button whose
   * reason can never be captured is worse than no button.
   */
  approvalComment?: boolean;

  /** Inbound transports this platform supports. Absent ⇒ unknown (assume webhook). */
  inboundModes?: InboundMode[];
  /**
   * The mode used when the config expresses no explicit preference. Declared
   * only by platforms whose default is *not* webhook (Feishu ships a long
   * connection by default so a desktop install needs no public URL). Absent ⇒
   * fall through to `gateway`, then `webhook`.
   */
  defaultInboundMode?: InboundMode;
  /** True iff every declared inbound mode needs a publicly reachable URL. */
  requiresPublicUrl?: boolean;
  /** Platform-side ACK window for one inbound event, ms (Slack/Discord ≈ 3000). */
  ackDeadlineMs?: number;
  /** Outbound representations this platform can render, richest last. */
  outboundKinds?: OutboundKind[];
  /**
   * Platform-unique abilities that core must never inline. A client that wants
   * to *show* them (e.g. "Block Kit" chips) reads them from here.
   */
  extra?: Record<string, string | number | boolean | string[]>;
}

/**
 * The one reader of the capability table: which inbound mode is live for a
 * platform given its config. Pure, and the reason no caller has to branch on a
 * platform id.
 *
 * Precedence — an explicit opt-in beats the platform's default, and `gateway`
 * (Discord's only mode) is chosen over `webhook` because a platform that
 * declares only `gateway` has no webhook to fall back to:
 *   socket (opt-in) → polling (opt-in) → explicit webhook opt-out → default →
 *   gateway → webhook.
 */
export function activeInboundMode(
  capabilities: PlatformCapabilities | undefined,
  config: Record<string, unknown> = {},
): InboundMode {
  const modes = capabilities?.inboundModes;
  if (!modes || modes.length === 0) return 'webhook';

  const on = (value: unknown): boolean => value === true || value === 'true';
  const off = (value: unknown): boolean => value === false || value === 'false';

  // An explicit choice always beats the declared default, in both directions:
  // `socketMode/wsMode: true` asks for a socket, `wsMode: false` asks for the
  // webhook server (a deployment that *does* have a public URL).
  if (modes.includes('socket') && (on(config.socketMode) || on(config.wsMode))) return 'socket';
  if (modes.includes('webhook') && (off(config.socketMode) || off(config.wsMode))) return 'webhook';
  // Polling is opt-in the same way, in both directions: `pollingEnabled: true`
  // asks for long polling, `pollingEnabled: false` asks for the webhook server.
  // The symmetric `off` branch is what makes turning polling off *mean*
  // something — without it the toggle would be decorative (Telegram's reported
  // bug: the switch existed but changed nothing).
  if (modes.includes('polling') && on(config.pollingEnabled)) return 'polling';
  if (modes.includes('polling') && off(config.pollingEnabled) && modes.includes('webhook')) {
    return 'webhook';
  }

  // The platform's own default — the transport it falls back to when the user
  // expressed nothing. This is the fact that used to live in each adapter
  // (`wsMode === false`, `if (socketMode)`), where it drifted from this table.
  const preferred = capabilities?.defaultInboundMode;
  if (preferred && modes.includes(preferred)) return preferred;

  if (modes.includes('gateway')) return 'gateway';
  if (modes.includes('webhook')) return 'webhook';
  return modes[0]!;
}

/** Result of an optional credential probe. */
export interface TestConnectionResult {
  ok: boolean;
  error?: string;
  /**
   * Machine-readable verdict when the failure is *structural* rather than a
   * platform rejection — currently only `network_unreachable` (no route to the
   * host: blocked network, missing proxy). Consumers switch on it to show a
   * localised, actionable hint instead of a raw errno, which a user cannot tell
   * apart from a bad token.
   */
  code?: ProbeFailureCode;
}

/**
 * Classify a thrown probe error. A transport failure becomes a coded verdict;
 * anything else keeps the platform's own message, because that is the
 * actionable part (`invalid app_secret`, `Unauthorized`, …).
 */
function probeError(error: unknown): TestConnectionResult {
  const network = classifyFetchFailure(error);
  if (network) return { ok: false, error: network.detail, code: network.code };
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

/**
 * One conversation a platform can route: a group chat, a DM, a channel.
 *
 * `id` is the **native** conversation id — the same value that lands in
 * `channel_bindings.native_id` — so a client can take it straight from the
 * picker and send it back to bind an agent to that conversation. The shape is
 * deliberately ours rather than the platform's raw JSON: the settings API must
 * not leak a per-platform response shape into its contract.
 */
export interface PlatformChannel {
  id: string;
  name: string;
  /** Free-form hint (e.g. `group` / `p2p`); mirrors `channel_bindings.kind`. */
  kind?: string;
}

/**
 * Everything the rest of the stack needs to know about one platform.
 *
 * `createAdapter` is a *factory* (never a shared instance) so registration code
 * can build adapters without importing the concrete class.
 */
export interface PlatformManifest {
  /** Stable platform id, e.g. `feishu`. Unique across the registry. */
  id: string;
  /** Human-readable platform name. */
  label: string;
  /** Link to the upstream platform's credential/setup docs. */
  docsUrl?: string;
  fields: PlatformField[];
  capabilities: PlatformCapabilities;
  /**
   * Whether the platform is on out of the box (no credentials required).
   * Absent means "off until the user enables it", i.e. `false`.
   */
  defaultEnabled?: boolean;
  /**
   * Not offered to users in a production build — shown only in development.
   *
   * A platform is marked dev-only while its adapter exists and is unit-tested
   * but has **not** been verified end to end against the live service (no
   * public URL / no real credentials on a desktop install). Offering it to
   * production users would present an integration we cannot honestly claim
   * works.
   *
   * This is a **presentation** gate, not a capability gate: the manifest, the
   * adapter and the API are all unchanged, so a build can be verified in dev
   * and the flag flipped without touching anything else. The one reader is the
   * Settings UI (`visiblePlatformIds`), driven by `import.meta.env.DEV`.
   */
  devOnly?: boolean;
  createAdapter(): CommAdapter;
  testConnection?(config: Record<string, unknown>): Promise<TestConnectionResult>;
  /**
   * List the conversations this platform's credentials can currently reach,
   * for a channel picker. Optional on purpose: a platform that cannot
   * enumerate channels simply omits it, and the Settings API reports
   * "unsupported" instead of inventing an empty list. A call that *throws* is
   * an error the caller must surface as such, never as "no channels".
   */
  listChannels?(config: Record<string, unknown>): Promise<PlatformChannel[]>;
  /**
   * Guidance shown when this platform's API genuinely cannot enumerate the
   * conversations a bot can reach.
   *
   * Declared **only by platforms that leave `listChannels` unimplemented** so
   * the Settings UI can tell the user *what to do* (e.g. "add the bot to a
   * group, then paste the chat id") instead of the bare "unsupported" string.
   *
   * Deliberately *not* a capability flag: enumerability has exactly one source —
   * the presence of `listChannels` (see `canListChannels`) — so this text can
   * never disagree with it. It is additive copy, an i18n key resolved by the
   * client, not a second writer of "can list / cannot list".
   */
  channelEnumerationGuidance?: string;
}

// ─── Manifests ───────────────────────────────────────────────────────────────

/**
 * The platform→agent routing field, shared by every platform with inbound
 * support. Kept here (not inlined per manifest) so the binding capability has a
 * single declaration: the value lands in the platform's `integrations` row
 * `config.agentId`, and startup reads it back to bind the router (see
 * `loadPlatformBindings`). A platform that forgets to spread this field simply
 * cannot be routed — visible, not silent.
 */
export const AGENT_BINDING_FIELD: PlatformField = {
  key: 'agentId',
  label: 'Bound agent',
  type: 'agent',
  required: true,
  help:
    'Agent that answers inbound messages from this platform. The instance is ' +
    'created bound to the org secretary; re-point it here or per channel.',
};

/**
 * The notification **master switch** — one field that turns all outbound
 * forwarding off for an instance, declared the same way for every platform.
 *
 * It is a real manifest field, not a UI-only convenience, so the switch has a
 * single writer (the instance config) and a single enforcement point (the
 * dispatcher's `suppressionReasonFor`, which reads it from the same config the
 * destination comes from). A toggle that merely dimmed the panel would be a
 * second source of truth — the classic "the UI says off, delivery says on".
 *
 * Default `true`: an install that never touched it keeps forwarding exactly as
 * before. Placed before the destination field so the master reads first.
 */
export const NOTIFY_MASTER_FIELD: PlatformField = {
  key: 'notifyEnabled',
  label: 'Notifications',
  type: 'boolean',
  required: false,
  default: true,
  help: 'Deliver this bot’s approvals and notifications to the destination below.',
};

/**
 * Feishu / Lark. Credentials are required; every other field mirrors a value
 * the adapter or the CLI config already reads (`FeishuAdapterConfig`,
 * `FeishuConfigPayload`, `MarkusConfig.integrations.feishu`).
 */
const FEISHU_MANIFEST: PlatformManifest = {
  id: 'feishu',
  label: 'Feishu / Lark',
  docsUrl: 'https://open.feishu.cn/document/home/index',
  fields: [
    {
      key: 'appId',
      label: 'App ID',
      type: 'text',
      required: true,
      placeholder: 'cli_xxxxxxxxxxxxxxxx',
    },
    { key: 'appSecret', label: 'App Secret', type: 'password', required: true, secret: true },
    {
      key: 'domain',
      label: 'API Domain',
      type: 'text',
      required: false,
      default: 'https://open.feishu.cn',
      help: 'Override for Lark (international) — e.g. https://open.larksuite.com.',
    },
    {
      key: 'wsMode',
      label: 'Use long connection',
      type: 'boolean',
      required: false,
      default: true,
      help: 'Receive events over Feishu’s long connection — no public URL needed. Turn off to run a webhook server instead.',
    },
    {
      key: 'webhookPort',
      label: 'Webhook port',
      type: 'number',
      required: false,
      default: 9000,
      help: 'Port for the webhook server when the long connection is off.',
    },
    {
      key: 'encryptKey',
      label: 'Encrypt Key',
      type: 'password',
      required: false,
      secret: true,
      help: 'AES key for decrypting encrypted webhook payloads.',
    },
    {
      key: 'verificationToken',
      label: 'Verification Token',
      type: 'password',
      required: false,
      secret: true,
      help: 'Event-subscription verification token.',
    },
    // Declared notification destination (design §3, "Generic destination
    // declaration"). Annotated with `notifyTarget` so the resolver finds it by
    // scanning the manifest — no platform branch (fixes R5). This is the
    // pre-existing Feishu key (`notifyChatId`), so a config written before this
    // annotation existed keeps resolving — the key-migration guarantee. Optional
    // on purpose: a destination must never gate "connected".
    //
    // A **group** is the only destination: approvals and notifications are posted
    // into a chat the bot was added to, never DM'd to one person. The old
    // `notifyOpenId` ("send to my Feishu") destination is gone — a bot addressing
    // a single person is not a notification channel, and it is the reason a bot
    // with no group silently counted as "configured".
    {
      key: 'notifyChatId',
      label: 'Default chat ID',
      type: 'text',
      required: false,
      notifyTarget: 'chat',
      help: 'Group chat_id that approvals and notifications are delivered to.',
    },
    NOTIFY_MASTER_FIELD,
    // Notification preferences. These existed as config surface before the
    // manifest programme (the pre-manifest Settings API read/wrote them through
    // POST /settings/integrations/feishu) but were missing from the manifest,
    // which is why the manifest-driven POST would have dropped them. Recording
    // them here restores the capability with no new endpoint.
    {
      key: 'notifyOnApproval',
      label: 'Notify on approvals',
      type: 'boolean',
      required: false,
      default: true,
      help: 'Forward approval requests to the chat / open ID above.',
    },
    {
      key: 'notifyOnNotification',
      label: 'Notify on events',
      type: 'boolean',
      required: false,
      default: false,
      help: 'Forward agent and task events to the chat / open ID above.',
    },
    {
      key: 'notifyPriority',
      label: 'Notify priority',
      type: 'select',
      required: false,
      multiple: true,
      default: ['high', 'urgent'],
      options: [
        { value: 'normal', label: 'Normal' },
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
        { value: 'urgent', label: 'Urgent' },
      ],
      help: 'Only forward events at these priorities.',
    },
    AGENT_BINDING_FIELD,
  ],
  capabilities: {
    inbound: true, outbound: true, threads: true, cards: true,
    inboundModes: ['webhook', 'socket'], // wsMode = long connection, no public URL
    // Long connection is Feishu's default receiver (design §6.5): a desktop
    // install has no public URL for Feishu to POST to. `wsMode: false` opts a
    // public-URL deployment into the webhook server instead.
    defaultInboundMode: 'socket',
    requiresPublicUrl: false,
    ackDeadlineMs: 3000, // card callbacks
    outboundKinds: ['text', 'markdown', 'rich', 'buttons', 'cards', 'media', 'thread', 'replyRef'],
    extra: { wsMode: true, cardKit: true, scanToCreateApp: true },
  },
  createAdapter: () => new FeishuAdapter(),
  /**
   * Probe credentials by exchanging them for a tenant access token — the same
   * check the pre-manifest Settings API performed inline. Empty credentials
   * short-circuit without a network call.
   */
  async testConnection(config) {
    const appId = typeof config['appId'] === 'string' ? config['appId'].trim() : '';
    const appSecret = typeof config['appSecret'] === 'string' ? config['appSecret'].trim() : '';
    if (!appId || !appSecret) {
      return { ok: false, error: 'appId and appSecret are required' };
    }
    try {
      const rawDomain = config['domain'];
      const domain = typeof rawDomain === 'string' && rawDomain.trim() ? rawDomain.trim() : undefined;
      const client = new FeishuClient({ appId, appSecret, ...(domain ? { domain } : {}) });
      await client.getTenantToken();
      return { ok: true };
    } catch (error) {
      return probeError(error);
    }
  },
  /**
   * Channels a Feishu bot can serve.
   *
   * `GET /im/v1/chats` returns exactly the groups the app has been added to,
   * which is the same set the gateway can route for — so the list needs no
   * filtering, only mapping. Raw items are mapped here rather than passed
   * through, so the wire contract stays {@link PlatformChannel} and a Feishu API
   * change cannot reach a Settings client. Every listed chat is a `group`
   * (`chat_id`); DMs have no chat to pick, so they are not offered.
   *
   * Missing credentials *throw* — "cannot list" must not be indistinguishable
   * from "no channels exist" (see `PlatformChannel` / `listChannels` notes).
   */
  async listChannels(config) {
    const appId = typeof config['appId'] === 'string' ? config['appId'].trim() : '';
    const appSecret = typeof config['appSecret'] === 'string' ? config['appSecret'].trim() : '';
    if (!appId || !appSecret) {
      throw new Error('appId and appSecret are required to list channels');
    }
    const rawDomain = config['domain'];
    const domain = typeof rawDomain === 'string' && rawDomain.trim() ? rawDomain.trim() : undefined;
    const client = new FeishuClient({ appId, appSecret, ...(domain ? { domain } : {}) });
    const items = await client.getChatList();
    return items
      .map((item) => (item && typeof item === 'object' ? (item as Record<string, unknown>) : {}))
      .map((item) => ({
        id: typeof item['chat_id'] === 'string' ? item['chat_id'] : '',
        name: typeof item['name'] === 'string' ? item['name'] : '',
        kind: 'group',
      }))
      .filter((channel) => channel.id.length > 0);
  },
};

/**
 * Telegram — `TelegramAdapter`. Only the bot token is needed to build the client
 * (`TelegramClient` authenticates with `getMe` on connect); the webhook knobs are
 * the inbound path, and `pollingEnabled` is the no-public-URL alternative.
 */
const TELEGRAM_MANIFEST: PlatformManifest = {
  id: 'telegram',
  label: 'Telegram',
  docsUrl: 'https://core.telegram.org/bots/api',
  fields: [
    {
      key: 'botToken',
      label: 'Bot Token',
      type: 'password',
      required: true,
      secret: true,
      placeholder: '123456:ABC-DEF…',
      help: 'Token from @BotFather. Verified with getMe when the adapter connects.',
    },
    // Declared notification destinations (design §3). See the Feishu note above:
    // annotated so the resolver finds them without a platform branch (fixes R5).
    {
      key: 'notifyChatId',
      label: 'Notification chat ID',
      type: 'text',
      required: false,
      notifyTarget: 'chat',
      help: 'Telegram chat id (group or channel) that approvals and notifications are delivered to.',
    },
    NOTIFY_MASTER_FIELD,
    AGENT_BINDING_FIELD,
    {
      key: 'apiUrl',
      label: 'API URL',
      type: 'text',
      required: false,
      placeholder: 'https://api.telegram.org',
      help: 'Override for a self-hosted Bot API server.',
    },
    {
      key: 'pollingEnabled',
      label: 'Long polling',
      type: 'boolean',
      required: false,
      default: true,
      help: 'Receive updates by long polling (no public URL needed). Turn off to use the webhook server below instead.',
    },
    {
      key: 'webhookUrl',
      label: 'Public webhook URL',
      type: 'text',
      required: false,
      placeholder: 'https://example.com/webhook/telegram',
      help: 'Telegram requires a public HTTPS URL to call. Only needed when long polling is off.',
    },
    {
      key: 'webhookPort',
      label: 'Webhook port',
      type: 'number',
      required: false,
      help: 'Local port for the webhook server. Only used when long polling is off.',
    },
    {
      key: 'webhookSecret',
      label: 'Webhook secret',
      type: 'password',
      required: false,
      secret: true,
      help: 'Sent to Telegram as the webhook secret token and checked on each update.',
    },
    {
      key: 'webhookPath',
      label: 'Webhook path',
      type: 'text',
      required: false,
      default: '/webhook/telegram',
    },
  ],
  capabilities: {
    inbound: true, outbound: true, threads: true, cards: false,
    inboundModes: ['polling', 'webhook'], // long polling needs no public URL
    defaultInboundMode: 'polling', // a desktop install has no public HTTPS URL for a webhook
    requiresPublicUrl: false,
    outboundKinds: ['text', 'markdown', 'buttons'],
    extra: { inlineKeyboards: true },
  },
  createAdapter: () => new TelegramAdapter(),
  /** Probe the bot token with `getMe` — the same call the adapter makes on connect. */
  async testConnection(config) {
    const botToken = typeof config['botToken'] === 'string' ? config['botToken'].trim() : '';
    if (!botToken) return { ok: false, error: 'botToken is required' };
    const rawApi = config['apiUrl'];
    const base =
      typeof rawApi === 'string' && rawApi.trim() ? rawApi.trim().replace(/\/+$/, '') : 'https://api.telegram.org';
    try {
      const res = await httpFetch(`${base}/bot${botToken}/getMe`);
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
      if (!res.ok || body.ok === false) {
        return { ok: false, error: body.description ?? `HTTP ${res.status}` };
      }
      return { ok: true };
    } catch (error) {
      return probeError(error);
    }
  },
  // Telegram's Bot API cannot list the groups a bot belongs to (no
  // `getChats`-style call exists), so there is nothing to enumerate — this is
  // how the user finds the id instead.
  channelEnumerationGuidance: 'settings:instances.routing.guidance.telegram',
};

/**
 * Slack — `SlackAdapter`. The bot token authenticates outbound calls
 * (`auth.test`). Inbound is one of two paths: **Socket Mode** (`socketMode: true`
 * + `appToken`) dials Slack over a WebSocket and needs no public URL; otherwise
 * the webhook path needs a port plus the signing secret the adapter verifies
 * against. `appToken` is deliberately not `required` — marking it required would
 * block a valid webhook-only configuration.
 */
const SLACK_MANIFEST: PlatformManifest = {
  id: 'slack',
  label: 'Slack',
  docsUrl: 'https://api.slack.com/authentication',
  devOnly: true,
  fields: [
    {
      key: 'botToken',
      label: 'Bot Token',
      type: 'password',
      required: true,
      secret: true,
      placeholder: 'xoxb-…',
      help: 'Verified with auth.test when the adapter connects.',
    },
    // Declared notification destinations (design §3). See the Feishu note above.
    {
      key: 'notifyChannelId',
      label: 'Notification channel',
      type: 'text',
      required: false,
      notifyTarget: 'chat',
      help: 'Slack channel id (e.g. C0123456789) that approvals and notifications are delivered to.',
    },
    NOTIFY_MASTER_FIELD,
    AGENT_BINDING_FIELD,
    {
      key: 'signingSecret',
      label: 'Signing Secret',
      type: 'password',
      required: false,
      secret: true,
      help: 'Verifies inbound webhook requests. Required for the webhook inbound path.',
    },
    {
      key: 'appToken',
      label: 'App Token',
      type: 'password',
      required: false,
      secret: true,
      placeholder: 'xapp-…',
      help: 'App-level token (xapp-…) for Socket Mode. Required when Socket Mode is on; needs no public URL.',
    },
    {
      key: 'socketMode',
      label: 'Socket Mode',
      type: 'boolean',
      required: false,
      default: false,
    },
    {
      key: 'webhookPort',
      label: 'Webhook port',
      type: 'number',
      required: false,
      help: 'Local port for the webhook server. Leave blank to disable inbound webhooks.',
    },
    {
      key: 'webhookPath',
      label: 'Webhook path',
      type: 'text',
      required: false,
      default: '/webhook/slack',
    },
    {
      key: 'apiUrl',
      label: 'API URL',
      type: 'text',
      required: false,
      placeholder: 'https://slack.com/api',
    },
  ],
  capabilities: {
    inbound: true, outbound: true, threads: true, cards: true,
    inboundModes: ['socket', 'webhook'], // Socket Mode needs no public URL
    requiresPublicUrl: false,
    ackDeadlineMs: 3000,
    outboundKinds: ['text', 'markdown', 'rich', 'buttons', 'cards', 'media', 'thread', 'replyRef'],
    extra: { blockKit: true, modals: true, shortcuts: true },
  },
  createAdapter: () => new SlackAdapter(),
  /** Probe the bot token with `auth.test` — the same call the adapter makes on connect. */
  async testConnection(config) {
    const botToken = typeof config['botToken'] === 'string' ? config['botToken'].trim() : '';
    if (!botToken) return { ok: false, error: 'botToken is required' };
    const rawApi = config['apiUrl'];
    const base =
      typeof rawApi === 'string' && rawApi.trim() ? rawApi.trim().replace(/\/+$/, '') : 'https://slack.com/api';
    try {
      const res = await httpFetch(`${base}/auth.test`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${botToken}` },
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (body.ok !== true) {
        return { ok: false, error: body.error ?? `HTTP ${res.status}` };
      }
      return { ok: true };
    } catch (error) {
      return probeError(error);
    }
  },
  /**
   * Channels this Slack bot can actually serve.
   *
   * `conversations.list` with `types=public_channel,private_channel` returns
   * every conversation the token is allowed to see, but a bot can only *route*
   * a conversation it is a **member** of (Slack rejects `chat.postMessage` to a
   * channel the app has not joined: `not_in_channel`), so the list is filtered
   * to `is_member === true`. That is exactly "add the bot to the channel, then
   * refresh" — the user flow this picker exists for, and the same set the
   * gateway can deliver to.
   *
   * Raw items are mapped here rather than passed through, so the wire contract
   * stays {@link PlatformChannel} and a Slack API change cannot reach a Settings
   * client. Missing credentials *throw* — "cannot list" must not be
   * indistinguishable from "no channels exist".
   */
  async listChannels(config) {
    const botToken = typeof config['botToken'] === 'string' ? config['botToken'].trim() : '';
    if (!botToken) {
      throw new Error('botToken is required to list channels');
    }
    const rawApi = config['apiUrl'];
    const base =
      typeof rawApi === 'string' && rawApi.trim() ? rawApi.trim().replace(/\/+$/, '') : 'https://slack.com/api';

    const channels: PlatformChannel[] = [];
    let cursor: string | undefined;
    // Slack paginates with an opaque cursor; cap the walk so a misbehaving
    // server can never loop this forever.
    for (let page = 0; page < 20; page += 1) {
      const body: Record<string, unknown> = {
        types: 'public_channel,private_channel',
        exclude_archived: true,
        limit: 200,
      };
      if (cursor) body['cursor'] = cursor;
      const res = await httpFetch(`${base}/conversations.list`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${botToken}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(body),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        channels?: unknown;
        response_metadata?: { next_cursor?: unknown };
      };
      if (payload.ok !== true) {
        throw new Error(`Slack API error: ${payload.error ?? `HTTP ${res.status}`}`);
      }
      const items = Array.isArray(payload.channels) ? payload.channels : [];
      for (const item of items) {
        const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
        if (row['is_member'] !== true) continue;
        const id = typeof row['id'] === 'string' ? row['id'] : '';
        if (!id) continue;
        channels.push({ id, name: typeof row['name'] === 'string' ? row['name'] : '', kind: 'channel' });
      }
      const next = payload.response_metadata?.next_cursor;
      cursor = typeof next === 'string' && next ? next : undefined;
      if (!cursor) break;
    }
    return channels;
  },
};

/**
 * WhatsApp — `WhatsAppAdapter` (Meta Cloud API). `phoneNumberId` + `accessToken`
 * are the client credentials; the webhook fields configure the inbound path and
 * the HMAC verification the adapter performs when `appSecret` is set.
 */
const WHATSAPP_MANIFEST: PlatformManifest = {
  id: 'whatsapp',
  label: 'WhatsApp',
  docsUrl: 'https://developers.facebook.com/docs/whatsapp/cloud-api',
  devOnly: true,
  fields: [
    {
      key: 'phoneNumberId',
      label: 'Phone Number ID',
      type: 'text',
      required: true,
      placeholder: '123456789012345',
      help: 'Meta Cloud API phone number ID used as the sender (the ID, not the phone number).',
    },
    {
      key: 'accessToken',
      label: 'Access Token',
      type: 'password',
      required: true,
      secret: true,
      help: 'Cloud API access token. The API Setup temporary token (~24h) is fine for testing; use a permanent system-user token in production.',
    },
    // Declared notification destination (design §3). WhatsApp addresses a
    // recipient by `wa_id` (a phone number), i.e. a `user` destination.
    {
      key: 'notifyWaId',
      label: 'Notification WhatsApp ID',
      type: 'text',
      required: false,
      notifyTarget: 'user',
      help: 'Recipient wa_id (phone number in international format) for approvals and notifications.',
    },
    NOTIFY_MASTER_FIELD,
    AGENT_BINDING_FIELD,
    {
      key: 'businessAccountId',
      label: 'Business Account ID',
      type: 'text',
      required: false,
    },
    {
      key: 'apiVersion',
      label: 'API version',
      type: 'text',
      required: false,
      default: 'v18.0',
      help: 'Graph API version segment appended to the base URL.',
    },
    {
      key: 'baseUrl',
      label: 'Base URL',
      type: 'text',
      required: false,
      placeholder: 'https://graph.facebook.com',
    },
    {
      key: 'webhookPort',
      label: 'Webhook port',
      type: 'number',
      required: false,
      help: 'Local port for the webhook server. Leave blank to disable inbound webhooks.',
    },
    {
      key: 'webhookPath',
      label: 'Webhook path',
      type: 'text',
      required: false,
      default: '/webhook/whatsapp',
    },
    {
      key: 'webhookVerifyToken',
      label: 'Webhook verify token',
      type: 'password',
      required: false,
      secret: true,
      help: 'Echoed back during Meta’s GET webhook verification handshake.',
    },
    {
      key: 'appSecret',
      label: 'App Secret',
      type: 'password',
      required: false,
      secret: true,
      help: 'Verifies the X-Hub-Signature-256 header on inbound webhooks.',
    },
  ],
  capabilities: {
    inbound: true, outbound: true, threads: true, cards: false,
    inboundModes: ['webhook'], // Cloud API is webhook-only
    requiresPublicUrl: true,
    outboundKinds: ['text', 'media', 'replyRef'],
    extra: { messageTemplates: true },
  },
  createAdapter: () => new WhatsAppAdapter(),
  // No lightweight credential probe: Meta exposes no "me for this token" call
  // that is safe to run for an arbitrary Cloud API token. Reported honestly as
  // unsupported by the Settings API rather than faking success.
  //
  // The Cloud API likewise cannot list the WhatsApp groups a business number is
  // in (groups are a client feature, not a Cloud API resource), so destination
  // setup is manual — this points the user at how.
  channelEnumerationGuidance: 'settings:instances.routing.guidance.whatsapp',
};

/**
 * Discord — `DiscordAdapter` (bot gateway). The bot token drives the gateway
 * connection; `apiUrl` / `gatewayUrl` are overrides for self-hosted or proxy
 * deployments.
 */
const DISCORD_MANIFEST: PlatformManifest = {
  id: 'discord',
  label: 'Discord',
  docsUrl: 'https://discord.com/developers/docs/intro',
  devOnly: true,
  fields: [
    {
      key: 'botToken',
      label: 'Bot Token',
      type: 'password',
      required: true,
      secret: true,
      help: 'Bot token from the Discord developer portal.',
    },
    // Declared notification destinations (design §3). See the Feishu note above.
    {
      key: 'notifyChannelId',
      label: 'Notification channel',
      type: 'text',
      required: false,
      notifyTarget: 'chat',
      help: 'Discord channel id that approvals and notifications are delivered to.',
    },
    NOTIFY_MASTER_FIELD,
    AGENT_BINDING_FIELD,
    {
      key: 'apiUrl',
      label: 'API URL',
      type: 'text',
      required: false,
      placeholder: 'https://discord.com/api/v10',
    },
    {
      key: 'gatewayUrl',
      label: 'Gateway URL',
      type: 'text',
      required: false,
      placeholder: 'wss://gateway.discord.gg',
    },
  ],
  capabilities: {
    inbound: true, outbound: true, threads: true, cards: false,
    inboundModes: ['gateway'], // outbound WebSocket to Discord; no public URL
    requiresPublicUrl: false,
    ackDeadlineMs: 3000, // interactions
    outboundKinds: ['text', 'markdown', 'buttons', 'media', 'thread', 'replyRef'],
    extra: { slashCommands: true, components: true, forumChannels: true },
  },
  createAdapter: () => new DiscordAdapter(),
  /** Probe the bot token with `GET /users/@me` — the identity check REST offers. */
  async testConnection(config) {
    const botToken = typeof config['botToken'] === 'string' ? config['botToken'].trim() : '';
    if (!botToken) return { ok: false, error: 'botToken is required' };
    const rawApi = config['apiUrl'];
    const base =
      typeof rawApi === 'string' && rawApi.trim() ? rawApi.trim().replace(/\/+$/, '') : 'https://discord.com/api/v10';
    try {
      const res = await httpFetch(`${base}/users/@me`, { headers: { Authorization: `Bot ${botToken}` } });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true };
    } catch (error) {
      return probeError(error);
    }
  },
  /**
   * Text channels a Discord bot can post to.
   *
   * A bot's reachable conversations are scoped to the guilds it has joined, so
   * the walk is `GET /users/@me/guilds` (bot's guilds) → `GET
   * /guilds/{id}/channels` (that guild's channels) → keep `type === 0`
   * (`GUILD_TEXT`). Voice/category/forum channels are not destinations a
   * notification can land in, so they are dropped. Channel names are only
   * unique *within* a guild, so the label is prefixed with the guild name —
   * two `#general` chips would otherwise be indistinguishable.
   *
   * Raw items are mapped here rather than passed through, so the wire contract
   * stays {@link PlatformChannel}. Missing credentials *throw* — "cannot list"
   * must not be indistinguishable from "no channels exist".
   */
  async listChannels(config) {
    const botToken = typeof config['botToken'] === 'string' ? config['botToken'].trim() : '';
    if (!botToken) {
      throw new Error('botToken is required to list channels');
    }
    const rawApi = config['apiUrl'];
    const base =
      typeof rawApi === 'string' && rawApi.trim() ? rawApi.trim().replace(/\/+$/, '') : 'https://discord.com/api/v10';
    const get = async (path: string): Promise<unknown> => {
      const res = await httpFetch(`${base}${path}`, { headers: { Authorization: `Bot ${botToken}` } });
      if (!res.ok) throw new Error(`Discord API error: ${res.status}`);
      return res.json();
    };

    const guildsRaw = await get('/users/@me/guilds');
    const guilds = Array.isArray(guildsRaw) ? guildsRaw : [];
    const channels: PlatformChannel[] = [];
    for (const guildItem of guilds) {
      const guild = guildItem && typeof guildItem === 'object' ? (guildItem as Record<string, unknown>) : {};
      const guildId = typeof guild['id'] === 'string' ? guild['id'] : '';
      if (!guildId) continue;
      const guildName = typeof guild['name'] === 'string' ? guild['name'] : guildId;
      const listRaw = await get(`/guilds/${guildId}/channels`);
      const list = Array.isArray(listRaw) ? listRaw : [];
      for (const channelItem of list) {
        const channel = channelItem && typeof channelItem === 'object' ? (channelItem as Record<string, unknown>) : {};
        if (channel['type'] !== 0) continue; // 0 = GUILD_TEXT
        const id = typeof channel['id'] === 'string' ? channel['id'] : '';
        if (!id) continue;
        const name = typeof channel['name'] === 'string' ? channel['name'] : '';
        channels.push({ id, name: `${guildName} / #${name}`, kind: 'channel' });
      }
    }
    return channels;
  },
};

/**
 * The registry. Order is the display order in the Settings UI.
 *
 * Adding a platform is additive: append a manifest (with its fields) here and
 * every manifest-driven layer above the adapter picks it up — no per-platform
 * branch required. Only platforms a user configures from Settings belong here:
 * the built-in Web UI channel is neither external nor user-configurable, so it
 * is deliberately *not* a manifest.
 */
export const PLATFORM_MANIFESTS: readonly PlatformManifest[] = [
  FEISHU_MANIFEST,
  TELEGRAM_MANIFEST,
  SLACK_MANIFEST,
  WHATSAPP_MANIFEST,
  DISCORD_MANIFEST,
];

// ─── Registry helpers ────────────────────────────────────────────────────────

/** Throws if two manifests share an id — a registry must be a bijection. */
export function assertUniqueManifestIds(manifests: readonly PlatformManifest[]): void {
  const seen = new Set<string>();
  for (const manifest of manifests) {
    if (seen.has(manifest.id)) {
      throw new Error(`Duplicate platform manifest id: "${manifest.id}"`);
    }
    seen.add(manifest.id);
  }
}

/** Builds the id → manifest index, validating uniqueness on the way. */
function buildManifestIndex(manifests: readonly PlatformManifest[]): Map<string, PlatformManifest> {
  assertUniqueManifestIds(manifests);
  return new Map(manifests.map((manifest) => [manifest.id, manifest]));
}

/**
 * Validated at module load: importing this module fails loudly if a duplicate
 * id ever slips into `PLATFORM_MANIFESTS`, instead of silently dropping one.
 */
const MANIFEST_INDEX: ReadonlyMap<string, PlatformManifest> = buildManifestIndex(PLATFORM_MANIFESTS);

/** Look up a manifest by platform id; `undefined` when the platform is unknown. */
export function getManifest(id: string): PlatformManifest | undefined {
  return MANIFEST_INDEX.get(id);
}
