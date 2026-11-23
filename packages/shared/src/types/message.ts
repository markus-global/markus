export type MessageDirection = 'inbound' | 'outbound';
export type MessagePlatform =
  | 'feishu'
  | 'whatsapp'
  | 'slack'
  | 'telegram'
  | 'discord'
  | 'webui'
  | 'internal';

/**
 * Conversation kind inside a bot instance (messaging gateway, design §6.2).
 * `main` is a *designation* (the channel is the agent's home), not a native
 * platform type; adapters report `dm` / `group` / `notification` and the gateway
 * may promote a channel to `main` from its binding.
 */
export type MessageChannelKind = 'main' | 'dm' | 'group' | 'notification';

export interface Message {
  id: string;
  platform: MessagePlatform;
  direction: MessageDirection;
  channelId: string;
  senderId: string;
  senderName: string;
  agentId: string;
  content: MessageContent;
  replyToId?: string;
  threadId?: string;
  timestamp: string;
  /**
   * Bot instance that received this message (design §4). Optional: a platform
   * with a single bot, and every pre-gateway adapter, leave it unset — the
   * gateway then resolves at the platform/global levels.
   */
  instanceId?: string;
  /** Adapter-declared conversation kind; the gateway defaults to `group`. */
  channelKind?: MessageChannelKind;
  /**
   * C10-B2 — the platform's NATIVE message id, surfaced by the adapter at the
   * single inbound dispatch point. This is the delivery envelope's idempotency
   * key (V5): `id` is a fresh random platform item id per dispatch and can never
   * dedupe a redelivered external message. Optional — adapters that have not
   * been envelope-ized leave it unset and the delivery point falls back to `id`
   * (their existing behavior, unchanged).
   */
  nativeMessageId?: string;
}

export interface MessageContent {
  type: 'text' | 'rich_text' | 'file' | 'image' | 'action_card';
  text?: string;
  richText?: RichTextBlock[];
  fileUrl?: string;
  imageUrl?: string;
  actionCard?: ActionCard;
}

export interface RichTextBlock {
  tag: 'text' | 'a' | 'at' | 'code' | 'bold' | 'italic';
  text?: string;
  href?: string;
  userId?: string;
}

export interface ActionCard {
  title: string;
  text: string;
  actions: ActionButton[];
}

export interface ActionButton {
  text: string;
  value: string;
  type: 'primary' | 'default' | 'danger';
}
