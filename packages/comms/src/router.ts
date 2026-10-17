import { createLogger, type Message } from '@markus/shared';
import type {
  CommAdapter,
  CommAdapterConfig,
  CardResolution,
  InboundAction,
  InboundActionHandler,
  SendOptions,
} from './adapter.js';
import {
  inboundEnvelopeOf,
  resolveInboundTarget,
  type BindingLookup,
  type ResolvedInboundTarget,
  type ScopeBinding,
} from './gateway/inbound.js';

const log = createLogger('message-router');

/**
 * The connection-test port. Structural (not the concrete registry) so the router
 * keeps one small dependency and tests can supply a stub.
 *
 * Consulted **before** target resolution: a verification reply is a handshake,
 * not a conversation, and must never reach an agent (it would pollute the
 * agent's session with a message the user did not mean to send it).
 */
export interface ConnectionTestHook {
  /** True when the message was a test reply and has been consumed. */
  noteInbound(message: Message): Promise<boolean>;
}

/**
 * Handle one inbound message for its resolved target.
 *
 * The handler receives the {@link ResolvedInboundTarget} — not a bare agent id —
 * so the conversation identity (`conversationKey`) travels with it and the agent
 * can be put in the right session (design §6.2, fixes D3).
 */
export type AgentMessageHandler = (
  target: ResolvedInboundTarget,
  message: Message,
) => Promise<string | undefined>;

/**
 * Compose lookups so the authoritative source wins and the in-memory bootstrap
 * is only consulted when it has no answer (design §5.2 dual-read).
 */
function compositeLookup(lookups: readonly BindingLookup[]): BindingLookup {
  return {
    bindings: (orgId, platform) => {
      const out: ScopeBinding[] = [];
      for (const lookup of lookups) out.push(...lookup.bindings(orgId, platform));
      return out;
    },
    platformDefaultAgent: (orgId, platform) => {
      for (const lookup of lookups) {
        const agentId = lookup.platformDefaultAgent(orgId, platform);
        if (agentId) return agentId;
      }
      return undefined;
    },
    orgDefaultAgent: (orgId) => {
      for (const lookup of lookups) {
        const agentId = lookup.orgDefaultAgent?.(orgId);
        if (agentId) return agentId;
      }
      return undefined;
    },
  };
}

/** One live bot connection: the adapter plus the instance it belongs to. */
interface RegisteredBot {
  /** Instance id — the connection's identity (`bi_…`, or the platform id for the single implicit bot). */
  instanceId: string;
  /** Manifest id (`feishu`, `telegram`, …). */
  platform: string;
  adapter: CommAdapter;
  /** The config this bot last connected with, so it can be reconnected in place. */
  lastConfig?: CommAdapterConfig;
}

/** A connected bot, as reported by {@link MessageRouter.getInstances}. */
export interface BotInstanceStatus {
  instanceId: string;
  platform: string;
  connected: boolean;
}

export class MessageRouter {
  /**
   * Live bots, keyed by **instance id** — never by platform.
   *
   * Keying by platform was the structural reason "one platform = one bot": the
   * second `registerAdapter` of a platform silently replaced the first. The
   * default instance id is the adapter's platform, so a single-bot platform
   * behaves exactly as before; a second instance of the same platform gets its
   * own slot (docs/architecture/messaging-gateway.md §4.2).
   */
  private bots = new Map<string, RegisteredBot>();
  /**
   * Adapters that already carry this router's message/action handlers.
   *
   * Keyed by adapter identity, not by instance: registering the same adapter
   * object twice must not wire it twice, or the append-semantics of
   * `onMessage` bring the duplicate delivery straight back.
   */
  private wiredAdapters = new WeakSet<CommAdapter>();
  /** Explicit per-channel bindings: `${platform}:${channelId}` → agentId. */
  private agentChannelMap = new Map<string, string>();
  /** Platform-level default binding: platform → agentId. */
  private platformAgentMap = new Map<string, string>();
  private agentHandler?: AgentMessageHandler;
  /**
   * The single action handler (design §6.5). Platform *actions* — card-button
   * taps — are not conversations, so they take this separate, explicitly wired
   * route instead of being smuggled through {@link agentHandler}.
   */
  private actionHandler?: InboundActionHandler;
  /**
   * Optional connection-test port. Absent means "no verification in flight" —
   * the router then behaves exactly as before, so this is purely additive.
   */
  private connectionTests?: ConnectionTestHook;
  /**
   * The authoritative binding source. In production this is DB-backed (single
   * writer, design §2); the in-memory maps above stay as a `markus.json`
   * read-only **bootstrap** fallback and are consulted only when it has no answer.
   */
  private bindingLookup?: BindingLookup;

