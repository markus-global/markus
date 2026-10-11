export { FeishuAdapter } from './feishu/adapter.js';
export { FeishuClient } from './feishu/client.js';
export type { ReceiveIdType, FeishuConfig, SendMsgType } from './feishu/client.js';
export { buildStatusCard, buildTaskCard, buildProgressCard, buildAgentResponseCard } from './feishu/cards.js';
export type { AgentCardPhase, ToolCallEntry } from './feishu/cards.js';
export { WhatsAppAdapter } from './whatsapp/adapter.js';
export { WhatsAppClient } from './whatsapp/client.js';
export { SlackAdapter } from './slack/adapter.js';
export { SlackClient } from './slack/client.js';
export { SlackSocketMode } from './slack/socket.js';
export type {
  SlackEnvelope,
  SlackSocketConfig,
  SlackSocketHandler,
  SlackSocketRestTransport,
  SlackSocketTransport,
} from './slack/socket.js';
export { TelegramAdapter } from './telegram/adapter.js';
export { TelegramClient } from './telegram/client.js';
export { MessageRouter } from './router.js';
export type { BotInstanceStatus, ConnectionTestHook } from './router.js';
export { ConnectionTestRegistry } from './gateway/connection-test.js';
export type {
  ConnectionTestLeg,
  ConnectionTestLegState,
  ConnectionTestSnapshot,
  ConnectionTestStatus,
  ConnectionTestSender,
  ConnectionTestTarget,
  ConnectionTestOptions,
} from './gateway/connection-test.js';
export type {
  CommAdapter,
  CommAdapterConfig,
  InboundAction,
  InboundActionHandler,
  SendOptions,
} from './adapter.js';

// Bot instance — a concrete bot on a platform (see platforms/instance.ts).
export type { BotInstance } from './platforms/instance.js';

// Messaging gateway — outbound dispatch + three-level notification routing
// (docs/architecture/messaging-gateway.md §7).
export {
  signActionRef,
  verifyActionRef,
  severityOfNotification,
} from './gateway/outbound.js';
export type {
  ActionRefPayload,
  OutboundAction,
  OutboundAttachment,
  OutboundMessage,
  OutboundOrigin,
  OutboundReplyRef,
  OutboundSeverity,
} from './gateway/outbound.js';
export { resolveNotifyTarget } from './gateway/notify-route.js';
export type { NotifyScope, NotifyTarget, NotifyTargetLookup, ResolvedNotifyTarget } from './gateway/notify-route.js';
export { renderOutbound, renderCapabilitiesOf } from './gateway/render.js';
export type { OutboundFormat, RenderCapabilities, RenderedOutbound } from './gateway/render.js';
// Markdown → platform dialect rendering (one total function; no per-platform
// formatting logic scattered across adapters).
export { renderMarkdown } from './render/markdown.js';
export type { TextDialect } from './render/markdown.js';
export { OutboundDispatcher, notificationToOutbound, taskEventToOutbound } from './gateway/dispatcher.js';
export type {
  DispatchOutcome,
  EventBusLike,
  NotificationLike,
  NotificationSource,
  OutboundDispatcherOptions,
  OutboundSink,
} from './gateway/dispatcher.js';
export { RepoNotifyTargetLookup } from './gateway/notify-lookup.js';
export type { BindingRowLike, InstanceRowLike, RepoNotifyTargetLookupDeps } from './gateway/notify-lookup.js';
export { RouterOutboundSink } from './gateway/router-sink.js';
export type { RouterOutboundSinkDeps } from './gateway/router-sink.js';
// Ack normalisation — one idempotent, deadline-armed handle per inbound event
// (design §6.3, slice G7).
export { createAck, createDeadlineAck } from './gateway/ack.js';
export type { AckHandle } from './gateway/ack.js';

// Messaging gateway: the single inbound resolution point + conversation identity
// (docs/architecture/messaging-gateway.md §6).
export {
  resolveInboundTarget,
  inboundEnvelopeOf,
} from './gateway/inbound.js';
export type {
  BindingLookup,
  InboundEnvelope,
  MatchedScope,
  ResolvedInboundTarget,
  ScopeBinding,
} from './gateway/inbound.js';
export {
  conversationKeyOf,
  isInboundIgnored,
  MAIN_CONVERSATION_KEY,
} from './gateway/conversation-key.js';
export type { ChannelKind, ChannelRef } from './gateway/conversation-key.js';
export { RepoBindingLookup, DEFAULT_INSTANCE_LABEL } from './gateway/repo-binding-lookup.js';
export type {
  ChannelBindingSource,
  PlatformInstanceSource,
  RepoBindingLookupDeps,
} from './gateway/repo-binding-lookup.js';

// Platform manifest registry — single source of truth for the platform set,
// their config fields, capabilities and adapter factories. See
// packages/comms/docs/platform-manifest.md.
export { PLATFORM_MANIFESTS, getManifest, assertUniqueManifestIds, AGENT_BINDING_FIELD, activeInboundMode } from './platforms/registry.js';
export type {
  PlatformManifest,
  PlatformField,
  PlatformFieldType,
  PlatformFieldOption,
  PlatformCapabilities,
  InboundMode,
  OutboundKind,
  PlatformChannel,
  TestConnectionResult,
} from './platforms/registry.js';

// Outbound HTTP seam: every platform client routes through this, so the host can
// install a proxy-aware fetch once at bootstrap (see src/net/http.ts).
export { httpFetch, setHttpFetch, getHttpFetch, classifyFetchFailure } from './net/http.js';
export type { FetchLike, ProbeFailure, ProbeFailureCode } from './net/http.js';

export { DiscordAdapter } from './discord/adapter.js';
export { DiscordClient } from './discord/client.js';

export type { DiscordAdapterConfig } from './discord/adapter.js';

export type {
  DiscordClientConfig,
  DiscordGatewayEvent,
  DiscordGatewayTransport,
  DiscordMessage,
  DiscordMessageHandler,
  DiscordRestTransport,
} from './discord/client.js';