  constructor(private readonly orgId: string = 'default') {}

  /**
   * Register a bot adapter. `instanceId` defaults to the adapter's platform — the
   * "one implicit bot per platform" identity every build had before instances
   * existed. Pass a real instance id (`platform_instances.id`) to run several
   * bots of the same platform side by side.
   */
  registerAdapter(adapter: CommAdapter, instanceId: string = adapter.platform): void {
    const bot: RegisteredBot = { instanceId, platform: adapter.platform, adapter };
    this.bots.set(instanceId, bot);
    // Wiring belongs to *registration*, not to connecting. An adapter's
    // `onMessage`/`onAction` **append** (a platform may fan out to several
    // consumers), so wiring on every (re)connect accumulated one extra copy of
    // the router's handler per reconnect — and `processMessageEvent` iterates
    // all of them, so one inbound message was delivered once per reconnect:
    // the "one message, two replies" defect. Register exactly once here; a
    // reconnect then only re-establishes the transport.
    this.wireAdapter(bot);
    log.info(
      instanceId === adapter.platform
        ? `Registered comm adapter: ${adapter.platform}`
        : `Registered comm adapter: ${adapter.platform} (instance ${instanceId})`,
    );
  }

  /** Whether an instance currently holds a registered adapter. */
  hasInstance(instanceId: string): boolean {
    return this.bots.has(instanceId);
  }

  /**
   * Drop one bot: disconnect it and forget it. The mirror of
   * {@link registerAdapter}.
   *
   * Without this the adapter set could only ever grow, so a deleted or disabled
   * bot kept a live connection *and* a stale slot in {@link getInstances} — the
   * same "persisted ≠ live" gap as a bot that never connects, seen from the
   * other side. Idempotent: an unknown instance is a no-op, because "already
   * gone" is the desired end state.
   */
  async unregisterInstance(instanceId: string): Promise<void> {
    const bot = this.bots.get(instanceId);
    if (!bot) return;
    this.bots.delete(instanceId);
    try {
      if (bot.adapter.isConnected()) await bot.adapter.disconnect();
    } catch (error) {
      // The slot is already dropped; a failing disconnect must not resurrect it.
      log.warn(`Failed to disconnect ${bot.platform} adapter while unregistering`, {
        instanceId,
        error: String(error),
      });
    }
    log.info(`Unregistered comm adapter: ${bot.platform} (instance ${instanceId})`);
  }

  /** Every live bot with its platform and connection state — observability. */
  getInstances(): BotInstanceStatus[] {
    return [...this.bots.values()].map((bot) => ({
      instanceId: bot.instanceId,
      platform: bot.platform,
      connected: bot.adapter.isConnected(),
    }));
  }

  /**
   * Bind one agent to one channel. The explicit form — it takes precedence over
   * {@link bindPlatformAgent} and is what a per-chat routing UI would drive.
   */
  bindAgentToChannel(agentId: string, platform: string, channelId: string): void {
    const key = `${platform}:${channelId}`;
    this.agentChannelMap.set(key, agentId);
    log.info(`Bound agent ${agentId} to ${key}`);
  }

  /**
   * Bind a platform's default agent — the fallback for an inbound message whose
   * channel has no explicit binding and that carries no `agentId` itself.
   */
  bindPlatformAgent(agentId: string, platform: string): void {
    this.platformAgentMap.set(platform, agentId);
    log.info(`Bound platform ${platform} to agent ${agentId}`);
  }

  /** Every in-memory bootstrap binding currently in effect. */
  getBindings(): { channels: Record<string, string>; platforms: Record<string, string> } {
    return {
      channels: Object.fromEntries(this.agentChannelMap),
      platforms: Object.fromEntries(this.platformAgentMap),
    };
  }

  /**
   * Inject the authoritative binding source (the DB in production). Once set it
   * is the single writer for resolution; the in-memory bootstrap is only a
   * fallback.
   */
  setBindingLookup(lookup: BindingLookup): void {
    this.bindingLookup = lookup;
  }

  private effectiveLookup(): BindingLookup {
    const bootstrap = this.bootstrapLookup();
    return this.bindingLookup ? compositeLookup([this.bindingLookup, bootstrap]) : bootstrap;
  }

  /**
   * The legacy in-memory maps, exposed through the same port the resolver reads.
   * A legacy `slack:C123` binding has no instance, so it is reported with an
   * empty `instanceId` — which matches an inbound message that carries none.
   */
  private bootstrapLookup(): BindingLookup {
    const channels = this.agentChannelMap;
    const platforms = this.platformAgentMap;
    return {
      bindings: (_orgId, platform) => {
        const out: ScopeBinding[] = [];
        const prefix = `${platform}:`;
        for (const [key, agentId] of channels) {
          if (!key.startsWith(prefix)) continue;
          out.push({
            scope: 'channel',
            instanceId: '',
            nativeId: key.slice(prefix.length),
            kind: null,
            agentId,
          });
        }
        return out;
      },
      platformDefaultAgent: (_orgId, platform) => platforms.get(platform),
    };
  }

  /**
   * The agent that should serve an inbound message, or `undefined` when nothing
   * at all is bound. A thin view over the single resolver — one decision point,
   * never a second implementation.
   */
  resolveInboundAgent(message: Message): string | undefined {
    return resolveInboundTarget(inboundEnvelopeOf(message, this.orgId), this.effectiveLookup())?.agentId;
  }

  setAgentHandler(handler: AgentMessageHandler): void {
    this.agentHandler = handler;
  }

  /**
   * Register the single action handler. Adapters that expose an action port
   * (e.g. Feishu card buttons) forward here; the wiring layer resolves the action
   * (verify the signed ref, then respond to the approval).
   */
  setActionHandler(handler: InboundActionHandler): void {
    this.actionHandler = handler;
  }

  /**
   * Register the connection-test port (Settings → Integrations "Save & test").
   * Wired by the gateway's owner, which is also the only party that can send.
   */
  setConnectionTestRegistry(registry: ConnectionTestHook): void {
    this.connectionTests = registry;
  }

  /** Forward one platform action to the registered action handler, if any. */
  private async dispatchAction(action: InboundAction): Promise<void> {
    if (!this.actionHandler) {
      log.warn('Platform action received but no action handler is registered — dropping', {
        platform: action.platform,
        instanceId: action.instanceId,
      });
      return;
    }
    await this.actionHandler(action);
  }

  /**
   * Rewrite an already-sent interactive card to show the outcome of a tap.
   *
   * Returns `false` when the platform/instance is unknown **or** its adapter
   * cannot edit messages — "no feedback possible" is a normal answer here, never
   * an error, because the decision itself was already recorded elsewhere.
   */
  async updateResolvedCard(
    platform: string,
    instanceId: string | undefined,
    messageId: string,
    resolution: CardResolution,
  ): Promise<boolean> {
    const bot = instanceId ? this.bots.get(instanceId) : this.botForPlatform(platform);
    const update = bot?.adapter.updateResolvedCard;
    if (!bot || !update) return false;
    await update.call(bot.adapter, messageId, resolution);
    return true;
  }

  /**
   * Resolve a platform actor id to a display name, best-effort. Returns `null`
   * when the platform/instance is unknown or its adapter cannot look names up —
   * the caller then renders a live platform reference, which needs no lookup.
   *
   * **No guessing when the platform hosts several bots.** An actor id is scoped to
   * the app that issued it: a Feishu `open_id` is *per app*, and the contact API
   * answers `99992361 open_id cross app` when asked by a different one (observed on
   * a live two-bot org). So `botForPlatform`'s "use the first" is fine for routing
   * (the message is already in hand) but wrong here — it would ask the wrong app and
   * silently degrade to no name. With one bot there is nothing to disambiguate.
   */
  async resolveActorName(
    platform: string,
    instanceId: string | undefined,
    actorId: string,
  ): Promise<string | null> {
    if (!actorId) return null;
    const bot = instanceId ? this.bots.get(instanceId) : this.soleBotForPlatform(platform);
    const resolve = bot?.adapter.resolveActorName;
    if (!bot || !resolve) return null;
    return resolve.call(bot.adapter, actorId);
  }

  /** The platform's only bot — `undefined` when it has none *or several*. */
  private soleBotForPlatform(platform: string): RegisteredBot | undefined {
    const matches = [...this.bots.values()].filter((bot) => bot.platform === platform);
    return matches.length === 1 ? matches[0] : undefined;
  }

  async connectAll(configs: CommAdapterConfig[]): Promise<void> {
    for (const config of configs) {
      const bot = this.botFor(config);
      if (!bot) {
        log.warn(
          `No adapter registered for platform: ${config.platform}${config.instanceId ? ` (instance ${config.instanceId})` : ''}`,
        );
        continue;
      }

      try {
        await this.wireAndConnect(bot, config);
      } catch (error) {
        log.error(`Failed to connect ${config.platform} adapter, skipping`, { error: String(error) });
      }
    }
  }

  async disconnectAll(): Promise<void> {
    for (const bot of this.bots.values()) {
      if (bot.adapter.isConnected()) {
        await bot.adapter.disconnect();
      }
    }
  }

  /**
   * Whether any bot of a platform is currently connected.
   *
   * The gateway is the single owner of connection state (design §6.5); the API
   * server asks here instead of tracking a second copy (slice G6).
   */
  isPlatformConnected(platform: string): boolean {
    for (const bot of this.bots.values()) {
      if (bot.platform === platform && bot.adapter.isConnected()) return true;
    }
    return false;
  }

  /**
   * Connect (or reconnect) **one already-registered** bot with `config`.
   *
   * The runtime counterpart of the startup connect. {@link reconnectPlatform}
   * can only reach bots that were registered at boot, so it can never bring up a
   * bot created later — which is why a newly saved instance used to stay dead
   * until the process restarted. This is what the settings API calls after an
   * instance is created or saved.
   *
   * Returns `false` (never throws) when the instance is unknown or the connect
   * fails; the caller logs and every other bot is unaffected.
   */
  async connectInstance(instanceId: string, config: CommAdapterConfig): Promise<boolean> {
    const bot = this.bots.get(instanceId);
    if (!bot) {
      log.warn(`Cannot connect unknown instance: ${instanceId}`);
      return false;
    }
    try {
      if (bot.adapter.isConnected()) await bot.adapter.disconnect();
      await this.wireAndConnect(bot, config);
      return true;
    } catch (error) {
      log.error(`Failed to connect instance ${instanceId}`, { error: String(error) });
      return false;
    }
  }

  /**
   * Reconnect every bot of a platform, merging `configOverrides` over each bot's
   * last-used config, so a saved Settings change takes effect without a restart
   * (slice G6 — replaces the retired notifier's runtime `updateConfig`). The same
   * message/action wiring is re-applied; a failure is logged and never affects
   * other platforms.
   *
   * Scope is deliberately *registered* bots only: it re-applies a changed
   * platform-level config to bots that already exist. Bringing up a bot that was
   * never registered is {@link connectInstance}'s job.
   */
  async reconnectPlatform(
    platform: string,
    configOverrides: Record<string, unknown>,
  ): Promise<void> {
    for (const bot of this.bots.values()) {
      if (bot.platform !== platform) continue;
      const config = {
        ...(bot.lastConfig ?? { platform }),
        ...configOverrides,
        platform,
        instanceId: bot.instanceId,
      } as CommAdapterConfig;
      try {
        if (bot.adapter.isConnected()) await bot.adapter.disconnect();
        await this.wireAndConnect(bot, config);
      } catch (error) {
        log.error(`Failed to reconnect ${platform} adapter`, { error: String(error) });
      }
    }
  }

  /**
   * Install the router's message/action ports on an adapter — **once**.
   *
   * Registration is the only caller. Keep it idempotent: adapters implement
   * `onMessage`/`onAction` as an append (several consumers may listen), so a
   * second call would silently double every inbound delivery (design §6.3).
   */
  private wireAdapter(bot: RegisteredBot): void {
    if (this.wiredAdapters.has(bot.adapter)) return;
    this.wiredAdapters.add(bot.adapter);
    bot.adapter.onMessage(async (message: Message) => {
      await this.routeIncomingMessage(message, bot);
    });
    // Action port (design §6.5): card taps go to the action handler, never
    // through the conversation path.
    bot.adapter.onAction?.((action: InboundAction) => this.dispatchAction(action));
  }

  /**
   * Bring one registered bot's transport up (or back up) with `config`.
   *
   * Shared by {@link connectAll}, {@link reconnectPlatform} and
   * {@link connectInstance} so the connect sequence cannot drift between the
   * three entry points. It deliberately does **not** wire handlers: those belong
   * to registration (see {@link wireAdapter}), and re-wiring on every connect is
   * what used to duplicate every inbound message.
   */
  private async wireAndConnect(bot: RegisteredBot, config: CommAdapterConfig): Promise<void> {
    await bot.adapter.connect(config);
    bot.lastConfig = config;
  }

  /**
   * Send on a platform's channel. Pass `instanceId` to pick a specific bot when a
   * platform hosts more than one; without it the platform's first bot is used
   * (the only possibility before instances existed).
   */
  async sendToChannel(
    platform: string,
    channelId: string,
    content: string,
    instanceId?: string,
    options?: SendOptions,
  ): Promise<string | undefined> {
    const bot = instanceId ? this.bots.get(instanceId) : this.botForPlatform(platform);
    if (!bot || !bot.adapter.isConnected()) {
      log.warn(
        `Adapter not available for platform: ${platform}${instanceId ? ` (instance ${instanceId})` : ''}`,
      );
      return undefined;
    }
    // Pass options only when present, so a plain send keeps the original
    // two-argument adapter call (no behaviour change for existing callers).
    return options
      ? bot.adapter.sendMessage(channelId, content, options)
      : bot.adapter.sendMessage(channelId, content);
  }

  /**
   * Send as a specific agent. The agent identity is carried through to the
   * adapter instead of being dropped (fixes D7) — a receiver can tell which
   * agent spoke, which is what "send *as* this agent" has to mean once one
   * platform hosts several bots (design §4).
   *
   * Pass `instanceId` to pick a specific bot when a platform hosts more than
   * one; without it the platform's first bot is used (the only possibility
   * before instances existed).
   */
  async sendAsAgent(
    agentId: string,
    platform: string,
    channelId: string,
    content: string,
    instanceId?: string,
  ): Promise<string | undefined> {
    // Instance-aware (G2) *and* identity-preserving (G3 / defect D7): choose the
    // right bot when a platform hosts several, and carry the agent id through to
    // the adapter instead of dropping it.
    const bot = instanceId ? this.bots.get(instanceId) : this.botForPlatform(platform);
    if (!bot || !bot.adapter.isConnected()) {
      log.warn(
        `Adapter not available for platform: ${platform}${instanceId ? ` (instance ${instanceId})` : ''}`,
        { agentId },
      );
      return undefined;
    }
    return bot.adapter.sendMessage(channelId, content, { agentId });
  }

  private async routeIncomingMessage(message: Message, source: RegisteredBot): Promise<void> {
    // ── One invariant, one writer: the receiving bot stamps its own instance id.
    //
    // This is the *only* place `Message.instanceId` is set. It has to be, because
    // the router is the only party that knows which bot's handler fired: the
    // handler is wired per registered bot (`wireAdapter`), so `source` is the
    // receiving connection by construction. Stamping it inside each adapter made
    // this one invariant have one writer *per platform* — Discord lost it until
    // #375, Telegram and WhatsApp until #376, and any new adapter starts out
    // wrong. The assignment (not `??=`) is deliberate: an adapter cannot supply a
    // better answer than the connection that actually received the message, and
    // honouring a stale adapter value would let the two disagree.
    //
    // Stamp **before** the connection-test port and target resolution: a test
    // reply is matched against the instance that is being verified, so it must
    // already carry the id.
    message.instanceId = source.instanceId;

    // Connection tests come first: a verification reply is a handshake, not a
    // conversation, so it is consumed here and never reaches an agent.
    if (this.connectionTests) {
      try {
        if (await this.connectionTests.noteInbound(message)) {
          log.info('Inbound message consumed by a connection test', {
            platform: message.platform,
            channelId: message.channelId,
            instanceId: message.instanceId,
          });
          return;
        }
      } catch (error) {
        // A broken test port must never swallow real traffic — fall through to
        // normal routing, loudly.
        log.error('Connection test port failed; routing the message normally', { error: String(error) });
      }
    }

    const target = resolveInboundTarget(
      inboundEnvelopeOf(message, this.orgId),
      this.effectiveLookup(),
    );

    if (!target) {
      // Not silent: "nothing is bound anywhere" is a configuration gap the
      // operator must be able to see — defect A stayed invisible precisely
      // because this used to be a `debug` line nobody reads.
      log.error('Inbound message dropped — no agent bound at any level and no Secretary', {
        platform: message.platform,
        channelId: message.channelId,
        hint:
          `Bind an agent for platform "${message.platform}" in Settings → Integrations ` +
          '(per-instance, per-channel, or the global default), or create a Secretary agent.',
      });
      return;
    }

    if (target.ignored) {
      log.info('Inbound ignored — a notification channel is outbound-only', {
        platform: message.platform,
        channelId: message.channelId,
        matchedScope: target.matchedScope,
      });
      return;
    }

    if (target.matchedScope === 'global') {
      // Level 5 always resolves by design (§6.1) — but it means the platform was
      // not bound, so say so at warn level rather than routing it silently.
      log.warn('Inbound fell through to the global default (no channel/instance/platform binding)', {
        platform: message.platform,
        channelId: message.channelId,
        agentId: target.agentId,
      });
    }

    message.agentId = target.agentId;

    if (this.agentHandler) {
      try {
        const reply = await this.agentHandler(target, message);
        if (reply) {
          // The agent writes markdown; the receiving adapter renders it into its
          // own dialect (render/markdown.ts). Without this flag the markup was
          // shown literally — the "why do I see **bold**" defect.
          const sendOptions: SendOptions = { markdown: true };
          // Answer through the bot that received the message: with two instances
          // of one platform, "the platform's adapter" is no longer a thing.
          if (message.threadId) {
            await source.adapter.sendReply(message.channelId, message.threadId, reply, sendOptions);
          } else {
            await source.adapter.sendMessage(message.channelId, reply, sendOptions);
          }
        }
      } catch (error) {
        log.error('Agent handler failed', { agentId: target.agentId, error: String(error) });
      }
    }
  }

  /** The registered bot a connect config targets (`instanceId` wins over `platform`). */
  private botFor(config: CommAdapterConfig): RegisteredBot | undefined {
    return this.bots.get(config.instanceId ?? config.platform);
  }

  /**
   * The bot chosen for a platform-level lookup (no instance id). Warns when the
   * choice is ambiguous rather than silently picking one.
   */
  private botForPlatform(platform: string): RegisteredBot | undefined {
    const matches = [...this.bots.values()].filter((bot) => bot.platform === platform);
    if (matches.length > 1) {
      log.warn('Platform hosts several bot instances; using the first — pass an instanceId to disambiguate', {
        platform,
        instances: matches.map((bot) => bot.instanceId).join(', '),
      });
    }
    return matches[0];
  }
}
